/**
 * HTTPS tunnel setup for FlowMate agent server.
 *
 * Auto-detects available tunnel tools (Tailscale, ngrok, Cloudflare Tunnel)
 * and creates an HTTPS endpoint for the server.
 *
 * Usage: bun run tunnel
 */

import { spawn, execSync } from "child_process";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "./config.js";

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 0; // 0 = auto-detect free port

function printTunnelUrls(url: string, extra?: string): void {
  const cfg = loadConfig();
  console.log("");
  p.log.success(pc.bold("Tunnel ready!"));
  console.log("");
  console.log(`  ${pc.bold("Server URL:")}    ${pc.green(url)}`);
  console.log(`  ${pc.bold("Health check:")} ${pc.green(`${url}/health`)}`);
  console.log(`  ${pc.bold("Jobs polling:")} ${pc.green(`${url}/jobs`)}`);
  if (cfg.dashboardEnabled) {
    console.log(`  ${pc.bold("Dashboard:")}    ${pc.green(`${url}/dashboard`)}`);
  }
  console.log("");
  console.log(`  ${pc.dim("Copy the Server URL to FlowMate Settings → Server URL")}`);
  console.log(`  ${pc.dim("Copy the Health check URL to FlowMate Settings → Health Check URL")}`);
  console.log(`  ${pc.dim("Copy the Jobs polling URL to FlowMate Settings → Polling URL")}`);
  if (extra) {
    console.log("");
    console.log(`  ${pc.dim(extra)}`);
  }
  console.log("");
  console.log(`  ${pc.dim("Press Ctrl+C to stop the tunnel.")}`);
}

