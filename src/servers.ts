/**
 * Dev server process manager.
 *
 * Manages long-running dev servers for workspace projects (Hugo, Vite, etc.).
 * Tracks PIDs and ports, supports optional tunnel exposure via Tailscale.
 * State persists in data/servers.json so we know what's running across restarts.
 */

import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(PROJECT_ROOT, "data");
const STATE_PATH = join(DATA_DIR, "servers.json");

export interface ServerEntry {
  id: number;
  name: string;
  command: string;
  cwd: string;
  port: number;
  pid: number | null;
  tunnelPort: number | null;
  tunnelUrl: string | null;
  startedAt: string;
}

interface ServerState {
  nextId: number;
  servers: ServerEntry[];
}

// In-memory child process references (not serializable)
const processes = new Map<number, ChildProcess>();

// ── Async command helpers ──────────────────────────────────────────────────
// All external commands run in child processes so they never block the Bun
// event loop (which would freeze HTTP/chat handling). Replaces the previous
// synchronous execSync calls (lsof / which / tailscale).

function runCmd(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 0, stdout }));
    child.on("error", () => resolve({ code: -1, stdout }));
  });
}

// Fire-and-forget: run a command we don't need to wait on (best-effort cleanup).
function runCmdDetached(cmd: string, args: string[]): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => {});
  } catch {/* ignore */}
}

// ── State persistence ────────────────────────────────────────────────────

function loadState(): ServerState {
  if (!existsSync(STATE_PATH)) {
    return { nextId: 1, servers: [] };
  }
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { nextId: 1, servers: [] };
  }
}

function saveState(state: ServerState): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Port detection ───────────────────────────────────────────────────────

async function isPortInUse(port: number): Promise<boolean> {
  return (await runCmd("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"])).code === 0;
}

async function findFreePort(startFrom: number): Promise<number> {
  for (let port = startFrom; port < startFrom + 100; port++) {
    if (!(await isPortInUse(port))) return port;
  }
  return startFrom;
}

// ── Tunnel helpers ───────────────────────────────────────────────────────

async function commandExists(cmd: string): Promise<boolean> {
  return (await runCmd("which", [cmd])).code === 0;
}

async function getTailscaleHostname(): Promise<string | null> {
  try {
    const { code, stdout } = await runCmd("tailscale", ["status", "--json"]);
    if (code !== 0) return null;
    const status = JSON.parse(stdout);
    const dns = status.Self?.DNSName;
    if (dns) return dns.replace(/\.$/, "");
  } catch {}
  return null;
}

async function getTailscaleServePorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  const { stdout } = await runCmd("tailscale", ["serve", "status"]);
  for (const line of stdout.split("\n")) {
    const withPort = line.match(/https:\/\/[^:]+:(\d+)/);
    if (withPort) {
      ports.add(parseInt(withPort[1]!, 10));
      continue;
    }
    if (line.match(/^https:\/\/[^\s:]+[\s(]/)) {
      ports.add(443);
    }
  }
  return ports;
}

async function findFreeTunnelPort(): Promise<number> {
  const used = await getTailscaleServePorts();
  const candidates = [9443, 10443, 11443, 12443, 13443, 14443, 15443];
  for (const port of candidates) {
    if (!used.has(port)) return port;
  }
  for (let port = 9444; port < 9500; port++) {
    if (!used.has(port)) return port;
  }
  return 9443;
}

async function setupTailscaleTunnel(localPort: number): Promise<{ httpsPort: number; url: string } | null> {
  if (!(await commandExists("tailscale"))) return null;

  const hostname = await getTailscaleHostname();
  if (!hostname) return null;

  const httpsPort = await findFreeTunnelPort();

  const { code } = await runCmd("tailscale", ["serve", "--bg", "--https", String(httpsPort), `http://localhost:${localPort}`]);
  if (code !== 0) {
    logger.error("Failed to setup Tailscale tunnel", { httpsPort, localPort });
    return null;
  }
  const portSuffix = httpsPort === 443 ? "" : `:${httpsPort}`;
  return { httpsPort, url: `https://${hostname}${portSuffix}` };
}

// Fire-and-forget — tunnel teardown is best-effort and must not block callers.
function removeTailscaleTunnel(httpsPort: number): void {
  runCmdDetached("tailscale", ["serve", "--https", String(httpsPort), "off"]);
}

