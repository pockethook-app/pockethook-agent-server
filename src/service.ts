/**
 * System service management for pockethook-agent-server.
 *
 * Supports macOS (launchd), Linux (systemd), and Windows (NSSM).
 * Commands: install, stop, restart, uninstall, status
 *
 * Usage:
 *   bun run service install   — Install and start as system service
 *   bun run service stop      — Stop the service
 *   bun run service restart   — Restart the service
 *   bun run service uninstall — Stop and remove the service
 *   bun run service status    — Show service status
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "./config.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(PROJECT_ROOT, "data");
const META_PATH = join(DATA_DIR, "service.json");
const PLATFORM = process.platform;

// ── Service metadata ─────────────────────────────────────────────────────

interface ServiceMeta {
  platform: string;
  serviceName: string;
  serviceFile?: string;
  tunnelType?: string;
  tunnelPort?: number;
  installedAt: string;
}

function saveMeta(meta: ServiceMeta): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n");
}

function loadMeta(): ServiceMeta | null {
  if (!existsSync(META_PATH)) return null;
  try {
    return JSON.parse(readFileSync(META_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function removeMeta(): void {
  if (existsSync(META_PATH)) unlinkSync(META_PATH);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function cancelled(): never {
  p.cancel("Cancelled.");
  process.exit(0);
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getBunPath(): string {
  try {
    return execSync("which bun", { encoding: "utf-8" }).trim();
  } catch {
    return "bun";
  }
}

function readEnvPort(): number {
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return 3000;
  try {
    const content = readFileSync(envPath, "utf-8");
    const match = content.match(/^PORT=(\d+)/m);
    return match ? parseInt(match[1]!, 10) : 3000;
  } catch {
    return 3000;
  }
}

// ── macOS (launchd) ──────────────────────────────────────────────────────

const LAUNCHD_LABEL = "com.pockethook.agent-server";
const LAUNCHD_PLIST = join(
  process.env.HOME || "~",
  "Library",
  "LaunchAgents",
  `${LAUNCHD_LABEL}.plist`,
);

function getLogDir(): string {
  // Use ~/Library/Logs for macOS (always available, even for external drives)
  // Use DATA_DIR for other platforms
  if (PLATFORM === "darwin") {
    const logDir = join(process.env.HOME || "~", "Library", "Logs", "pockethook-agent-server");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    return logDir;
  }
  return DATA_DIR;
}

function generatePlist(): string {
  const bunPath = getBunPath();
  const indexPath = join(PROJECT_ROOT, "src", "index.ts");
  const logDir = getLogDir();
  const logOut = join(logDir, "service.stdout.log");
  const logErr = join(logDir, "service.stderr.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>run</string>
    <string>--watch</string>
    <string>${indexPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logOut}</string>
  <key>StandardErrorPath</key>
  <string>${logErr}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH}</string>
  </dict>
</dict>
</plist>`;
}

function macInstall(): void {
  writeFileSync(LAUNCHD_PLIST, generatePlist());
  execSync(`launchctl load -w "${LAUNCHD_PLIST}"`, { stdio: "inherit" });
}

function macStop(): void {
  try {
    execSync(`launchctl stop ${LAUNCHD_LABEL}`, { stdio: "inherit" });
  } catch {}
}

function macRestart(): void {
  try {
    execSync(`launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`, { stdio: "inherit" });
  } catch {
    // Fallback: stop + start
    macStop();
    try {
      execSync(`launchctl start ${LAUNCHD_LABEL}`, { stdio: "inherit" });
    } catch {}
  }
}

function macUninstall(): void {
  try {
    execSync(`launchctl unload -w "${LAUNCHD_PLIST}"`, { stdio: "inherit" });
  } catch {}
  if (existsSync(LAUNCHD_PLIST)) unlinkSync(LAUNCHD_PLIST);
}

function macStatus(): string {
  try {
    const output = execSync(`launchctl list ${LAUNCHD_LABEL}`, { encoding: "utf-8" });
    if (output.includes('"PID"')) {
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      return `Running (PID: ${pidMatch?.[1] ?? "unknown"})`;
    }
    return "Stopped (loaded but not running)";
  } catch {
    return "Not installed";
  }
}

// ── Linux (systemd) ──────────────────────────────────────────────────────

const SYSTEMD_NAME = "pockethook-agent-server";
const SYSTEMD_USER_DIR = join(process.env.HOME || "~", ".config", "systemd", "user");
const SYSTEMD_UNIT = join(SYSTEMD_USER_DIR, `${SYSTEMD_NAME}.service`);

function generateSystemdUnit(): string {
  const bunPath = getBunPath();
  const indexPath = join(PROJECT_ROOT, "src", "index.ts");

  return `[Unit]
Description=PocketHook Agent Server
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${bunPath} run --watch ${indexPath}
Restart=always
RestartSec=5
Environment=PATH=${process.env.PATH}

[Install]
WantedBy=default.target
`;
}

function linuxInstall(): void {
  if (!existsSync(SYSTEMD_USER_DIR)) mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  writeFileSync(SYSTEMD_UNIT, generateSystemdUnit());
  execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  execSync(`systemctl --user enable --now ${SYSTEMD_NAME}`, { stdio: "inherit" });
}

function linuxStop(): void {
  try {
    execSync(`systemctl --user stop ${SYSTEMD_NAME}`, { stdio: "inherit" });
  } catch {}
}

function linuxRestart(): void {
  execSync(`systemctl --user restart ${SYSTEMD_NAME}`, { stdio: "inherit" });
}

function linuxUninstall(): void {
  try {
    execSync(`systemctl --user disable --now ${SYSTEMD_NAME}`, { stdio: "inherit" });
  } catch {}
  if (existsSync(SYSTEMD_UNIT)) unlinkSync(SYSTEMD_UNIT);
  try {
    execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  } catch {}
}

function linuxStatus(): string {
  try {
    const output = execSync(`systemctl --user is-active ${SYSTEMD_NAME}`, { encoding: "utf-8" }).trim();
    if (output === "active") {
      try {
        const pid = execSync(`systemctl --user show ${SYSTEMD_NAME} --property=MainPID --value`, { encoding: "utf-8" }).trim();
        return `Running (PID: ${pid})`;
      } catch {
        return "Running";
      }
    }
    return output === "inactive" ? "Stopped" : output;
  } catch {
    return "Not installed";
  }
}

// ── Windows (NSSM) ──────────────────────────────────────────────────────

const NSSM_NAME = "PocketHookAgentServer";

function winInstall(): void {
  if (!commandExists("nssm")) {
    p.log.error("NSSM is required on Windows. Install it from: https://nssm.cc/download");
    p.log.info("Or with: choco install nssm / scoop install nssm");
    process.exit(1);
  }

  const bunPath = getBunPath();
  const indexPath = join(PROJECT_ROOT, "src", "index.ts");
  const logOut = join(DATA_DIR, "service.stdout.log");
  const logErr = join(DATA_DIR, "service.stderr.log");

  execSync(`nssm install ${NSSM_NAME} "${bunPath}" run --watch "${indexPath}"`, { stdio: "inherit" });
  execSync(`nssm set ${NSSM_NAME} AppDirectory "${PROJECT_ROOT}"`, { stdio: "inherit" });
  execSync(`nssm set ${NSSM_NAME} AppStdout "${logOut}"`, { stdio: "inherit" });
  execSync(`nssm set ${NSSM_NAME} AppStderr "${logErr}"`, { stdio: "inherit" });
  execSync(`nssm start ${NSSM_NAME}`, { stdio: "inherit" });
}

function winStop(): void {
  try {
    execSync(`nssm stop ${NSSM_NAME}`, { stdio: "inherit" });
  } catch {}
}

function winRestart(): void {
  execSync(`nssm restart ${NSSM_NAME}`, { stdio: "inherit" });
}

function winUninstall(): void {
  try {
    execSync(`nssm stop ${NSSM_NAME}`, { stdio: "inherit" });
  } catch {}
  try {
    execSync(`nssm remove ${NSSM_NAME} confirm`, { stdio: "inherit" });
  } catch {}
}

function winStatus(): string {
  if (!commandExists("nssm")) return "Not installed (NSSM not found)";
  try {
    const output = execSync(`nssm status ${NSSM_NAME}`, { encoding: "utf-8" }).trim();
    return output.includes("SERVICE_RUNNING") ? "Running" : output.includes("SERVICE_STOPPED") ? "Stopped" : output;
  } catch {
    return "Not installed";
  }
}

// ── Tunnel setup ─────────────────────────────────────────────────────────

interface TunnelConfig {
  type: string;
  port: number;
}

async function setupTunnel(serverPort: number): Promise<TunnelConfig | null> {
  const wantTunnel = await p.confirm({
    message: "Enable HTTPS tunnel? (required for PocketHook app)",
    initialValue: true,
  });
  if (p.isCancel(wantTunnel)) cancelled();
  if (!wantTunnel) return null;

  const tools: { name: string; bin: string }[] = [];
  if (commandExists("tailscale")) tools.push({ name: "Tailscale", bin: "tailscale" });
  if (commandExists("ngrok")) tools.push({ name: "ngrok", bin: "ngrok" });
  if (commandExists("cloudflared")) tools.push({ name: "Cloudflare Tunnel", bin: "cloudflared" });

  if (tools.length === 0) {
    p.log.warn("No tunnel tools found. Install Tailscale, ngrok, or cloudflared.");
    return null;
  }

  let selected: string;
  if (tools.length === 1) {
    selected = tools[0]!.bin;
    p.log.info(`Using ${pc.bold(tools[0]!.name)} (only available)`);
  } else {
    const choice = await p.select({
      message: "Tunnel tool",
      options: tools.map((t) => ({ value: t.bin, label: t.name })),
    });
    if (p.isCancel(choice)) cancelled();
    selected = choice;
  }

  if (selected === "tailscale") {
    // Tailscale serve persists — just configure it
    const portInput = await p.text({
      message: "HTTPS port for Tailscale",
      initialValue: "8443",
      validate: (v) => (isNaN(Number(v)) ? "Must be a number" : undefined),
    });
    if (p.isCancel(portInput)) cancelled();
    const httpsPort = parseInt(portInput, 10);

    try {
      execSync(`tailscale serve --bg --https ${httpsPort} http://localhost:${serverPort}`, { stdio: "pipe" });
      p.log.success(`Tailscale serve configured on port ${httpsPort}`);

      try {
        const output = execSync("tailscale status --json", { encoding: "utf-8" });
        const status = JSON.parse(output);
        const dns = status.Self?.DNSName?.replace(/\.$/, "");
        if (dns) {
          const portSuffix = httpsPort === 443 ? "" : `:${httpsPort}`;
          const url = `https://${dns}${portSuffix}`;
          const cfg = loadConfig();
          console.log("");
          console.log(`  ${pc.bold("Server URL:")}    ${pc.green(url)}`);
          console.log(`  ${pc.bold("Health check:")} ${pc.green(`${url}/health`)}`);
          console.log(`  ${pc.bold("Jobs polling:")} ${pc.green(`${url}/jobs`)}`);
          if (cfg.dashboardEnabled) {
            console.log(`  ${pc.bold("Dashboard:")}    ${pc.green(`${url}/dashboard`)}`);
          }
          console.log("");
        }
      } catch {}

      return { type: "tailscale", port: httpsPort };
    } catch (err) {
      p.log.error(`Failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ngrok and cloudflared need a running process — can't persist as service easily
  // We just inform the user
  p.log.info(`Run ${pc.cyan("bun run tunnel")} separately to start ${selected} tunnel.`);
  p.log.info("Tailscale is recommended for persistent tunnels (no extra process needed).");
  return null;
}

function cleanupTunnel(meta: ServiceMeta): void {
  if (meta.tunnelType === "tailscale" && meta.tunnelPort) {
    try {
      execSync(`tailscale serve --https ${meta.tunnelPort} off`, { stdio: "ignore" });
      p.log.info(`Tailscale serve on port ${meta.tunnelPort} removed.`);
    } catch {}
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

async function install() {
  p.intro(pc.bgGreen(pc.black(" service install ")));

  const existing = loadMeta();
  if (existing) {
    const overwrite = await p.confirm({
      message: "Service already installed. Reinstall?",
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) cancelled();
    // Uninstall first
    doUninstall(existing, true);
  }

  const port = readEnvPort();
  p.log.info(`Server port: ${pc.cyan(String(port))} (from .env)`);

  // Tunnel setup
  const tunnel = await setupTunnel(port);

  const s = p.spinner();
  s.start("Installing service...");

  try {
    if (PLATFORM === "darwin") {
      macInstall();
    } else if (PLATFORM === "linux") {
      linuxInstall();
    } else if (PLATFORM === "win32") {
      winInstall();
    } else {
      s.stop();
      p.log.error(`Unsupported platform: ${PLATFORM}`);
      process.exit(1);
    }

    const serviceName = PLATFORM === "darwin" ? LAUNCHD_LABEL : PLATFORM === "linux" ? SYSTEMD_NAME : NSSM_NAME;
    const serviceFile = PLATFORM === "darwin" ? LAUNCHD_PLIST : PLATFORM === "linux" ? SYSTEMD_UNIT : undefined;

    saveMeta({
      platform: PLATFORM,
      serviceName,
      serviceFile,
      tunnelType: tunnel?.type,
      tunnelPort: tunnel?.port,
      installedAt: new Date().toISOString(),
    });

    s.stop("Service installed and running!");
    p.log.info(`Logs: ${pc.dim(join(getLogDir(), "service.stderr.log"))}`);
    p.outro(pc.green("Done!"));
  } catch (err) {
    s.stop();
    p.log.error(`Install failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

function doStop(meta: ServiceMeta): void {
  if (meta.platform === "darwin") macStop();
  else if (meta.platform === "linux") linuxStop();
  else if (meta.platform === "win32") winStop();
}

function doRestart(meta: ServiceMeta): void {
  if (meta.platform === "darwin") macRestart();
  else if (meta.platform === "linux") linuxRestart();
  else if (meta.platform === "win32") winRestart();
}

function doUninstall(meta: ServiceMeta, quiet = false): void {
  cleanupTunnel(meta);
  if (meta.platform === "darwin") macUninstall();
  else if (meta.platform === "linux") linuxUninstall();
  else if (meta.platform === "win32") winUninstall();
  removeMeta();
  if (!quiet) p.log.success("Service uninstalled.");
}

function doStatus(): string {
  if (PLATFORM === "darwin") return macStatus();
  if (PLATFORM === "linux") return linuxStatus();
  if (PLATFORM === "win32") return winStatus();
  return "Unsupported platform";
}

async function stop() {
  p.intro(pc.bgYellow(pc.black(" service stop ")));
  const meta = loadMeta();
  if (!meta) {
    p.log.error("No service installed. Run: bun run service install");
    process.exit(1);
  }
  doStop(meta);
  p.outro(pc.green("Service stopped."));
}

async function restart() {
  p.intro(pc.bgCyan(pc.black(" service restart ")));
  const meta = loadMeta();
  if (!meta) {
    p.log.error("No service installed. Run: bun run service install");
    process.exit(1);
  }
  doRestart(meta);
  p.outro(pc.green("Service restarted."));
}

async function uninstall() {
  p.intro(pc.bgRed(pc.white(" service uninstall ")));
  const meta = loadMeta();
  if (!meta) {
    p.log.error("No service installed.");
    process.exit(1);
  }

  const confirm = await p.confirm({
    message: "Remove the service and tunnel config?",
    initialValue: false,
  });
  if (p.isCancel(confirm) || !confirm) cancelled();

  doUninstall(meta);
  p.outro(pc.green("Service uninstalled."));
}

async function status() {
  p.intro(pc.bgBlue(pc.white(" service status ")));
  const meta = loadMeta();
  const serviceStatus = doStatus();

  console.log(`  ${pc.bold("Status:")}   ${serviceStatus}`);
  console.log(`  ${pc.bold("Platform:")} ${PLATFORM}`);

  if (meta) {
    console.log(`  ${pc.bold("Service:")}  ${meta.serviceName}`);
    if (meta.tunnelType) {
      console.log(`  ${pc.bold("Tunnel:")}   ${meta.tunnelType} (port ${meta.tunnelPort})`);
    }
    console.log(`  ${pc.bold("Installed:")} ${meta.installedAt}`);
    console.log(`  ${pc.bold("Logs:")}      ${pc.dim(join(getLogDir(), "service.stderr.log"))}`);
  } else {
    console.log(`  ${pc.dim("No service metadata found.")}`);
  }

  console.log("");
}

// ── Entry point ──────────────────────────────────────────────────────────

const command = process.argv[2];

const commands: Record<string, () => Promise<void>> = {
  install,
  stop,
  restart,
  uninstall,
  status,
};

const handler = commands[command ?? ""];

if (!handler) {
  console.log(`\n  ${pc.bold("Usage:")} bun run service <command>\n`);
  console.log(`  ${pc.bold("Commands:")}`);
  console.log(`    ${pc.cyan("install")}    Install and start as system service`);
  console.log(`    ${pc.cyan("stop")}       Stop the service`);
  console.log(`    ${pc.cyan("restart")}    Restart the service`);
  console.log(`    ${pc.cyan("uninstall")}  Stop and remove the service`);
  console.log(`    ${pc.cyan("status")}     Show service status`);
  console.log("");
  process.exit(command ? 1 : 0);
}

handler().catch((err) => {
  p.log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
