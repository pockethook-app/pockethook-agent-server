import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

export interface SafariExtensionCommand {
  command: "open_tab" | "navigate_tab" | "get_active_tab" | "close_tab" | "capture_visible_tab" | "get_page_snapshot" | "page_action";
  payload?: Record<string, unknown>;
}

interface Pairing {
  expiresAt: number;
}

interface Connection {
  socket: { send(data: string): void; readyState: number };
  installationId: string;
}

const pairings = new Map<string, Pairing>();
const credentials = new Map<string, string>();
const connections = new Map<string, Connection>();
const lastContactAt = new Map<string, number>();
const pendingCommands = new Map<string, Array<{ requestId: string; command: SafariExtensionCommand; enqueuedAt: number }>>();
// Queued commands the extension never picked up (Safari suspends the
// extension's background page) die unexecuted: running an open_tab or click
// minutes later, when the user happens to wake Safari, would be a surprise.
const PENDING_COMMAND_TTL_MS = 20_000;
const commandResults = new Map<string, { installationId: string; ok: boolean; result?: unknown; error?: string; completedAt: string }>();
const PAIRING_TTL_MS = 5 * 60_000;
const OPEN = 1;
const RECENT_CONTACT_MS = 5_000;

const CREDENTIALS_FILE = join(dirname(dirname(fileURLToPath(import.meta.url))), "data", "safari-extension.json");

function loadCredentials(): void {
  if (!existsSync(CREDENTIALS_FILE)) return;
  try {
    const stored = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as { credentials?: Record<string, string> };
    for (const [installationId, credential] of Object.entries(stored.credentials ?? {})) {
      if (typeof credential === "string") credentials.set(installationId, credential);
    }
  } catch {
    // A corrupt file only means every extension has to pair again.
  }
}

function saveCredentials(): void {
  mkdirSync(dirname(CREDENTIALS_FILE), { recursive: true });
  const temp = `${CREDENTIALS_FILE}.tmp`;
  writeFileSync(temp, JSON.stringify({ credentials: Object.fromEntries(credentials) }, null, 2), { mode: 0o600 });
  renameSync(temp, CREDENTIALS_FILE);
}

loadCredentials();

