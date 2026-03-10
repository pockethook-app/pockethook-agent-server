/**
 * Starts both the dev server and HTTPS tunnel in a single command.
 * Usage: bun run dev:tunnel
 */

import { spawn } from "child_process";
import pc from "picocolors";

const children: ReturnType<typeof spawn>[] = [];

function cleanup() {
  for (const child of children) {
    try { child.kill(); } catch {}
  }
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

console.log(pc.bold("\n  Starting server + tunnel...\n"));

// 1. Start the dev server (with --watch for hot reload)
const server = spawn("bun", ["run", "--watch", "src/index.ts"], {
  stdio: "inherit",
  env: { ...process.env },
});
children.push(server);

server.on("error", (err) => {
  console.error(pc.red(`Server error: ${err.message}`));
  cleanup();
  process.exit(1);
});

// 2. Wait a moment for the server to start, then launch the tunnel
setTimeout(() => {
  const tunnel = spawn("bun", ["run", "src/tunnel.ts"], {
    stdio: "inherit",
    env: { ...process.env },
  });
  children.push(tunnel);

  tunnel.on("error", (err) => {
    console.error(pc.red(`Tunnel error: ${err.message}`));
  });

  tunnel.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.error(pc.red(`Tunnel exited with code ${code}`));
    }
    cleanup();
    process.exit(code ?? 1);
  });
}, 1500);

server.on("close", (code) => {
  console.error(pc.red(`Server exited with code ${code}`));
  cleanup();
  process.exit(code ?? 1);
});
