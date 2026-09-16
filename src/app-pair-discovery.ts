import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Match the upstream, not just the machine's DNS name: other services can own port 443. */
function proxiesToServer(handler: unknown, serverPort: number): boolean {
  const proxy = record(handler).Proxy;
  if (typeof proxy !== "string" || !proxy) return false;
  try {
    // Serve accepts a full HTTP URL, a host:port, or just a local port.
    const address = /^\d+$/.test(proxy) ? `http://localhost:${proxy}`
      : proxy.includes("://") ? proxy : `http://${proxy}`;
    const url = new URL(address);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && Number(url.port || 80) === serverPort && url.pathname === "/"
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function configURLs(value: unknown, serverPort: number): string[] {
  const config = record(value);
  const urls: string[] = [];
  for (const [hostPort, site] of Object.entries(record(config.Web))) {
    try {
      const url = new URL(`https://${hostPort}`);
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/") continue;
      if (record(record(config.TCP)[url.port || "443"]).HTTPS !== true) continue;
      const handlers = record(record(site).Handlers);
      if (!proxiesToServer(handlers["/"], serverPort)) continue;
      // A more specific mount must not send app requests to a different service.
      const appPaths = ["/app-pairing/redeem", "/health", "/jobs"];
      const conflicts = Object.keys(handlers).some(mount => mount !== "/" && appPaths.some(path =>
        path === mount || path.startsWith(mount.endsWith("/") ? mount : `${mount}/`)));
      if (conflicts) continue;
      urls.push(url.href);
    } catch {
      // An invalid or unrelated Serve entry must not prevent inspecting the others.
    }
  }
  return urls;
}

export function selectAppPairingURL(status: unknown, serverPort: number, preferredPorts: number[] = []): {
  url?: string;
  candidates: string[];
} {
  const config = record(status);
  // ServeConfig includes background listeners, ephemeral foreground listeners, and service listeners.
  // Schema: https://github.com/tailscale/tailscale/blob/main/ipn/serve.go
  const configs = [config, ...Object.values(record(config.Foreground)).map(record)];
  const candidates = [...new Set(configs.flatMap(c => [c, ...Object.values(record(c.Services))])
    .flatMap(c => configURLs(c, serverPort)))];
  for (const port of preferredPorts) {
    const matching = candidates.filter(candidate => Number(new URL(candidate).port || 443) === port);
    if (matching.length === 1) return { url: matching[0], candidates };
  }
  return { url: candidates.length === 1 ? candidates[0] : undefined, candidates };
}

/** Read existing configuration only; never start, change, or publish a tunnel. */
export async function discoverAppPairingURL(serverPort: number, preferredHTTPSPort?: number) {
  const [status, metadata] = await Promise.all([
    execFileAsync("tailscale", ["serve", "status", "--json"], { timeout: 5_000, maxBuffer: 1024 * 1024 })
      .then(({ stdout }) => JSON.parse(stdout) as unknown).catch(() => undefined),
    readFile(new URL("../data/service.json", import.meta.url), "utf8")
      .then(text => record(JSON.parse(text))).catch(() => ({} as Record<string, unknown>)),
  ]);
  const preferredPorts = [preferredHTTPSPort,
    metadata.tunnelType === "tailscale" && typeof metadata.tunnelPort === "number" ? metadata.tunnelPort : undefined,
  ].filter((port): port is number => Number.isInteger(port) && Number(port) > 0 && Number(port) <= 65535);
  return selectAppPairingURL(status, serverPort, preferredPorts);
}

export function appPairingName(override?: string, configuredName?: string): string {
  const name = (override ?? configuredName ?? "PocketHook Assistant").trim();
  if (!name || name.length > 80) throw new Error("Server name must contain 1–80 characters. Use --name to override it.");
  return name;
}