/** Get ports already used by tailscale serve */
function getTailscaleServePorts(): Set<number> {
  const ports = new Set<number>();
  try {
    const output = execSync("tailscale serve status", { encoding: "utf-8" });
    // Matches lines like "https://hostname:PORT" or "https://hostname (Funnel on)" (default = 443)
    for (const line of output.split("\n")) {
      const withPort = line.match(/https:\/\/[^:]+:(\d+)/);
      if (withPort) {
        ports.add(parseInt(withPort[1]!, 10));
        continue;
      }
      // Default port 443: "https://hostname (..." or "https://hostname\n"
      if (line.match(/^https:\/\/[^\s:]+[\s(]/)) {
        ports.add(443);
      }
    }
  } catch {}
  return ports;
}

/** Check if a port is in use (local process or tailscale serve) */
function isPortInUse(port: number, tailscalePorts: Set<number>): boolean {
  if (tailscalePorts.has(port)) return true;
  try {
    execSync(`lsof -i :${port} -sTCP:LISTEN`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Find a free HTTPS port not used by tailscale or local processes */
function findFreeHttpsPort(): number {
  const tailscalePorts = getTailscaleServePorts();
  const candidates = [443, 8443, 9443, 10443, 3443, 4443, 5443];
  for (const port of candidates) {
    if (!isPortInUse(port, tailscalePorts)) return port;
  }
  // Fallback: try sequential ports
  for (let port = 4430; port < 4450; port++) {
    if (!isPortInUse(port, tailscalePorts)) return port;
  }
  return 8443;
}

interface TunnelProvider {
  name: string;
  bin: string;
  detect: () => boolean;
  start: (port: number) => Promise<void>;
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Tailscale ────────────────────────────────────────────────────────────

function getTailscaleHostname(): string | null {
  try {
    const output = execSync("tailscale status --json", { encoding: "utf-8" });
    const status = JSON.parse(output);
    const dns = status.Self?.DNSName;
    if (dns) return dns.replace(/\.$/, "");
  } catch {}

  try {
    const output = execSync("tailscale status", { encoding: "utf-8" });
    const firstLine = output.split("\n").find((l) => l.includes(" "));
    if (firstLine) {
      const parts = firstLine.trim().split(/\s+/);
      return parts[1] || null;
    }
  } catch {}

  return null;
}

async function startTailscale(port: number): Promise<void> {
  const hostname = getTailscaleHostname();
  if (!hostname) {
    p.log.error("Could not detect Tailscale hostname. Is Tailscale connected?");
    process.exit(1);
  }

  const httpsPort = HTTPS_PORT || findFreeHttpsPort();

  p.log.info(`Tailscale hostname: ${pc.cyan(hostname)}`);
  p.log.info(`HTTPS port: ${pc.cyan(String(httpsPort))}${httpsPort === 443 ? "" : pc.dim(` (443 in use)`)}`);
  p.log.step("Starting Tailscale HTTPS serve...");

  // tailscale serve is not a daemon — it configures the rule and exits.
  // So we run it synchronously, then keep the script alive for cleanup on Ctrl+C.
  try {
    execSync(`tailscale serve --https ${httpsPort} http://localhost:${port}`, { stdio: "inherit" });
  } catch (err) {
    p.log.error(`Failed to configure Tailscale serve: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const portSuffix = httpsPort === 443 ? "" : `:${httpsPort}`;
  const url = `https://${hostname}${portSuffix}`;

  printTunnelUrls(url);

  const cleanup = () => {
    console.log(`\n${pc.dim("Removing Tailscale serve on port " + httpsPort + "...")}`);
    try {
      execSync(`tailscale serve --https ${httpsPort} off`, { stdio: "ignore" });
      console.log(pc.dim("Done."));
    } catch {}
  };

  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  // Keep the script alive so Ctrl+C can clean up
  await new Promise(() => {});
}

// ── ngrok ────────────────────────────────────────────────────────────────

async function startNgrok(port: number): Promise<void> {
  p.log.step("Starting ngrok tunnel...");

  const child = spawn("ngrok", ["http", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // ngrok exposes its API on localhost:4040
  // Wait for it to start, then fetch the public URL
  let url: string | null = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((res) => setTimeout(res, 500));
    try {
      const res = await fetch("http://localhost:4040/api/tunnels");
      const data = (await res.json()) as { tunnels: { public_url: string; proto: string }[] };
      const httpsTunnel = data.tunnels.find((t) => t.proto === "https");
      if (httpsTunnel) {
        url = httpsTunnel.public_url;
        break;
      }
    } catch {}
  }

  if (!url) {
    p.log.error("Could not get ngrok URL. Make sure ngrok is authenticated (ngrok config add-authtoken ...)");
    child.kill();
    process.exit(1);
  }

  printTunnelUrls(url);

  child.on("close", (code) => {
    if (code !== null && code !== 0) {
      p.log.error(`ngrok exited with code ${code}`);
    }
  });

  // Keep alive
  await new Promise(() => {});
}

// ── Cloudflare Tunnel ────────────────────────────────────────────────────

async function startCloudflared(port: number): Promise<void> {
  p.log.step("Starting Cloudflare Tunnel (quick tunnel)...");

  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // cloudflared prints the URL to stderr
  let url: string | null = null;

  const waitForUrl = new Promise<void>((resolve) => {
    const handler = (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/(https:\/\/[^\s]+\.trycloudflare\.com)/);
      if (match) {
        url = match[1]!;
        resolve();
      }
    };
    child.stderr?.on("data", handler);
    child.stdout?.on("data", handler);

    // Timeout after 15s
    setTimeout(() => {
      if (!url) {
        p.log.error("Timed out waiting for Cloudflare Tunnel URL.");
        child.kill();
        process.exit(1);
      }
    }, 15_000);
  });

  await waitForUrl;

  printTunnelUrls(url!, "Note: Cloudflare quick tunnels generate a new URL each time.");

  child.on("close", (code) => {
    if (code !== null && code !== 0) {
      p.log.error(`cloudflared exited with code ${code}`);
    }
  });

  // Keep alive
  await new Promise(() => {});
}

// ── Main ─────────────────────────────────────────────────────────────────

const providers: TunnelProvider[] = [
  { name: "Tailscale", bin: "tailscale", detect: () => commandExists("tailscale"), start: startTailscale },
  { name: "ngrok", bin: "ngrok", detect: () => commandExists("ngrok"), start: startNgrok },
  { name: "Cloudflare Tunnel", bin: "cloudflared", detect: () => commandExists("cloudflared"), start: startCloudflared },
];

async function main() {
  console.log("");
  p.intro(pc.bold("FlowMate HTTPS Tunnel"));

  const available = providers.filter((prov) => prov.detect());

  if (available.length === 0) {
    p.log.error("No tunnel tools found. Install one of:");
    console.log(`  ${pc.dim("•")} Tailscale:        ${pc.cyan("https://tailscale.com/download")}`);
    console.log(`  ${pc.dim("•")} ngrok:            ${pc.cyan("https://ngrok.com/download")}`);
    console.log(`  ${pc.dim("•")} Cloudflare Tunnel: ${pc.cyan("https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")}`);
    process.exit(1);
  }

  let provider: TunnelProvider;

  if (available.length === 1) {
    provider = available[0]!;
    p.log.info(`Using ${pc.bold(provider.name)} (only available tool)`);
  } else {
    const choice = await p.select({
      message: "Which tunnel tool do you want to use?",
      options: available.map((prov) => ({
        value: prov.bin,
        label: prov.name,
      })),
    });

    if (p.isCancel(choice)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    provider = available.find((prov) => prov.bin === choice)!;
  }

  p.log.info(`Tunneling localhost:${PORT} via ${pc.bold(provider.name)}...`);

  await provider.start(PORT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
