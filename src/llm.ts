import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, getModels } from "@mariozechner/pi-ai";
import type { AssistantMessage, Model, Api, Message } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { updateEnvFile } from "./config.js";
import { createRespondTool, createRunCodeJobTool, type PocketHookResponse } from "./tools.js";
import { FAKE_ACK_TEXT } from "./sessions.js";
import { logger } from "./logger.js";

/**
 * Resolve a Model object from provider + model ID.
 */
function resolveModel(config: Config): Model<Api> {
  try {
    const model = getModel(config.llmProvider as any, config.llmModel as any);
    if (model) return model;
  } catch {}

  try {
    const models = getModels(config.llmProvider as any);
    const found = models.find((m) => m.id === config.llmModel);
    if (found) return found;
  } catch {}

  const apiMap: Record<string, Api> = {
    anthropic: "anthropic-messages",
    openai: "openai-completions",
    "openai-codex": "openai-codex-responses",
    "github-copilot": "anthropic-messages",
    google: "google-generative-ai",
    mistral: "mistral-conversations",
    groq: "openai-completions",
    xai: "openai-completions",
    openrouter: "openai-completions",
    cerebras: "openai-completions",
    ollama: "openai-completions",
    "lm-studio": "openai-completions",
  };

  const defaultBaseUrls: Record<string, string> = {
    ollama: "http://localhost:11434/v1",
    "lm-studio": "http://localhost:1234/v1",
  };

  return {
    id: config.llmModel,
    name: config.llmModel,
    provider: config.llmProvider,
    api: apiMap[config.llmProvider] || "openai-completions",
    baseUrl: config.llmBaseUrl || defaultBaseUrls[config.llmProvider] || "",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    maxTokens: 8192,
    contextWindow: (config.llmProvider === "ollama" || config.llmProvider === "lm-studio") ? 32768 : 128000,
    maxOutputTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    supportedInputs: ["text"],
  } as Model<Api>;
}

let cachedModel: Model<Api> | null = null;

const OAUTH_PROVIDERS = ["openai-codex", "github-copilot"];

/**
 * Ensure fresh API key (auto-refresh for OAuth providers).
 */
async function ensureFreshApiKey(config: Config): Promise<string> {
  if (!OAUTH_PROVIDERS.includes(config.llmProvider) || !config.oauthRefreshToken) {
    return config.llmApiKey;
  }

  const buffer = 5 * 60 * 1000;
  if (config.oauthTokenExpires && Date.now() < config.oauthTokenExpires - buffer) {
    return config.llmApiKey;
  }

  logger.info(`${config.llmProvider} token expired, refreshing...`);
  try {
    let creds: { access: string; refresh: string; expires: number };

    if (config.llmProvider === "github-copilot") {
      const { refreshGitHubCopilotToken } = await import("@mariozechner/pi-ai/oauth");
      creds = await refreshGitHubCopilotToken(config.oauthRefreshToken);
    } else {
      const { refreshOpenAICodexToken } = await import("@mariozechner/pi-ai/oauth");
      creds = await refreshOpenAICodexToken(config.oauthRefreshToken);
    }

    config.llmApiKey = creds.access;
    config.oauthRefreshToken = creds.refresh;
    config.oauthTokenExpires = creds.expires;
    updateEnvFile({
      LLM_API_KEY: creds.access,
      OAUTH_REFRESH_TOKEN: creds.refresh,
      OAUTH_TOKEN_EXPIRES: String(creds.expires),
    });
    logger.info("Token refreshed successfully");
    return creds.access;
  } catch (err) {
    logger.error("Token refresh failed", { error: err instanceof Error ? err.message : String(err) });
    return config.llmApiKey;
  }
}

/**
 * Quick single-turn prompt — no tools, no agent, minimal tokens.
 * Used for classification, entity extraction, and other lightweight LLM tasks.
 */
export async function quickPrompt(config: Config, prompt: string, maxTokens: number = 100): Promise<string> {
  if (!cachedModel) {
    cachedModel = resolveModel(config);
  }

  const apiKey = await ensureFreshApiKey(config);

  const agent = new Agent({
    initialState: {
      systemPrompt: "You are a JSON classifier. Respond ONLY with valid JSON, no other text.",
      model: cachedModel,
      tools: [],
      messages: [],
    },
    getApiKey: async () => apiKey,
  });

  const result = await agent.prompt(prompt);

  // Extract text from the last assistant message
  const messages = agent.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    if (text) return text;
  }

  return "";
}

/**
 * Run the agent with tools. Returns PocketHook-formatted responses.
 */
export async function chat(
  config: Config,
  systemPrompt: string,
  messages: Message[],
  tools: AgentTool<any>[],
): Promise<PocketHookResponse[]> {
  if (!cachedModel) {
    cachedModel = resolveModel(config);
    logger.info(`LLM resolved: ${cachedModel.provider}/${cachedModel.id} (api: ${cachedModel.api})`);
  }

  const apiKey = await ensureFreshApiKey(config);

  // Capture the respond tool's output. run_code_job emits an ack through the
  // same callback so the "create job + respond" orchestration happens in a
  // single tool call.
  let pockethookResponses: PocketHookResponse[] | null = null;
  const onRespond = (responses: PocketHookResponse[]) => {
    pockethookResponses = responses;
  };
  const respondTool = createRespondTool(onRespond);
  const runCodeJobTool = createRunCodeJobTool(config.workingDir, onRespond);

  const allTools = [...tools, respondTool, runCodeJobTool];

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: cachedModel,
      tools: allTools,
      messages: [...messages.slice(0, -1)],
    },
    getApiKey: async () => apiKey,
  });

  // Get last user message text
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    throw new Error("Last message must be a user message");
  }

  const userText = typeof lastMessage.content === "string"
    ? lastMessage.content
    : lastMessage.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("");

  await agent.prompt(userText);

  // If the LLM called respond tool, use that
  if (pockethookResponses) {
    return pockethookResponses;
  }

  // Fallback: extract text from the last REAL assistant message
  // (skip the synthetic ack message injected for memory context)
  const allMessages = agent.state.messages;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("")
      .trim();
    if (text && text !== FAKE_ACK_TEXT) {
      logger.warn("LLM did not call respond tool, using fallback text");
      return [{ msg: text }];
    }
  }

  logger.warn("LLM produced no usable response (tool call not made, no fallback text)");
  return [{ msg: "I processed your request but have no text response. The model may not support tool calling properly." }];
}
