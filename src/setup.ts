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
const PERSONALITY_PATH = join(PROJECT_ROOT, "personality.md");

// ── Banner ───────────────────────────────────────────────────────────────

function gradientLine(line: string): string {
  const r0 = 52, g0 = 199, b0 = 89;   // SwiftUI .green (#34C759)
  const r1 = 0,  g1 = 122, b1 = 255;  // SwiftUI .blue  (#007AFF)

  const visible = [...line].filter((c) => c.trim().length > 0);
  const total = visible.length || 1;
  let vi = 0;
  let out = "";
  for (const ch of line) {
    if (ch.trim().length === 0) {
      out += ch;
    } else {
      const t = vi / (total - 1 || 1);
      const r = Math.round(r0 + (r1 - r0) * t);
      const g = Math.round(g0 + (g1 - g0) * t);
      const b = Math.round(b0 + (b1 - b0) * t);
      out += `\x1b[38;2;${r};${g};${b}m${ch}`;
      vi++;
    }
  }
  return out + "\x1b[0m";
}

const BANNER_LINES = [
  "  ██████╗  ██████╗  ██████╗██╗  ██╗███████╗████████╗██╗  ██╗ ██████╗  ██████╗ ██╗  ██╗",
  "  ██╔══██╗██╔═══██╗██╔════╝██║ ██╔╝██╔════╝╚══██╔══╝██║  ██║██╔═══██╗██╔═══██╗██║ ██╔╝",
  "  ██████╔╝██║   ██║██║     █████╔╝ █████╗     ██║   ███████║██║   ██║██║   ██║█████╔╝",
  "  ██╔═══╝ ██║   ██║██║     ██╔═██╗ ██╔══╝     ██║   ██╔══██║██║   ██║██║   ██║██╔═██╗",
  "  ██║     ╚██████╔╝╚██████╗██║  ██╗███████╗   ██║   ██║  ██║╚██████╔╝╚██████╔╝██║  ██╗",
  "  ╚═╝      ╚═════╝  ╚═════╝╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝",
];

const BANNER = "\n" + BANNER_LINES.map(gradientLine).join("\n") + "\n" +
  gradientLine("                              agent server") + "\n";

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
  writeFileSync(ENV_PATH, lines.join("\n") + "\n", { mode: 0o600 });
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
  { key: "ollama", name: "Ollama (local)", defaultModel: "llama3.2", auth: "none" },
  { key: "lm-studio", name: "LM Studio (local)", defaultModel: "qwen3.5-4b-mlx", auth: "none" },
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
  if (provider.auth === "none") {
    env.LLM_API_KEY = provider.key === "lm-studio" ? "lm-studio" : "ollama";
    delete env.OAUTH_REFRESH_TOKEN;
    delete env.OAUTH_TOKEN_EXPIRES;
    const defaultUrl = provider.key === "lm-studio"
      ? "http://localhost:1234/v1"
      : "http://localhost:11434/v1";
    const baseUrl = await p.text({
      message: `${provider.name} base URL`,
      initialValue: env.LLM_BASE_URL || defaultUrl,
    });
    if (p.isCancel(baseUrl)) cancelled();
    env.LLM_BASE_URL = baseUrl;
    return;
  }
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

const SECURITY_NOTICE = `
${pc.bold(pc.yellow("SECURITY NOTICE"))}

This server gives an AI agent access to your system via shell,
file read/write, web access, and background jobs. By default,
dangerous commands and sensitive files are blocked, but no
sandboxing is enforced — the agent runs with your user privileges.

${pc.bold("Recommendations:")}
${pc.dim("•")} Expose the server only through trusted networks (e.g. Tailscale)
${pc.dim("•")} Review permissions.json and adjust blocked commands/paths
${pc.dim("•")} Never install skills or custom tools without reading their
  source code first — they can execute shell commands and
  access your filesystem
${pc.dim("•")} For stronger isolation, run the server inside a container
`;