export function createSafariPairingCode(): { code: string; expiresAt: string } {
  for (const [code, pairing] of pairings) {
    if (pairing.expiresAt <= Date.now()) pairings.delete(code);
  }
  const code = randomBytes(4).toString("hex").toUpperCase();
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairings.set(code, { expiresAt });
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export function pairSafariInstallation(installationId: string, suppliedCode: string): { credential: string } {
  const code = suppliedCode.toUpperCase();
  const pairing = pairings.get(code);
  if (!pairing || pairing.expiresAt <= Date.now()) {
    pairings.delete(code);
    throw new Error("Pairing code is invalid or expired");
  }
  pairings.delete(code);
  const credential = randomUUID();
  credentials.set(installationId, credential);
  saveCredentials();
  return { credential };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function handleSafariExtensionMessage(socket: { send(data: string): void; readyState: number }, raw: string): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    socket.send(JSON.stringify({ type: "error", error: "Invalid JSON message" }));
    return;
  }

  const installationId = typeof message.installationId === "string" ? message.installationId : "";
  if (!installationId || installationId.length > 200) {
    socket.send(JSON.stringify({ type: "error", error: "A valid installationId is required" }));
    return;
  }

  if (message.type === "pair") {
    const code = typeof message.code === "string" ? message.code.toUpperCase() : "";
    try {
      const { credential } = pairSafariInstallation(installationId, code);
      socket.send(JSON.stringify({ type: "paired", credential }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", error: "Pairing code is invalid or expired" }));
    }
    return;
  }

  if (message.type === "hello") {
    const credential = typeof message.credential === "string" ? message.credential : "";
    const expected = credentials.get(installationId);
    if (!expected || !sameSecret(credential, expected)) {
      socket.send(JSON.stringify({ type: "error", error: "Extension is not paired" }));
      return;
    }
    connections.set(installationId, { socket, installationId });
    lastContactAt.set(installationId, Date.now());
    socket.send(JSON.stringify({ type: "ready", installationId }));
    return;
  }

  if (message.type === "result") {
    // Only sockets that completed the hello handshake may report results.
    const connection = connections.get(installationId);
    if (!connection || connection.socket !== socket) {
      socket.send(JSON.stringify({ type: "error", error: "Extension is not paired" }));
      return;
    }
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    if (!requestId) return;
    lastContactAt.set(installationId, Date.now());
    commandResults.set(requestId, {
      installationId,
      ok: message.ok === true,
      result: message.result,
      error: typeof message.error === "string" ? message.error : undefined,
      completedAt: new Date().toISOString(),
    });
  }
}

export function removeSafariExtensionSocket(socket: object): void {
  for (const [installationId, connection] of connections) {
    if (connection.socket === socket) connections.delete(installationId);
  }
}

export function dispatchSafariExtensionCommand(command: SafariExtensionCommand, installationId?: string): { requestId: string; installationId: string } {
  const requestId = randomUUID();
  const targetId = installationId ?? connections.keys().next().value ?? credentials.keys().next().value as string | undefined;
  if (!targetId || !credentials.has(targetId)) throw new Error("No paired Safari extension is available");
  // Commands are delivered exclusively through the poll queue. A WebSocket can
  // report OPEN long after Safari killed the page behind it (suspension,
  // extension reload), and anything sent there vanishes. The socket is only a
  // wake-up nudge so a live extension polls immediately instead of in 750ms.
  const queue = pendingCommands.get(targetId) ?? [];
  queue.push({ requestId, command, enqueuedAt: Date.now() });
  pendingCommands.set(targetId, queue);
  const connection = connections.get(targetId);
  if (connection?.socket.readyState === OPEN) {
    try { connection.socket.send(JSON.stringify({ type: "wake" })); } catch { /* The poll drains the queue regardless. */ }
  }
  return { requestId, installationId: targetId };
}

export function pollSafariExtension(installationId: string, credential: string): { command?: Record<string, unknown> } {
  const expected = credentials.get(installationId);
  if (!expected || !sameSecret(credential, expected)) throw new Error("Extension is not paired");
  lastContactAt.set(installationId, Date.now());
  const queue = pendingCommands.get(installationId);
  let next = queue?.shift();
  while (next && Date.now() - next.enqueuedAt > PENDING_COMMAND_TTL_MS) next = queue?.shift();
  if (!next) return {};
  return { command: { type: "command", requestId: next.requestId, command: next.command.command, payload: next.command.payload ?? {} } };
}

export function recordSafariExtensionResult(
  installationId: string,
  credential: string,
  requestId: string,
  result: { ok: boolean; result?: unknown; error?: string },
): void {
  const expected = credentials.get(installationId);
  if (!expected || !sameSecret(credential, expected)) throw new Error("Extension is not paired");
  lastContactAt.set(installationId, Date.now());
  commandResults.set(requestId, { installationId, ...result, completedAt: new Date().toISOString() });
}

export function getSafariExtensionResult(requestId: string): { installationId: string; ok: boolean; result?: unknown; error?: string; completedAt: string } | undefined {
  return commandResults.get(requestId);
}

// ── Captures ────────────────────────────────────────────────────────────
// capture_visible screenshots are saved here and served by the agent server
// at /safari-extension/capture/<file>, so the assistant can hand the user a
// URL their app renders inline. Files use unguessable UUID names and the
// route is expected to be exposed on the tailnet only.

const CAPTURES_DIR = join(dirname(CREDENTIALS_FILE), "safari-captures");
const CAPTURES_KEEP = 40;

export function saveSafariCapture(dataUrl: string): { file: string; url: string } {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match?.[2]) throw new Error("Unsupported capture format");
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const file = `${randomUUID()}.${match[1] === "jpeg" ? "jpg" : "png"}`;
  writeFileSync(join(CAPTURES_DIR, file), Buffer.from(match[2], "base64"));
  const existing = readdirSync(CAPTURES_DIR)
    .filter((name) => /\.(png|jpg)$/.test(name))
    .map((name) => ({ name, mtime: statSync(join(CAPTURES_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of existing.slice(CAPTURES_KEEP)) {
    try { rmSync(join(CAPTURES_DIR, stale.name)); } catch { /* Retried on the next capture. */ }
  }
  const base = (process.env.SAFARI_CAPTURES_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, "");
  return { file, url: `${base}/safari-extension/capture/${file}` };
}

export function readSafariCapture(file: string): { data: Uint8Array<ArrayBuffer>; contentType: string } | undefined {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$/.test(file)) return undefined;
  const path = join(CAPTURES_DIR, file);
  if (!existsSync(path)) return undefined;
  return { data: Uint8Array.from(readFileSync(path)), contentType: file.endsWith(".jpg") ? "image/jpeg" : "image/png" };
}

export function safariExtensionStatus(): {
  connected: boolean;
  installations: Array<{ installationId: string; transport: "websocket" | "poll"; lastContactAt: string | null }>;
  paired: string[];
} {
  const now = Date.now();
  const installations: Array<{ installationId: string; transport: "websocket" | "poll"; lastContactAt: string | null }> = [];
  for (const installationId of credentials.keys()) {
    const socketOpen = connections.get(installationId)?.socket.readyState === OPEN;
    const contact = lastContactAt.get(installationId);
    const polling = contact !== undefined && now - contact <= RECENT_CONTACT_MS;
    if (socketOpen || polling) {
      installations.push({
        installationId,
        transport: socketOpen ? "websocket" : "poll",
        lastContactAt: contact ? new Date(contact).toISOString() : null,
      });
    }
  }
  return { connected: installations.length > 0, installations, paired: [...credentials.keys()] };
}
