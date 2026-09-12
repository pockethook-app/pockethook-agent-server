/**
 * Overview of every `bun run` command in this project.
 * Usage: bun run help
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const GROUPS: Array<{ title: string; commands: Array<[name: string, description: string]> }> = [
  {
    title: "Run",
    commands: [
      ["start", "Start the server in the foreground"],
      ["dev", "Start with hot reload (--watch)"],
      ["service <cmd>", "System service: install | stop | restart | uninstall | status"],
      ["logs", "Tail the service logs"],
    ],
  },
  {
    title: "Configuration",
    commands: [
      ["setup", "Full interactive onboarding (provider, keys, personality…)"],
      ["config", "Show the current configuration (secrets masked)"],
      ["switch", "Switch LLM provider/model"],
      ["personality", "Edit the agent's personality"],
      ["permissions", "Edit tool and filesystem permissions"],
      ["memory", "Tune memory settings (history, recall)"],
      ["refresh", "Refresh the OAuth token"],
    ],
  },
  {
    title: "Safari extension",
    commands: [
      ["safari:install", "Download and install the Safari extension app"],
      ["safari:config", "Set permission level and capture URL (optional)"],
      ["safari:code", "Generate a one-time pairing code"],
      ["safari:status", "Show paired installations and connection state"],
    ],
  },
  {
    title: "Apple Bridge (macOS)",
    commands: [
      ["apple-bridge:install", "Install or update the bundled notarized Apple Bridge app"],
      ["apple-bridge:code", "Generate a one-time pairing code"],
      ["apple-bridge:status", "Check the app, signature, local service and permissions"],
    ],
  },
  {
    title: "Networking",
    commands: [
      ["tunnel", "Expose the server through a tunnel"],
      ["dev:tunnel", "Dev server + tunnel"],
    ],
  },
  {
    title: "Development",
    commands: [
      ["test", "Run the test suite"],
      ["help", "Show this overview"],
    ],
  },
];

const WIDTH = Math.max(...GROUPS.flatMap((group) => group.commands.map(([name]) => name.length))) + 3;

console.log();
console.log(pc.bold("PocketHook Agent Server — commands"));
for (const group of GROUPS) {
  console.log();
  console.log(pc.bold(pc.underline(group.title)));
  for (const [name, description] of group.commands) {
    console.log(`  ${pc.cyan(("bun run " + name).padEnd(WIDTH + 8))}${description}`);
  }
}

// Catch scripts added to package.json but not documented here.
try {
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
  const documented = new Set(GROUPS.flatMap((group) => group.commands.map(([name]) => name.split(" ")[0])));
  const extras = Object.keys(pkg.scripts ?? {}).filter((name) => !documented.has(name));
  if (extras.length > 0) {
    console.log();
    console.log(pc.bold(pc.underline("Undocumented")));
    for (const name of extras.sort()) console.log(`  ${pc.cyan(("bun run " + name).padEnd(WIDTH + 8))}${pc.dim(pkg.scripts![name] ?? "")}`);
  }
} catch { /* package.json is unreadable only in broken checkouts. */ }
console.log();