async function setup() {
  console.clear();
  console.log(BANNER);
  p.note(SECURITY_NOTICE.trim(), pc.yellow("⚠"));
  p.intro(pc.bgGreen(pc.black(" setup ")));

  const env = readEnv();

  const agentName = await p.text({
    message: "Agent name",
    placeholder: "How the assistant introduces itself",
    initialValue: env.AGENT_NAME || "PocketHook Assistant",
  });
  if (p.isCancel(agentName)) cancelled();
  env.AGENT_NAME = agentName;

  const authToken = await p.text({
    message: "PocketHook auth token",
    placeholder: "Shared secret between PocketHook app and this server",
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
    message: "Fetch message (must match PocketHook app setting)",
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

  // Web search
  const enableSearch = await p.confirm({
    message: "Enable web search? (requires Serper API key or SearXNG instance)",
    initialValue: !!env.SEARCH_API_KEY || !!env.SEARCH_URL,
  });
  if (p.isCancel(enableSearch)) cancelled();

  if (enableSearch) {
    const searchProvider = await p.select({
      message: "Search provider",
      options: [
        { value: "serper", label: "Serper.dev (Google results)", hint: "API key required, free tier: 2,500/month" },
        { value: "searxng", label: "SearXNG (self-hosted)", hint: "No API key needed" },
      ],
      initialValue: env.SEARCH_PROVIDER || "serper",
    });
    if (p.isCancel(searchProvider)) cancelled();
    env.SEARCH_PROVIDER = searchProvider;

    if (searchProvider === "serper") {
      const apiKey = await p.password({
        message: "Serper API key (serper.dev)",
      });
      if (p.isCancel(apiKey)) cancelled();
      env.SEARCH_API_KEY = apiKey;
      delete env.SEARCH_URL;
    } else {
      const searchUrl = await p.text({
        message: "SearXNG instance URL",
        placeholder: "http://localhost:8080",
        initialValue: env.SEARCH_URL || "http://localhost:8080",
      });
      if (p.isCancel(searchUrl)) cancelled();
      env.SEARCH_URL = searchUrl;
      delete env.SEARCH_API_KEY;
    }
  } else {
    delete env.SEARCH_PROVIDER;
    delete env.SEARCH_API_KEY;
    delete env.SEARCH_URL;
  }

  await configureAuth(provider, env);

  // Locale (optional)
  const configLocale = await p.confirm({
    message: "Set your locale? (helps the agent with dates, language, and local context)",
    initialValue: !!env.LOCALE_COUNTRY,
  });
  if (p.isCancel(configLocale)) cancelled();

  if (configLocale) {
    const country = await p.text({
      message: "Country",
      placeholder: "e.g. Spain, US, Japan",
      initialValue: env.LOCALE_COUNTRY,
      validate: (v) => (!v ? "Country is required" : undefined),
    });
    if (p.isCancel(country)) cancelled();
    env.LOCALE_COUNTRY = country;

    const city = await p.text({
      message: "City (optional, press Enter to skip)",
      placeholder: "e.g. Madrid, New York, Tokyo",
      initialValue: env.LOCALE_CITY || "",
    });
    if (p.isCancel(city)) cancelled();
    if (city) {
      env.LOCALE_CITY = city;
    } else {
      delete env.LOCALE_CITY;
    }

    const timezone = await p.text({
      message: "Timezone (optional, press Enter to skip)",
      placeholder: "e.g. Europe/Madrid, America/New_York",
      initialValue: env.LOCALE_TIMEZONE || "",
    });
    if (p.isCancel(timezone)) cancelled();
    if (timezone) {
      env.LOCALE_TIMEZONE = timezone;
    } else {
      delete env.LOCALE_TIMEZONE;
    }
  } else {
    delete env.LOCALE_COUNTRY;
    delete env.LOCALE_CITY;
    delete env.LOCALE_TIMEZONE;
    p.log.info(pc.dim("Locale will be auto-detected from IP on startup."));
  }

  // Personality
  await configurePersonality();

  // Semantic memory (optional, requires Ollama)
  const enableSemantic = await p.confirm({
    message: "Enable semantic memory? (requires Ollama running locally)",
    initialValue: env.VECTOR_MEMORY === "true",
  });
  if (p.isCancel(enableSemantic)) cancelled();

  if (enableSemantic) {
    env.VECTOR_MEMORY = "true";

    const embeddingProvider = await p.select({
      message: "Embedding provider",
      options: [
        { value: "ollama", label: "Ollama (local)", hint: "Free, runs locally. Requires: ollama pull <model>" },
        { value: "lm-studio", label: "LM Studio (local)", hint: "Free, runs locally. Load an embedding model in LM Studio" },
        { value: "openai", label: "OpenAI API", hint: "Requires API key. Models: text-embedding-3-small, text-embedding-3-large" },
      ],
      initialValue: env.EMBEDDING_PROVIDER || "ollama",
    });
    if (p.isCancel(embeddingProvider)) cancelled();
    env.EMBEDDING_PROVIDER = embeddingProvider;

    const defaultModels: Record<string, string> = {
      ollama: "nomic-embed-text",
      "lm-studio": "nomic-embed-text-v1.5",
      openai: "text-embedding-3-small",
    };

    const defaultUrls: Record<string, string> = {
      ollama: "http://localhost:11434",
      "lm-studio": "http://localhost:1234",
      openai: "https://api.openai.com",
    };

    const embeddingModel = await p.text({
      message: "Embedding model",
      initialValue: env.EMBEDDING_MODEL || defaultModels[embeddingProvider] || "nomic-embed-text",
    });
    if (p.isCancel(embeddingModel)) cancelled();
    env.EMBEDDING_MODEL = embeddingModel;

    const embeddingUrl = await p.text({
      message: "Embedding API URL",
      initialValue: env.EMBEDDING_URL || defaultUrls[embeddingProvider] || "http://localhost:11434",
    });
    if (p.isCancel(embeddingUrl)) cancelled();
    env.EMBEDDING_URL = embeddingUrl;

    if (embeddingProvider === "openai") {
      const embeddingApiKey = await p.password({
        message: "OpenAI API key for embeddings",
      });
      if (p.isCancel(embeddingApiKey)) cancelled();
      env.EMBEDDING_API_KEY = embeddingApiKey;
    } else {
      delete env.EMBEDDING_API_KEY;
    }

    if (embeddingProvider === "ollama") {
      p.log.info(`Run ${pc.cyan(`ollama pull ${embeddingModel}`)} before starting the server.`);
    } else if (embeddingProvider === "lm-studio") {
      p.log.info(`Load an embedding model in LM Studio before starting the server.`);
    }
  } else {
    env.VECTOR_MEMORY = "false";
    delete env.EMBEDDING_PROVIDER;
    delete env.EMBEDDING_URL;
    delete env.EMBEDDING_MODEL;
    delete env.EMBEDDING_API_KEY;
  }

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
  process.exit(0);
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

// ── Personality configurator ─────────────────────────────────────────────

const PERSONALITY_PRESETS: Record<string, { tone: string; emoji: string }> = {
  warm: {
    tone: "Be warm and personally invested in the user. Celebrate their wins, empathize with their frustrations, ask follow-up questions about how things went. Remember and reference personal details naturally. Use affectionate language and express genuine emotion. Your tone should feel like someone who genuinely cares about the user's day.",
    emoji: "Use emojis naturally to add warmth and expressiveness to your messages.",
  },
  friendly: {
    tone: "Be relaxed and conversational. Use casual phrasing, contractions, and light humor when appropriate. Don't over-explain — trust the user to get it. Keep the energy upbeat but not intense. Think helpful colleague, not customer support.",
    emoji: "Use emojis naturally to add warmth and expressiveness to your messages.",
  },
  professional: {
    tone: "Be direct and structured. Lead with the answer, then explain if needed. Avoid filler phrases, hedging, and unnecessary warmth. Use precise language. When presenting options, use bullet points. Your tone should convey competence and respect for the user's time.",
    emoji: "Use emojis naturally to add warmth and expressiveness to your messages.",
  },
  minimal: {
    tone: "Maximum brevity. One sentence when one sentence is enough. No greetings, no sign-offs, no \"sure!\", no \"great question!\". Skip context the user already knows. If the answer is yes or no, say yes or no.",
    emoji: "Use emojis naturally to add warmth and expressiveness to your messages.",
  },
};

function readPersonality(): string {
  if (!existsSync(PERSONALITY_PATH)) return "";
  return readFileSync(PERSONALITY_PATH, "utf-8").trim();
}

function detectCurrentPreset(): string | null {
  const content = readPersonality();
  for (const [key, preset] of Object.entries(PERSONALITY_PRESETS)) {
    if (content.includes(preset.tone)) return key;
  }
  return content ? "custom" : null;
}

async function configurePersonality() {
  const currentPreset = detectCurrentPreset();

  const style = await p.select({
    message: "Agent personality",
    options: [
      { value: "warm", label: "Warm", hint: "caring, empathetic, personal" },
      { value: "friendly", label: "Friendly", hint: "casual, relaxed, approachable" },
      { value: "professional", label: "Professional", hint: "formal, concise, structured" },
      { value: "minimal", label: "Minimal", hint: "shortest possible answers" },
      { value: "custom", label: "Custom", hint: "write your own description" },
    ],
    initialValue: currentPreset || "friendly",
  });
  if (p.isCancel(style)) cancelled();

  let toneLine: string;
  if (style === "custom") {
    const custom = await p.text({
      message: "Describe the personality you want",
      placeholder: "e.g. Speak like a pirate, be sarcastic but helpful...",
      validate: (v) => (!v ? "Description is required" : undefined),
    });
    if (p.isCancel(custom)) cancelled();
    toneLine = custom;
  } else {
    toneLine = PERSONALITY_PRESETS[style]!.tone;
  }

  const useEmojis = await p.confirm({
    message: "Use emojis in responses?",
    initialValue: readPersonality().includes("Use emojis"),
  });
  if (p.isCancel(useEmojis)) cancelled();

  const emojiLine = useEmojis
    ? "Use emojis naturally to add warmth and expressiveness to your messages."
    : "Do not use emojis in your responses.";

  const content = `${toneLine}\n\n${emojiLine}\n`;
  writeFileSync(PERSONALITY_PATH, content);
  p.log.success(`Personality saved to ${pc.dim(PERSONALITY_PATH)}`);
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
      { value: "web_search", label: "web_search", hint: "Search the web" },
      { value: "web_fetch", label: "web_fetch", hint: "Fetch and read web pages" },
      { value: "remember_fact", label: "remember_fact", hint: "Store facts in knowledge graph (requires semantic memory)" },
      { value: "query_facts", label: "query_facts", hint: "Query facts from knowledge graph (requires semantic memory)" },
      { value: "load_skill", label: "load_skill", hint: "Load full content of a skill on demand (recommended)" },
      { value: "update_memory_status", label: "update_memory_status", hint: "Change PARA status of memories (project/area/resource/archive)" },
      { value: "complete_project", label: "complete_project", hint: "Close a project: archive events, keep resources (PARA transition)" },
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

if (process.argv.includes("--personality")) {
  (async () => {
    console.clear();
    console.log(BANNER);
    p.intro(pc.bgCyan(pc.black(" personality ")));
    await configurePersonality();
    p.outro(pc.green("Done!") + " Changes apply on the next request (hot-reloaded).");
  })().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (process.argv.includes("--permissions")) {
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
