/**
 * Read-only overview of the current .env configuration.
 * Usage: bun run config
 *
 * Secrets are masked (only the last 4 characters are shown). Unset variables
 * are listed with their effective default so it is clear what is and is not
 * configured without opening .env or walking through the setup.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pc from "picocolors";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(PROJECT_ROOT, ".env");

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const env = readEnv();

interface Entry {
  key: string;
  secret?: boolean;
  default?: string;
  render?: (value: string) => string;
}

const GROUPS: Array<{ title: string; entries: Entry[] }> = [
  {
    title: "Server",
    entries: [
      { key: "PORT", default: "3000" },
      { key: "HTTPS_PORT" },
      { key: "AUTH_TOKEN", secret: true },
      { key: "DASHBOARD", default: "true" },
      { key: "WORKING_DIR", default: "workspace/" },
      { key: "FETCH_MESSAGE", default: "fetchPendingTasks" },
      { key: "LOG_LEVEL", default: "info" },
      { key: "RATE_LIMIT_MAX" },
      { key: "RATE_LIMIT_WINDOW_MS" },
    ],
  },
  {
    title: "Agent & LLM",
    entries: [
      { key: "AGENT_NAME", default: "PocketHook Assistant" },
      { key: "USER_NAME" },
      { key: "ONBOARDING_CHAT", default: "false" },
      { key: "LLM_PROVIDER", default: "anthropic" },
      { key: "LLM_MODEL" },
      { key: "LLM_BASE_URL" },
      { key: "LLM_REASONING", default: "off" },
      { key: "LLM_API_KEY", secret: true },
      { key: "LLM_QUICK_PROVIDER", default: "same as LLM_PROVIDER" },
      { key: "LLM_QUICK_MODEL", default: "same as LLM_MODEL" },
      { key: "LLM_QUICK_BASE_URL" },
      { key: "LLM_QUICK_REASONING", default: "off" },
      { key: "LLM_QUICK_API_KEY", secret: true },
      { key: "OAUTH_REFRESH_TOKEN", secret: true },
      {
        key: "OAUTH_TOKEN_EXPIRES",
        render: (value) => {
          const ms = Number(value);
          if (!Number.isFinite(ms) || ms <= 0) return value;
          const date = new Date(ms).toISOString();
          return ms > Date.now() ? `${date} (${pc.green("valid")})` : `${date} (${pc.red("expired")})`;
        },
      },
    ],
  },
  {
    title: "Memory",
    entries: [
      { key: "MAX_HISTORY", default: "50" },
      { key: "MAX_RECALL", default: "5" },
      { key: "SESSION_TTL_MINUTES", default: "60" },
      { key: "VECTOR_MEMORY", default: "false" },
      { key: "EMBEDDING_PROVIDER" },
      { key: "EMBEDDING_MODEL" },
      { key: "EMBEDDING_URL" },
      { key: "EMBEDDING_API_KEY", secret: true },
    ],
  },
  {
    title: "Web search",
    entries: [
      { key: "SEARCH_PROVIDER" },
      { key: "SEARCH_URL" },
      { key: "SEARCH_API_KEY", secret: true },
    ],
  },
  {
    title: "Safari extension",
    entries: [
      { key: "SAFARI_PERMISSION_LEVEL", default: "confirm" },
      { key: "SAFARI_CAPTURES_BASE_URL", default: `http://127.0.0.1:${env.PORT || "3000"} (local only)` },
    ],
  },
  {
    title: "Locale",
    entries: [
      { key: "LOCALE_CITY" },
      { key: "LOCALE_COUNTRY" },
      { key: "LOCALE_TIMEZONE" },
    ],
  },
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?!.*_EXPIRES)/i;

function maskSecret(value: string): string {
  if (!value) return pc.dim("empty");
  const tail = value.length > 8 ? value.slice(-4) : "";
  return pc.green("set") + (tail ? pc.dim(` (…${tail})`) : "");
}

const WIDTH = Math.max(...GROUPS.flatMap((group) => group.entries.map((entry) => entry.key.length))) + 2;

function printEntry(entry: Entry): void {
  const value = env[entry.key];
  const label = `  ${entry.key.padEnd(WIDTH)}`;
  if (value === undefined || value === "") {
    const fallback = entry.default ? `default: ${entry.default}` : "not set";
    console.log(label + pc.dim(`– ${fallback}`));
    return;
  }
  if (entry.secret) {
    console.log(label + maskSecret(value));
    return;
  }
  console.log(label + (entry.render ? entry.render(value) : pc.cyan(value)));
}

console.log();
console.log(pc.bold(`PocketHook Agent Server — configuration`) + pc.dim(` (${ENV_PATH})`));
if (!existsSync(ENV_PATH)) {
  console.log(pc.yellow("\nNo .env file found. Run: bun run setup"));
  process.exit(0);
}

for (const group of GROUPS) {
  console.log();
  console.log(pc.bold(pc.underline(group.title)));
  for (const entry of group.entries) printEntry(entry);
}

// Anything in .env that the groups above do not cover.
const known = new Set(GROUPS.flatMap((group) => group.entries.map((entry) => entry.key)));
const extras = Object.keys(env).filter((key) => !known.has(key));
if (extras.length > 0) {
  console.log();
  console.log(pc.bold(pc.underline("Other")));
  for (const key of extras.sort()) {
    const label = `  ${key.padEnd(WIDTH)}`;
    console.log(label + (SECRET_NAME.test(key) ? maskSecret(env[key] ?? "") : pc.cyan(env[key] ?? "")));
  }
}

// Safari pairing state, if any exists on disk.
const pairingFile = join(PROJECT_ROOT, "data", "safari-extension.json");
if (existsSync(pairingFile)) {
  try {
    const stored = JSON.parse(readFileSync(pairingFile, "utf-8")) as { credentials?: Record<string, string> };
    const count = Object.keys(stored.credentials ?? {}).length;
    console.log();
    console.log(pc.dim(`Safari pairings on disk: ${count} (details: bun run safari:status)`));
  } catch { /* Unreadable pairing file is safari:status's problem. */ }
}
console.log();
