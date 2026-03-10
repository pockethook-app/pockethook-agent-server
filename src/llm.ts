import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, getModels } from "@mariozechner/pi-ai";
import type { AssistantMessage, Model, Api, Message } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Config } from "./config.js";
import { updateEnvFile } from "./config.js";
import { createRespondTool, type FlowMateResponse } from "./tools.js";

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
  };

  return {
    id: config.llmModel,
    provider: config.llmProvider,
    api: apiMap[config.llmProvider] || "openai-completions",
    contextWindow: 128000,
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

  console.log(`🔄 ${config.llmProvider} token expired, refreshing...`);
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
    console.log(`✓ Token refreshed.`);
    return creds.access;
  } catch (err) {
    console.error("✗ Token refresh failed:", err instanceof Error ? err.message : err);
    return config.llmApiKey;
  }
}

/**
 * Run the agent with tools. Returns FlowMate-formatted responses.
 */
export async function chat(
  config: Config,
  systemPrompt: string,
  messages: Message[],
  tools: AgentTool<any>[],
): Promise<FlowMateResponse[]> {
  if (!cachedModel) {
    cachedModel = resolveModel(config);
    console.log(`LLM: ${cachedModel.provider}/${cachedModel.id} (api: ${cachedModel.api})`);
  }

  const apiKey = await ensureFreshApiKey(config);

  // Capture the respond tool's output
  let flowmateResponses: FlowMateResponse[] | null = null;
  const respondTool = createRespondTool((responses) => {
    flowmateResponses = responses;
  });

  const allTools = [...tools, respondTool];

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
  if (flowmateResponses) {
    return flowmateResponses;
  }

  // Fallback: extract text from the last assistant message
  const allMessages = agent.state.messages;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const msg = allMessages[i];
    if (!msg || msg.role !== "assistant") continue;
    const text = (msg as AssistantMessage).content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
    if (text) {
      return [{ msg: text }];
    }
  }

  return [{ msg: "I processed your request but have no text response." }];
}
