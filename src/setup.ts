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
const PERSONALITY_PATH = join(PROJECT_ROOT, "config", "personality.md");

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

type OAuthFlow = import("@earendil-works/pi-ai").OAuthAuth;

async function loadOAuthFlow(provider: "openai-codex" | "github-copilot"): Promise<OAuthFlow> {
  let oauth: OAuthFlow | undefined;
  if (provider === "github-copilot") {
    const { githubCopilotProvider } = await import("@earendil-works/pi-ai/providers/github-copilot");
    oauth = githubCopilotProvider().auth.oauth;
  } else {
    const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");
    oauth = openaiCodexProvider().auth.oauth;
  }
  if (!oauth) {
    p.log.error(`Provider '${provider}' has no OAuth flow.`);
    process.exit(1);
  }
  return oauth;
}

async function runOAuthLogin(
  provider: "openai-codex" | "github-copilot",
  noteTitle: string,
): Promise<{ access: string; refresh: string; expires: number }> {
  const oauth = await loadOAuthFlow(provider);
  let openFn: ((url: string) => Promise<unknown>) | null = null;
  try {
    const mod = await import("open");
    openFn = mod.default;
  } catch {}

  const s = p.spinner();
  const creds = await oauth.login({
    notify: (event) => {
      switch (event.type) {
        case "auth_url":
          if (openFn) {
            openFn(event.url).catch(() => {});
          }
          p.note(event.url, noteTitle);
          s.start("Waiting for authentication...");
          break;
        case "device_code":
          if (openFn) {
            openFn(event.verificationUri).catch(() => {});
          }
          p.note(`${event.verificationUri}\n\nCode: ${event.userCode}`, noteTitle);
          s.start("Waiting for authentication...");
          break;
        case "progress":
          s.message(event.message);
          break;
        case "info":
          p.log.info(event.message);
          break;
      }
    },
    prompt: async (pr) => {
      s.stop();
      let val: string | symbol;
      if (pr.type === "select") {
        val = await p.select({
          message: pr.message,
          options: pr.options.map((o) => ({ value: o.id, label: o.label, hint: o.description })),
        });
      } else if (pr.type === "secret") {
        val = await p.password({ message: pr.message });
      } else {
        val = await p.text({ message: pr.message, placeholder: pr.placeholder });
      }
      if (p.isCancel(val)) cancelled();
      s.start("Waiting for authentication...");
      return val as string;
    },
  });
  s.stop("Authenticated!");
  return { access: creds.access, refresh: creds.refresh, expires: creds.expires };
}

function runCodexOAuth(): Promise<{ access: string; refresh: string; expires: number }> {
  return runOAuthLogin("openai-codex", "Open this URL to authenticate with ChatGPT");
}

function runCopilotOAuth(): Promise<{ access: string; refresh: string; expires: number }> {
  return runOAuthLogin("github-copilot", "Open this URL and enter the code to authenticate with GitHub");
}

// ── Shared: select provider + auth ───────────────────────────────────────

async function selectReasoning(env: Record<string, string>): Promise<void> {
  const level = await p.select({
    message: "Reasoning effort",
    options: [
      { value: "off", label: "off", hint: "no reasoning tokens — cheapest, fastest" },
      { value: "minimal", label: "minimal", hint: "tiny budget, slight extra cost" },
      { value: "low", label: "low", hint: "small budget" },
      { value: "medium", label: "medium", hint: "balanced (Anthropic / OpenAI default-ish)" },
      { value: "high", label: "high", hint: "deeper thinking, ~3-5× output cost" },
      { value: "xhigh", label: "xhigh", hint: "very high budget where supported" },
      { value: "max", label: "max", hint: "highest budget where supported (e.g. gpt-5.6)" },
    ],
    initialValue: env.LLM_REASONING || "off",
  });
  if (p.isCancel(level)) cancelled();
  if (level === "off") {
    delete env.LLM_REASONING;
  } else {
    env.LLM_REASONING = level as string;
  }
}

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

