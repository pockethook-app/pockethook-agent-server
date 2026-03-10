/**
 * Interactive setup CLI.
 * Run with: bun run setup
 * Switch provider: bun run switch
 * Refresh token: bun run refresh
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { DEFAULT_PERMISSIONS, loadPermissions, savePermissions, permissionsPath, type Permissions } from "./permissions.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_PATH = join(PROJECT_ROOT, ".env");

// ── Banner ───────────────────────────────────────────────────────────────

// FlowMate brand colors (teal)
const teal = (s: string) => `\x1b[38;2;0;128;128m${s}\x1b[0m`;
const tealDim = (s: string) => `\x1b[38;2;0;100;100m${s}\x1b[0m`;

const BANNER = `
${teal(`  ███████╗██╗      ██████╗ ██╗    ██╗███╗   ███╗ █████╗ ████████╗███████╗
  ██╔════╝██║     ██╔═══██╗██║    ██║████╗ ████║██╔══██╗╚══██╔══╝██╔════╝
  █████╗  ██║     ██║   ██║██║ █╗ ██║██╔████╔██║███████║   ██║   █████╗
  ██╔══╝  ██║     ██║   ██║██║███╗██║██║╚██╔╝██║██╔══██║   ██║   ██╔══╝
  ██║     ███████╗╚██████╔╝╚███╔███╔╝██║ ╚═╝ ██║██║  ██║   ██║   ███████╗
  ╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝ ╚═╝     ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝`)}
${tealDim("                         agent server")}
`;

// ── Env helpers ──────────────────────────────────────────────────────────

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
}

function cancelled(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

// ── Providers ────────────────────────────────────────────────────────────

const PROVIDERS = [
  { key: "anthropic", name: "Anthropic (Claude)", defaultModel: "claude-sonnet-4-20250514", auth: "apikey" },
  { key: "openai", name: "OpenAI", defaultModel: "gpt-4.1-mini", auth: "apikey" },
  { key: "openai-codex", name: "ChatGPT Plus/Pro (OAuth)", defaultModel: "gpt-5.1-codex-mini", auth: "oauth-codex" },
  { key: "github-copilot", name: "GitHub Copilot (OAuth)", defaultModel: "claude-sonnet-4", auth: "oauth-copilot" },
  { key: "google", name: "Google (Gemini)", defaultModel: "gemini-2.5-flash", auth: "apikey" },
  { key: "mistral", name: "Mistral", defaultModel: "mistral-medium-latest", auth: "apikey" },
  { key: "groq", name: "Groq", defaultModel: "llama-3.3-70b-versatile", auth: "apikey" },
  { key: "xai", name: "xAI (Grok)", defaultModel: "grok-3-mini-fast", auth: "apikey" },
  { key: "openrouter", name: "OpenRouter", defaultModel: "anthropic/claude-sonnet-4", auth: "apikey" },
] as const;

type ProviderEntry = (typeof PROVIDERS)[number];

// ── OAuth flows ──────────────────────────────────────────────────────────

async function runCodexOAuth(): Promise<{ access: string; refresh: string; expires: number }> {
  const { loginOpenAICodex } = await import("@mariozechner/pi-ai/oauth");
  let openFn: ((url: string) => Promise<unknown>) | null = null;
  try {
    const mod = await import("open");
    openFn = mod.default;
  } catch {}

  const s = p.spinner();
  return loginOpenAICodex({
    onAuth: (info) => {
      if (openFn) {
        openFn(info.url).catch(() => {});
      }
      p.note(info.url, "Open this URL to authenticate with ChatGPT");
      s.start("Waiting for authentication...");
    },
    onPrompt: async (pr) => {
      s.stop();
      const val = await p.text({ message: pr.message });
      if (p.isCancel(val)) cancelled();
      s.start("Waiting for authentication...");
      return val;
    },
    onProgress: (msg) => s.message(msg),
  }).then((creds) => {
    s.stop("Authenticated!");
    return { access: creds.access, refresh: creds.refresh, expires: creds.expires };
  });
}

async function runCopilotOAuth(): Promise<{ access: string; refresh: string; expires: number }> {
  const { loginGitHubCopilot } = await import("@mariozechner/pi-ai/oauth");
  let openFn: ((url: string) => Promise<unknown>) | null = null;
  try {
    const mod = await import("open");
    openFn = mod.default;
  } catch {}

  const s = p.spinner();
  return loginGitHubCopilot({
    onAuth: (url, instructions) => {
      if (openFn) {
        openFn(url).catch(() => {});
      }
      const msg = instructions ? `${url}\n\n${instructions}` : url;
      p.note(msg, "Open this URL to authenticate with GitHub");
      s.start("Waiting for authentication...");
    },
    onPrompt: async (pr) => {
      s.stop();
      const val = await p.text({ message: pr.message });
      if (p.isCancel(val)) cancelled();
      s.start("Waiting for authentication...");
      return val;
    },
    onProgress: (msg) => s.message(msg),
  }).then((creds) => {
    s.stop("Authenticated!");
    return { access: creds.access, refresh: creds.refresh, expires: creds.expires };
  });
}

// ── Shared: select provider + auth ───────────────────────────────────────

async function selectProvider(env: Record<string, string>): Promise<ProviderEntry> {
  const providerKey = await p.select({
    message: "LLM provider",
    options: PROVIDERS.map((pr) => ({
      value: pr.key,
      label: pr.name,
      hint: pr.key === env.LLM_PROVIDER ? "current" : undefined,
    })),
    initialValue: env.LLM_PROVIDER || "anthropic",
  });
  if (p.isCancel(providerKey)) cancelled();
  return PROVIDERS.find((pr) => pr.key === providerKey)!;
}

async function configureAuth(provider: ProviderEntry, env: Record<string, string>): Promise<void> {
  if (provider.auth === "oauth-codex" || provider.auth === "oauth-copilot") {
    const label = provider.auth === "oauth-codex" ? "ChatGPT" : "GitHub";
    const proceed = await p.confirm({
      message: `Start ${label} OAuth flow?`,
      initialValue: true,
    });
    if (p.isCancel(proceed)) cancelled();

    if (proceed) {
      const creds = provider.auth === "oauth-codex"
        ? await runCodexOAuth()
        : await runCopilotOAuth();
      env.LLM_API_KEY = creds.access;
      env.OAUTH_REFRESH_TOKEN = creds.refresh;
      env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
    } else {
      p.log.warn("Skipped. Set LLM_API_KEY manually in .env");
      env.LLM_API_KEY = env.LLM_API_KEY || "REPLACE_ME";
    }
  } else {
    const apiKey = await p.password({
      message: `${provider.name} API key`,
    });
    if (p.isCancel(apiKey)) cancelled();
    env.LLM_API_KEY = apiKey;
    // Clean OAuth keys when switching to API key provider
    delete env.OAUTH_REFRESH_TOKEN;
    delete env.OAUTH_TOKEN_EXPIRES;
  }
}

// ── Commands ─────────────────────────────────────────────────────────────

async function setup() {
  console.clear();
  console.log(BANNER);
  p.intro(pc.bgGreen(pc.black(" setup ")));

  const env = readEnv();

  const agentName = await p.text({
    message: "Agent name",
    placeholder: "How the assistant introduces itself",
    initialValue: env.AGENT_NAME || "FlowMate Assistant",
  });
  if (p.isCancel(agentName)) cancelled();
  env.AGENT_NAME = agentName;

  const authToken = await p.text({
    message: "FlowMate auth token",
    placeholder: "Shared secret between FlowMate app and this server",
    initialValue: env.AUTH_TOKEN,
    validate: (v) => (!v ? "Auth token is required" : undefined),
  });
  if (p.isCancel(authToken)) cancelled();
  env.AUTH_TOKEN = authToken;

  const provider = await selectProvider(env);
  env.LLM_PROVIDER = provider.key;

  const model = await p.text({
    message: "Model ID",
    initialValue: env.LLM_MODEL || provider.defaultModel,
  });
  if (p.isCancel(model)) cancelled();
  env.LLM_MODEL = model;

  const port = await p.text({
    message: "Server port",
    initialValue: env.PORT || "3000",
    validate: (v) => (isNaN(Number(v)) ? "Must be a number" : undefined),
  });
  if (p.isCancel(port)) cancelled();
  env.PORT = port;

  const fetchMessage = await p.text({
    message: "Fetch message (must match FlowMate app setting)",
    initialValue: env.FETCH_MESSAGE || "fetchPendingTasks",
  });
  if (p.isCancel(fetchMessage)) cancelled();
  env.FETCH_MESSAGE = fetchMessage;

  const dashboard = await p.confirm({
    message: "Enable web dashboard? (/dashboard route)",
    initialValue: env.DASHBOARD !== "false",
  });
  if (p.isCancel(dashboard)) cancelled();
  if (!dashboard) {
    env.DASHBOARD = "false";
  } else {
    delete env.DASHBOARD; // defaults to enabled when absent
  }

  await configureAuth(provider, env);

  // Permissions
  const configPerms = await p.confirm({
    message: "Configure tool permissions?",
    initialValue: true,
  });
  if (p.isCancel(configPerms)) cancelled();

  if (configPerms) {
    await configurePermissions();
  } else {
    savePermissions(DEFAULT_PERMISSIONS);
    p.log.info("Default permissions saved.");
  }

  writeEnv(env);
  p.outro(`${pc.green("Done!")} Run the server with ${pc.cyan("bun run start")}`);
}

async function switchProvider() {
  console.clear();
  console.log(BANNER);
  p.intro(pc.bgCyan(pc.black(" switch provider ")));

  const env = readEnv();

  const current = PROVIDERS.find((pr) => pr.key === env.LLM_PROVIDER);
  if (current) {
    p.log.info(`Current: ${pc.bold(current.name)} ${pc.dim(`(${env.LLM_MODEL || "no model"})`)}`);
  }

  const provider = await selectProvider(env);
  env.LLM_PROVIDER = provider.key;

  const model = await p.text({
    message: "Model ID",
    initialValue: provider.defaultModel,
  });
  if (p.isCancel(model)) cancelled();
  env.LLM_MODEL = model;

  await configureAuth(provider, env);

  writeEnv(env);
  p.outro(`${pc.green("Done!")} Restart the server to apply changes.`);
}

async function refreshToken() {
  console.clear();
  console.log(BANNER);
  p.intro(pc.bgYellow(pc.black(" refresh token ")));

  const env = readEnv();
  const provider = env.LLM_PROVIDER;
  const refreshTk = env.OAUTH_REFRESH_TOKEN;

  if (!refreshTk) {
    p.log.error("No OAUTH_REFRESH_TOKEN found in .env. Run setup first.");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Refreshing token...");

  try {
    let creds: { access: string; refresh: string; expires: number };

    if (provider === "github-copilot") {
      const { refreshGitHubCopilotToken } = await import("@mariozechner/pi-ai/oauth");
      creds = await refreshGitHubCopilotToken(refreshTk);
    } else if (provider === "openai-codex") {
      const { refreshOpenAICodexToken } = await import("@mariozechner/pi-ai/oauth");
      creds = await refreshOpenAICodexToken(refreshTk);
    } else {
      s.stop();
      p.log.error(`Provider '${provider}' does not use OAuth.`);
      process.exit(1);
    }

    env.LLM_API_KEY = creds.access;
    env.OAUTH_REFRESH_TOKEN = creds.refresh;
    env.OAUTH_TOKEN_EXPIRES = String(creds.expires);
    writeEnv(env);

    const expiresIn = Math.round((creds.expires - Date.now()) / 60000);
    s.stop(`Token refreshed. Expires in ~${expiresIn} min.`);
    p.outro(pc.green("Done!"));
  } catch (err) {
    s.stop();
    p.log.error(`Refresh failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ── Permissions configurator ──────────────────────────────────────────────

async function configurePermissions() {
  const current = loadPermissions();

  const enabledTools = await p.multiselect({
    message: "Enabled tools",
    options: [
      { value: "shell", label: "shell", hint: "Execute shell commands" },
      { value: "read", label: "read", hint: "Read files" },
      { value: "write", label: "write", hint: "Write files" },
      { value: "ls", label: "ls", hint: "List directories" },
      { value: "create_job", label: "create_job", hint: "Create background jobs" },
      { value: "list_jobs", label: "list_jobs", hint: "List background jobs" },
      { value: "delete_job", label: "delete_job", hint: "Delete background jobs" },
    ],
    initialValues: current.tools,
    required: false,
  });
  if (p.isCancel(enabledTools)) cancelled();

  const enforceDir = await p.confirm({
    message: "Enforce working directory boundary? (prevents ../ escape)",
    initialValue: current.enforceWorkingDir,
  });
  if (p.isCancel(enforceDir)) cancelled();

  const blockedCmds = await p.text({
    message: "Blocked shell commands (comma-separated)",
    initialValue: current.shell.blockedCommands.join(", "),
    placeholder: "sudo, rm -rf /, shutdown",
  });
  if (p.isCancel(blockedCmds)) cancelled();

  const blockedPaths = await p.text({
    message: "Blocked filesystem paths (comma-separated)",
    initialValue: current.filesystem.blockedPaths.join(", "),
    placeholder: ".env, .git, node_modules",
  });
  if (p.isCancel(blockedPaths)) cancelled();

  const blockedFilePatterns = await p.text({
    message: "Blocked file patterns (glob, comma-separated)",
    initialValue: current.filesystem.blockedPatterns.join(", "),
    placeholder: "*.key, *.pem, *.secret",
  });
  if (p.isCancel(blockedFilePatterns)) cancelled();

  const perms: Permissions = {
    tools: enabledTools as string[],
    shell: {
      blockedCommands: parseList(blockedCmds),
      blockedPatterns: current.shell.blockedPatterns, // keep regex patterns as-is (advanced)
    },
    filesystem: {
      blockedPaths: parseList(blockedPaths),
      blockedPatterns: parseList(blockedFilePatterns),
    },
    enforceWorkingDir: enforceDir,
  };

  savePermissions(perms);
  p.log.success(`Permissions saved to ${pc.dim(permissionsPath())}`);
}

function parseList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Entry point ──────────────────────────────────────────────────────────

if (process.argv.includes("--permissions")) {
  (async () => {
    console.clear();
  console.log(BANNER);
    p.intro(pc.bgMagenta(pc.black(" permissions ")));
    await configurePermissions();
    p.outro(pc.green("Done!") + " Restart the server to apply changes.");
  })().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (process.argv.includes("--switch")) {
  switchProvider().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (process.argv.includes("--refresh")) {
  refreshToken().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  setup().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
