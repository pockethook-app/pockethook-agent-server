/**
 * Interactive setup CLI.
 * Run with: bun run setup
 * Refresh token: bun run refresh
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(PROJECT_ROOT, ".env");

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function writeEnv(env: Record<string, string>): void {
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  console.log(`\n✓ Configuration saved to ${ENV_PATH}`);
}

function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

const PROVIDERS = [
  { key: "anthropic", name: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-20250514", auth: "apikey" },
  { key: "openai", name: "OpenAI", defaultModel: "gpt-4.1-mini", auth: "apikey" },
  { key: "openai-codex", name: "ChatGPT Plus/Pro (via OAuth)", defaultModel: "gpt-5.1-codex-mini", auth: "oauth-codex" },
  { key: "github-copilot", name: "GitHub Copilot (via OAuth)", defaultModel: "claude-sonnet-4", auth: "oauth-copilot" },
  { key: "google", name: "Google (Gemini)", defaultModel: "gemini-2.5-flash", auth: "apikey" },
  { key: "mistral", name: "Mistral", defaultModel: "mistral-medium-latest", auth: "apikey" },
  { key: "groq", name: "Groq", defaultModel: "llama-3.3-70b-versatile", auth: "apikey" },
  { key: "xai", name: "xAI (Grok)", defaultModel: "grok-3-mini-fast", auth: "apikey" },
  { key: "openrouter", name: "OpenRouter", defaultModel: "anthropic/claude-sonnet-4", auth: "apikey" },
] as const;

async function runCodexOAuth(): Promise<{ access: string; refresh: string; expires: number }> {
  const { loginOpenAICodex } = await import("@mariozechner/pi-ai/oauth");
  let openFn: ((url: string) => Promise<unknown>) | null = null;
  try {
    const mod = await import("open");
    openFn = mod.default;
  } catch {}

  return loginOpenAICodex({
    onAuth: (info) => {
      console.log("\n🌐 Opening browser for ChatGPT login...");
      if (openFn) {
        openFn(info.url).catch(() => {
          console.log("Could not open browser automatically.");
        });
      }
      console.log("\nIf the browser didn't open, visit this URL manually:");
      console.log(info.url);
      console.log("\n⏳ Waiting for authentication...");
    },
    onPrompt: async (p) => prompt(p.message),
    onProgress: (msg) => console.log(`  ${msg}`),
  }).then((creds) => ({ access: creds.access, refresh: creds.refresh, expires: creds.expires }));
}

async function runCopilotOAuth(): Promise<{ access: string; refresh: string; expires: number }> {
  const { loginGitHubCopilot } = await import("@mariozechner/pi-ai/oauth");
  let openFn: ((url: string) => Promise<unknown>) | null = null;
  try {
    const mod = await import("open");
    openFn = mod.default;
  } catch {}

  return loginGitHubCopilot({
    onAuth: (url, instructions) => {
      console.log("\n🌐 Opening browser for GitHub login...");
      if (openFn) {
        openFn(url).catch(() => {
          console.log("Could not open browser automatically.");
        });
      }
      console.log("\nVisit this URL and enter the code:");
      console.log(url);
      if (instructions) console.log(instructions);
      console.log("\n⏳ Waiting for authentication...");
    },
    onPrompt: async (p) => prompt(p.message),
    onProgress: (msg) => console.log(`  ${msg}`),
  }).then((creds) => ({ access: creds.access, refresh: creds.refresh, expires: creds.expires }));
}

async function refreshToken() {
  const env = readEnv();
  const provider = env.LLM_PROVIDER;
  const refreshTk = env.OAUTH_REFRESH_TOKEN;

  if (!refreshTk) {
    console.error("No OAUTH_REFRESH_TOKEN found in .env. Run 'bun run setup' first.");
    process.exit(1);
  }

  if (provider === "github-copilot") {
    console.log("🔄 Refreshing GitHub Copilot token...");
    const { refreshGitHubCopilotToken } = await import("@mariozechner/pi-ai/oauth");
    const creds = await refreshGitHubCopilotToken(refreshTk);
    env.LLM_API_KEY = creds.access;
    env.OAUTH_REFRESH_TOKEN = creds.refresh;
    env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
    writeEnv(env);
    const expiresIn = Math.round((creds.expires - Date.now()) / 60000);
    console.log(`✓ Token refreshed. Expires in ~${expiresIn} min.`);
  } else if (provider === "openai-codex") {
    console.log("🔄 Refreshing OpenAI Codex token...");
    const { refreshOpenAICodexToken } = await import("@mariozechner/pi-ai/oauth");
    const creds = await refreshOpenAICodexToken(refreshTk);
    env.LLM_API_KEY = creds.access;
    env.OAUTH_REFRESH_TOKEN = creds.refresh;
    env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
    writeEnv(env);
    const expiresIn = Math.round((creds.expires - Date.now()) / 60000);
    console.log(`✓ Token refreshed. Expires in ~${expiresIn} min.`);
  } else {
    console.error(`Provider '${provider}' does not use OAuth. No refresh needed.`);
    process.exit(1);
  }
}

async function setup() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     flowmate-agent-server setup         ║");
  console.log("╚══════════════════════════════════════╝\n");

  const env = readEnv();

  // 1. Agent name
  env.AGENT_NAME = await prompt("Agent name (how it introduces itself)", env.AGENT_NAME || "FlowMate Assistant");

  // 2. Auth token
  env.AUTH_TOKEN = await prompt("FlowMate auth token", env.AUTH_TOKEN);

  // 2. Provider
  console.log("\nAvailable LLM providers:");
  PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}`));
  const idx = parseInt(await prompt("\nSelect provider (number)", "1"), 10) - 1;
  const provider = PROVIDERS[Math.max(0, Math.min(idx, PROVIDERS.length - 1))]!;
  env.LLM_PROVIDER = provider.key;
  console.log(`✓ Provider: ${provider.name}`);

  // 3. Model
  env.LLM_MODEL = await prompt("Model ID", env.LLM_MODEL || provider.defaultModel);

  // 4. Port (ask before OAuth since OAuth may interfere with stdin)
  env.PORT = await prompt("Server port", env.PORT || "3000");

  // 5. Auth — API key or OAuth
  if (provider.auth === "oauth-codex") {
    console.log("\n🔑 ChatGPT Plus/Pro uses OAuth authentication.");
    console.log("   This will open your browser to log in with your OpenAI account.\n");
    const proceed = await prompt("Start OAuth flow? (y/n)", "y");
    if (proceed.toLowerCase() === "y") {
      const creds = await runCodexOAuth();
      env.LLM_API_KEY = creds.access;
      env.OAUTH_REFRESH_TOKEN = creds.refresh;
      env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
      console.log("\n✓ OAuth authentication successful!");
    } else {
      console.log("Skipped. Set LLM_API_KEY manually in .env");
      env.LLM_API_KEY = env.LLM_API_KEY || "REPLACE_ME";
    }
  } else if (provider.auth === "oauth-copilot") {
    console.log("\n🔑 GitHub Copilot uses OAuth authentication (device code flow).");
    console.log("   This will open your browser to log in with your GitHub account.\n");
    const proceed = await prompt("Start OAuth flow? (y/n)", "y");
    if (proceed.toLowerCase() === "y") {
      const creds = await runCopilotOAuth();
      env.LLM_API_KEY = creds.access;
      env.OAUTH_REFRESH_TOKEN = creds.refresh;
      env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
      console.log("\n✓ OAuth authentication successful!");
    } else {
      console.log("Skipped. Set LLM_API_KEY manually in .env");
      env.LLM_API_KEY = env.LLM_API_KEY || "REPLACE_ME";
    }
  } else {
    env.LLM_API_KEY = await prompt(`${provider.name} API key`, env.LLM_API_KEY);
  }

  // Always write — this is the last step
  writeEnv(env);
  console.log("  Run the server with: bun run start");
}

async function switchProvider() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║     Switch LLM provider              ║");
  console.log("╚══════════════════════════════════════╝\n");

  const env = readEnv();

  const current = PROVIDERS.find((p) => p.key === env.LLM_PROVIDER);
  console.log(`Current: ${current?.name || env.LLM_PROVIDER || "none"} (${env.LLM_MODEL || "no model"})\n`);

  console.log("Available LLM providers:");
  PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p.name}`));
  const idx = parseInt(await prompt("\nSelect provider (number)", "1"), 10) - 1;
  const provider = PROVIDERS[Math.max(0, Math.min(idx, PROVIDERS.length - 1))]!;
  env.LLM_PROVIDER = provider.key;
  console.log(`✓ Provider: ${provider.name}`);

  env.LLM_MODEL = await prompt("Model ID", provider.defaultModel);

  if (provider.auth === "oauth-codex") {
    const proceed = await prompt("Start OpenAI OAuth flow? (y/n)", "y");
    if (proceed.toLowerCase() === "y") {
      const creds = await runCodexOAuth();
      env.LLM_API_KEY = creds.access;
      env.OAUTH_REFRESH_TOKEN = creds.refresh;
      env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
      console.log("\n✓ OAuth authentication successful!");
    }
  } else if (provider.auth === "oauth-copilot") {
    const proceed = await prompt("Start GitHub OAuth flow? (y/n)", "y");
    if (proceed.toLowerCase() === "y") {
      const creds = await runCopilotOAuth();
      env.LLM_API_KEY = creds.access;
      env.OAUTH_REFRESH_TOKEN = creds.refresh;
      env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
      console.log("\n✓ OAuth authentication successful!");
    }
  } else {
    env.LLM_API_KEY = await prompt(`${provider.name} API key`, env.LLM_API_KEY);
    // Clean OAuth keys if switching to API key provider
    delete env.OAUTH_REFRESH_TOKEN;
    delete env.OAUTH_TOKEN_EXPIRES;
  }

  writeEnv(env);
  console.log("  Restart the server to apply changes.");
}

// Entry point
if (process.argv.includes("--switch")) {
  switchProvider().catch((err) => {
    console.error("✗ Switch failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (process.argv.includes("--refresh")) {
  refreshToken().catch((err) => {
    console.error("✗ Refresh failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  setup().catch((err) => {
    console.error("✗ Setup failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