// ── Quick model (memory helper) ──────────────────────────────────────────

const QUICK_MODEL_SUGGESTIONS: Record<string, string> = {
  "openai-codex": "gpt-5.6-luna",
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
  google: "gemini-2.5-flash",
};

async function configureQuickModel(env: Record<string, string>): Promise<void> {
  p.note(
    "Besides the chat model, PocketHook uses a second lightweight LLM\n" +
    "(the \"quick model\") for internal memory chores: classifying each\n" +
    "message into the memory graph and extracting entities to focus\n" +
    "memory search. It runs ~3 tiny prompts per chat message and never\n" +
    "writes chat replies — a small, fast, cheap model is ideal.",
    "Quick model",
  );

  const mainProvider = env.LLM_PROVIDER || "";

  const choice = await p.select({
    message: "Which model should handle quick memory tasks?",
    options: [
      { value: "custom", label: "A different (smaller/faster) model", hint: "recommended" },
      { value: "same", label: "Same as the chat model", hint: "no extra setup, but slower and pricier per message" },
    ],
    initialValue: env.LLM_QUICK_MODEL ? "custom" : "same",
  });
  if (p.isCancel(choice)) cancelled();

  if (choice === "same") {
    delete env.LLM_QUICK_PROVIDER;
    delete env.LLM_QUICK_MODEL;
    delete env.LLM_QUICK_API_KEY;
    delete env.LLM_QUICK_BASE_URL;
  } else {
    // OAuth providers can't do a second independent login, so they are only
    // offered when they match the main provider (credentials are shared).
    const options = PROVIDERS
      .filter((pr) => !pr.auth.startsWith("oauth") || pr.key === mainProvider)
      .map((pr) => ({
        value: pr.key as string,
        label: pr.name as string,
        hint: pr.key === mainProvider ? "same as chat — reuses your login, no extra auth" : undefined,
      }));
    const providerKey = await p.select({
      message: "Quick model provider",
      options,
      initialValue: env.LLM_QUICK_PROVIDER || mainProvider,
    });
    if (p.isCancel(providerKey)) cancelled();
    const provider = PROVIDERS.find((pr) => pr.key === providerKey)!;

    const model = await p.text({
      message: "Quick model ID",
      initialValue: env.LLM_QUICK_MODEL
        || QUICK_MODEL_SUGGESTIONS[provider.key]
        || provider.defaultModel,
    });
    if (p.isCancel(model)) cancelled();

    env.LLM_QUICK_PROVIDER = provider.key;
    env.LLM_QUICK_MODEL = model;

    if (provider.key === mainProvider) {
      p.log.info("Same provider as the chat model — reusing its credentials, no new login needed.");
      delete env.LLM_QUICK_API_KEY;
      delete env.LLM_QUICK_BASE_URL;
    } else if (provider.auth === "none") {
      const defaultUrl = provider.key === "lm-studio"
        ? "http://localhost:1234/v1"
        : "http://localhost:11434/v1";
      const baseUrl = await p.text({
        message: `${provider.name} base URL`,
        initialValue: env.LLM_QUICK_BASE_URL || defaultUrl,
      });
      if (p.isCancel(baseUrl)) cancelled();
      env.LLM_QUICK_BASE_URL = baseUrl;
      delete env.LLM_QUICK_API_KEY;
    } else {
      const apiKey = await p.password({
        message: `${provider.name} API key (for the quick model)`,
      });
      if (p.isCancel(apiKey)) cancelled();
      env.LLM_QUICK_API_KEY = apiKey;
      delete env.LLM_QUICK_BASE_URL;
    }
  }

  const level = await p.select({
    message: "Reasoning effort for the quick model",
    options: [
      { value: "off", label: "off", hint: "recommended — quick tasks are simple JSON classification" },
      { value: "minimal", label: "minimal", hint: "tiny budget, slight extra cost" },
      { value: "low", label: "low", hint: "small budget" },
      { value: "medium", label: "medium", hint: "balanced" },
      { value: "high", label: "high", hint: "deeper thinking — rarely useful here" },
      { value: "xhigh", label: "xhigh", hint: "very high budget where supported" },
      { value: "max", label: "max", hint: "highest budget where supported (e.g. gpt-5.6)" },
    ],
    initialValue: env.LLM_QUICK_REASONING || "off",
  });
  if (p.isCancel(level)) cancelled();
  if (level === "off") {
    delete env.LLM_QUICK_REASONING;
  } else {
    env.LLM_QUICK_REASONING = level as string;
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

  const userName = await p.text({
    message: "Your name or nickname (how the agent should call you)",
    placeholder: "Leave empty to skip",
    initialValue: env.USER_NAME || "",
  });
  if (p.isCancel(userName)) cancelled();
  if (userName) {
    env.USER_NAME = userName;

    const onboardingChat = await p.confirm({
      message: "Would you like the agent to ask you some questions on your first chat to get to know you better?",
      initialValue: env.ONBOARDING_CHAT !== "false",
    });
    if (p.isCancel(onboardingChat)) cancelled();
    env.ONBOARDING_CHAT = onboardingChat ? "true" : "false";
  } else {
    delete env.USER_NAME;
    delete env.ONBOARDING_CHAT;
  }

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

  await selectReasoning(env);

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

  await configureQuickModel(env);

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

    const maxRecall = await p.text({
      message: "Memories to recall per turn (semantic search)",
      initialValue: env.MAX_RECALL || "5",
      placeholder: "5",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 50) return "Must be an integer between 0 and 50.";
      },
    });
    if (p.isCancel(maxRecall)) cancelled();
    env.MAX_RECALL = String(maxRecall);
  } else {
    env.VECTOR_MEMORY = "false";
    delete env.MAX_RECALL;
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

  await selectReasoning(env);

  await configureAuth(provider, env);

  await configureQuickModel(env);

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
    if (provider !== "github-copilot" && provider !== "openai-codex") {
      s.stop();
      p.log.error(`Provider '${provider}' does not use OAuth.`);
      process.exit(1);
    }

    const oauth = await loadOAuthFlow(provider);
    const creds = await oauth.refresh({
      type: "oauth",
      access: env.LLM_API_KEY || "",
      refresh: refreshTk,
      expires: Number(env.OAUTH_TOKEN_EXPIRES) || 0,
    });

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
      { value: "create_project", label: "create_project", hint: "Create a new workspace project (typed, name-only)" },
      { value: "list_projects", label: "list_projects", hint: "List workspace projects" },
      { value: "delete_project", label: "delete_project", hint: "Delete a workspace project (needs confirm: true)" },
      { value: "create_once_job", label: "create_once_job", hint: "Create a one-off background job (shell or prompt)" },
      { value: "create_cron_job", label: "create_cron_job", hint: "Create a recurring background job (interval or cron)" },
      { value: "list_jobs", label: "list_jobs", hint: "List background jobs" },
      { value: "delete_job", label: "delete_job", hint: "Delete background jobs" },
      { value: "web_search", label: "web_search", hint: "Search the web" },
      { value: "web_fetch", label: "web_fetch", hint: "Fetch and read web pages" },
      { value: "safari", label: "safari", hint: "Control a paired PocketHook Safari extension" },
      { value: "remember_fact", label: "remember_fact", hint: "Store facts in knowledge graph (requires semantic memory)" },
      { value: "query_facts", label: "query_facts", hint: "Query facts from knowledge graph (requires semantic memory)" },
      { value: "load_skill", label: "load_skill", hint: "Load full content of a skill on demand (recommended)" },
      { value: "update_memory_status", label: "update_memory_status", hint: "Change PARA status of memories (project/area/resource/archive)" },
      { value: "complete_project", label: "complete_project", hint: "Close a project: archive events, keep resources (PARA transition)" },
      { value: "create_custom_tool", label: "create_custom_tool", hint: "Create a user-layer custom tool (typed writer)" },
      { value: "create_user_skill", label: "create_user_skill", hint: "Create a user-layer skill (typed writer)" },
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

// ── Safari extension ─────────────────────────────────────────────────────
// Optional: the extension works with defaults if this is never run.

async function configureSafari(): Promise<void> {
  const env = readEnv();
  const port = env.PORT || "3000";

  p.note(
    `Pairing endpoint (popup "Server address"): ws://127.0.0.1:${port}/safari-extension\n` +
    `Generate a one-time pairing code with:      bun run safari:code`,
    "PocketHook Safari extension",
  );

  const level = await p.select({
    message: "Permission level for the paired extension",
    initialValue: env.SAFARI_PERMISSION_LEVEL || "confirm",
    options: [
      { value: "confirm", label: "Confirm", hint: "clicks with external effects ask the user first (default)" },
      { value: "autonomous", label: "Autonomous", hint: "votes, follows, submits without asking; payments, deletions and account changes still ask" },
      { value: "readonly", label: "Read-only", hint: "navigate, inspect and capture only; click and fill disabled" },
    ],
  });
  if (p.isCancel(level)) cancelled();
  env.SAFARI_PERMISSION_LEVEL = String(level);

  const captures = await p.text({
    message: `Public base URL for serving captures (Enter to keep, "-" to clear)`,
    initialValue: env.SAFARI_CAPTURES_BASE_URL || "",
    placeholder: `empty = http://127.0.0.1:${port} (local only)`,
    validate: (value) => {
      if (!value || value === "-") return;
      try { new URL(value); } catch { return `Must be a valid URL, or "-" to clear.`; }
    },
  });
  if (p.isCancel(captures)) cancelled();
  const capturesValue = String(captures ?? "").trim();
  if (capturesValue === "-") delete env.SAFARI_CAPTURES_BASE_URL;
  else if (capturesValue) env.SAFARI_CAPTURES_BASE_URL = capturesValue;

  writeEnv(env);
  p.log.success(`Saved to .env — SAFARI_PERMISSION_LEVEL=${env.SAFARI_PERMISSION_LEVEL}${env.SAFARI_CAPTURES_BASE_URL ? `, SAFARI_CAPTURES_BASE_URL=${env.SAFARI_CAPTURES_BASE_URL}` : ""}`);
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
} else if (process.argv.includes("--safari")) {
  (async () => {
    console.clear();
    console.log(BANNER);
    p.intro(pc.bgBlue(pc.black(" safari ")));
    await configureSafari();
    p.outro(pc.green("Done!") + " Restart the server to apply changes: bun run service restart");
  })().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (process.argv.includes("--memory")) {
  (async () => {
    console.clear();
    console.log(BANNER);
    p.intro(pc.bgYellow(pc.black(" memory ")));

    const env = readEnv();

    const maxHistory = await p.text({
      message: "Short-term window size (messages kept in RAM per session)",
      initialValue: env.MAX_HISTORY || "50",
      placeholder: "50",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 2000) return "Must be an integer between 1 and 2000.";
      },
    });
    if (p.isCancel(maxHistory)) cancelled();
    env.MAX_HISTORY = String(maxHistory);

    if (env.VECTOR_MEMORY === "true") {
      const maxRecall = await p.text({
        message: "Memories to recall per turn (semantic search)",
        initialValue: env.MAX_RECALL || "5",
        placeholder: "5",
        validate: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 0 || n > 50) return "Must be an integer between 0 and 50.";
        },
      });
      if (p.isCancel(maxRecall)) cancelled();
      env.MAX_RECALL = String(maxRecall);
    } else {
      p.log.info(pc.dim("Semantic memory disabled — recall settings skipped. Run `bun run setup` to enable it."));
    }

    writeEnv(env);
    p.outro(pc.green("Done!") + " Restart the server to apply.");
  })().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else {
  setup().catch((err) => {
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
