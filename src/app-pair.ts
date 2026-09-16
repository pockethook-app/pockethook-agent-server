import * as prompts from "@clack/prompts";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { appPairingName, discoverAppPairingURL } from "./app-pair-discovery.js";
import { terminalQRCode } from "./app-pair-terminal.js";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
}

if (args.includes("--help")) {
  console.log("bun run app:qr [--open] [--url https://your-server.example] [--name Personal] [--ui-url https://your-ui.example]");
  console.log("Detects the existing Tailscale HTTPS route to this server and uses AGENT_NAME automatically.");
  console.log("Displays the QR in the terminal. Add --open to also open the PNG image.");
  console.log("Creates a one-use QR valid for 5 minutes. This connects the app as the existing server owner.");
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.error("This QR generator requires macOS (Core Image). The pairing HTTP endpoints are platform-independent.");
  process.exit(1);
}
if (!process.env.AUTH_TOKEN) {
  console.error("Run this command from the configured Agent Server directory.");
  process.exit(1);
}

prompts.intro("Connect PocketHook 1.4");
try {
  const port = Number(process.env.PORT) || 3000;
  const name = appPairingName(option("--name"), process.env.AGENT_NAME);
  let serverURL = option("--url");
  if (serverURL === undefined) {
    const discovered = await discoverAppPairingURL(port, Number(process.env.HTTPS_PORT));
    serverURL = discovered.url;
    if (serverURL) {
      prompts.log.info("Using this server's existing Tailscale HTTPS address and configured name.");
    } else {
      if (!process.stdin.isTTY) {
        throw new Error(discovered.candidates.length > 1
          ? "More than one Tailscale address points to this server. Choose one with --url."
          : "Could not detect an existing Tailscale HTTPS route to this server. Supply its HTTPS address with --url.");
      }
      const selected = discovered.candidates.length > 1
        ? await prompts.select({
          message: "Several Tailscale addresses point to this server. Which should PocketHook use?",
          options: discovered.candidates.map(value => ({ value, label: value })),
        })
        : await prompts.text({
          message: "No Tailscale HTTPS route found. HTTPS server address reachable from your iPhone",
          placeholder: "https://your-server.example",
        });
      if (prompts.isCancel(selected)) process.exit(0);
      serverURL = selected;
    }
  }
  const response = await fetch(`http://127.0.0.1:${port}/app-pairing/code`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.AUTH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serverURL, name, personalUIURL: option("--ui-url") }),
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Server returned ${response.status}. Check the address and start/restart the updated server.`);
  const { qr, expiresAt } = await response.json() as { qr: string; expiresAt: string };
  const directory = await mkdtemp(join(tmpdir(), "pockethook-pairing-"));
  await chmod(directory, 0o700);
  const image = join(directory, "PocketHook-QR.png");
  // Invitation on stdin, never in process arguments. Stdout contains only QR pixels.
  const processQR = Bun.spawn(["/usr/bin/swift", fileURLToPath(new URL("./app-pair-qr.swift", import.meta.url)), image, "--matrix"], {
    stdin: new TextEncoder().encode(qr), stdout: "pipe", stderr: "ignore",
  });
  const [exitCode, matrixJSON] = await Promise.all([processQR.exited, new Response(processQR.stdout).text()]);
  if (exitCode !== 0) throw new Error("Could not render the QR with Core Image.");
  await chmod(image, 0o600);
  const matrix: unknown = JSON.parse(matrixJSON);
  const terminalQR = terminalQRCode(matrix, process.stdout.columns);
  if (terminalQR) {
    // Do not put the QR inside a prompts frame: prefixes and wrapping alter its modules.
    process.stdout.write(`\n${terminalQR}\n\n`);
  } else {
    prompts.log.warn("The terminal is too narrow for this QR. Widen it and run again, or use --open to view the image.");
  }
  prompts.log.info(`QR image: ${image}`);
  if (args.includes("--open")) {
    const viewer = Bun.spawn(["/usr/bin/open", image], { stdout: "ignore", stderr: "ignore" });
    if (await viewer.exited !== 0) prompts.log.warn("Could not open the image automatically. Open the PNG path above.");
  }
  prompts.outro(`In PocketHook, choose Add server → Scan QR. Expires at ${expiresAt}. Generating another QR invalidates this one.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not create the pairing QR.");
  process.exit(1);
}
