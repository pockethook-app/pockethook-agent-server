/** Generate a one-time pairing code for PocketHook Apple Bridge. */

import pc from "picocolors";

const port = Number(process.env.PORT) || 3000;
const authToken = process.env.AUTH_TOKEN;
const base = `http://127.0.0.1:${port}`;

if (!authToken) {
  console.error(pc.red("AUTH_TOKEN is not set. Run this from the Agent Server project directory."));
  process.exit(1);
}

let response: Response;
try {
  response = await fetch(`${base}/apple-bridge/pairing-code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
  });
} catch {
  console.error(pc.red(`Could not reach Agent Server at ${base}. Start it before generating a code.`));
  process.exit(1);
}

if (!response.ok) {
  console.error(pc.red(`Agent Server responded ${response.status}: ${await response.text()}`));
  process.exit(1);
}

const { code, expiresAt } = await response.json() as { code: string; expiresAt: string };
const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
console.log();
console.log(`  Pairing code: ${pc.bold(pc.green(code))}`);
console.log(pc.dim(`  Expires in ~${minutes} min (${expiresAt})`));
console.log();
console.log("  Open PocketHook Apple Bridge, enter this code under Agent Server pairing, and press Pair.");
console.log(pc.dim(`  Server address: ${base}`));
console.log();
