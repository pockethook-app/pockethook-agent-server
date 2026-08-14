/**
 * Safari extension pairing CLI.
 *
 * Usage:
 *   bun run safari:code    Generate a one-time pairing code for the extension popup.
 *   bun run safari:status  Show paired installations and whether one is connected.
 *
 * Talks to the running Agent Server, which owns pairing state.
 */

import pc from "picocolors";

const port = Number(process.env.PORT) || 3000;
const authToken = process.env.AUTH_TOKEN;
const base = `http://127.0.0.1:${port}`;

if (!authToken) {
  console.error(pc.red("AUTH_TOKEN is not set. Run this from the project directory so .env is loaded."));
  process.exit(1);
}

async function request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${authToken}`, ...init?.headers },
    });
  } catch {
    console.error(pc.red(`Could not reach the Agent Server at ${base}.`));
    console.error("Is it running? Start it with: bun run service start");
    process.exit(1);
  }
  if (!response.ok) {
    console.error(pc.red(`Agent Server responded ${response.status}: ${await response.text()}`));
    process.exit(1);
  }
  return await response.json() as Record<string, unknown>;
}

const command = process.argv[2] || "code";

if (command === "code") {
  const { code, expiresAt } = await request("/safari-extension/pairing-code", { method: "POST" }) as { code: string; expiresAt: string };
  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
  console.log();
  console.log(`  Pairing code: ${pc.bold(pc.green(code))}`);
  console.log(pc.dim(`  Expires in ~${minutes} min (${expiresAt})`));
  console.log();
  console.log("  Open the PocketHook Safari extension popup, enter the code, and press Pair.");
  console.log(pc.dim(`  Popup "Server address": ws://127.0.0.1:${port}/safari-extension`));
} else if (command === "status") {
  const status = await request("/safari-extension/status") as {
    connected: boolean;
    installations: Array<{ installationId: string; transport: string; lastContactAt: string | null }>;
    paired: string[];
  };
  console.log();
  console.log(`  Connected: ${status.connected ? pc.green("yes") : pc.red("no")}`);
  console.log(`  Paired installations: ${status.paired.length === 0 ? pc.dim("none") : ""}`);
  for (const id of status.paired) {
    const live = status.installations.find((entry) => entry.installationId === id);
    const state = live
      ? pc.green(`online via ${live.transport}${live.lastContactAt ? `, last contact ${live.lastContactAt}` : ""}`)
      : pc.dim("offline");
    console.log(`    ${id} — ${state}`);
  }
  if (status.paired.length > 0 && !status.connected) {
    console.log(pc.dim("  An installation is paired but not connected. Check that Safari is open and the extension is enabled."));
  }
} else {
  console.error(`Unknown command: ${command}. Use "code" or "status".`);
  process.exit(1);
}