// ── Available tunnel info ────────────────────────────────────────────────

export interface TunnelInfo {
  name: string;
  available: boolean;
}

export async function getAvailableTunnels(): Promise<TunnelInfo[]> {
  const names = ["tailscale", "ngrok", "cloudflared"];
  const availability = await Promise.all(names.map((n) => commandExists(n)));
  return names.map((name, i) => ({ name, available: availability[i]! }));
}

// ── Server management ────────────────────────────────────────────────────

export interface StartServerOptions {
  name: string;
  command: string;
  cwd: string;
  port?: number;
  tunnel?: boolean;
}

export async function startServer(opts: StartServerOptions): Promise<ServerEntry> {
  const state = loadState();

  // Resolve cwd relative to workspace
  const resolvedCwd = resolve(opts.cwd);

  // Find a free port if not specified
  const port = opts.port ?? (await findFreePort(4000));

  // Replace $PORT placeholder in command
  const command = opts.command.replace(/\$PORT/g, String(port));

  // Start the process
  const child = spawn("bash", ["-c", command], {
    cwd: resolvedCwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.unref();

  const pid = child.pid ?? null;
  if (pid) {
    processes.set(state.nextId, child);
  }

  // Capture output for diagnostics (capped to avoid unbounded memory)
  const MAX_LOG = 50_000;
  let startupOutput = "";

  const appendOutput = (d: Buffer) => {
    if (startupOutput.length < MAX_LOG) {
      startupOutput += d.toString().slice(0, MAX_LOG - startupOutput.length);
    }
  };

  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  // Capture serverId before `entry` is declared to avoid reference error
  const serverId = state.nextId;

  child.on("close", (code) => {
    if (code !== null && code !== 0) {
      logger.warn(`Server "${opts.name}" exited with code ${code}`, { output: startupOutput.slice(0, 500) });
    }
    // Remove from processes map
    processes.delete(serverId);
  });

  // Setup tunnel if requested
  let tunnelPort: number | null = null;
  let tunnelUrl: string | null = null;

  if (opts.tunnel) {
    const tunnel = await setupTailscaleTunnel(port);
    if (tunnel) {
      tunnelPort = tunnel.httpsPort;
      tunnelUrl = tunnel.url;
      logger.info(`Tunnel for "${opts.name}": ${tunnel.url}`);
    }
  }

  const entry: ServerEntry = {
    id: state.nextId,
    name: opts.name,
    command,
    cwd: resolvedCwd,
    port,
    pid,
    tunnelPort,
    tunnelUrl,
    startedAt: new Date().toISOString(),
  };

  state.servers.push(entry);
  state.nextId++;
  saveState(state);

  logger.info(`Server started: "${opts.name}" (PID ${pid}, port ${port})`);
  return entry;
}

export function stopServer(id: number): { stopped: boolean; name?: string } {
  const state = loadState();
  const idx = state.servers.findIndex((s) => s.id === id);
  if (idx === -1) return { stopped: false };

  const entry = state.servers[idx]!;

  // Kill the process
  const child = processes.get(id);
  if (child) {
    child.kill("SIGTERM");
    processes.delete(id);
  } else if (entry.pid && isProcessAlive(entry.pid)) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {}
  }

  // Remove tunnel
  if (entry.tunnelPort) {
    removeTailscaleTunnel(entry.tunnelPort);
  }

  state.servers.splice(idx, 1);
  saveState(state);

  logger.info(`Server stopped: "${entry.name}" (ID ${id})`);
  return { stopped: true, name: entry.name };
}

export function listServers(): ServerEntry[] {
  const state = loadState();

  // Check which servers are still alive
  const alive: ServerEntry[] = [];
  let changed = false;

  for (const entry of state.servers) {
    if (entry.pid && isProcessAlive(entry.pid)) {
      alive.push(entry);
    } else {
      // Process died — clean up tunnel if any
      if (entry.tunnelPort) {
        removeTailscaleTunnel(entry.tunnelPort);
      }
      changed = true;
      logger.info(`Server "${entry.name}" (ID ${entry.id}) no longer running, removed`);
    }
  }

  if (changed) {
    state.servers = alive;
    saveState(state);
  }

  return alive;
}

// ── Cleanup on server shutdown ───────────────────────────────────────────

export function cleanupServers(): void {
  const servers = listServers();
  for (const server of servers) {
    stopServer(server.id);
  }
}
