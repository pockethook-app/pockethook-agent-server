import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Model, Api, Message } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Config } from "./config.js";
import { updateEnvFile } from "./config.js";
import { createRespondTools, createRunCodeJobTool, type PocketHookResponse } from "./tools.js";
import { FAKE_ACK_TEXT } from "./sessions.js";
import { logger } from "./logger.js";

/**
 * Resolve a Model object from provider + model ID.
 */
function resolveModelFor(provider: string, modelId: string, baseUrl?: string): Model<Api> {
  try {
    const model = getModel(provider as any, modelId as any);
    if (model) return model;
  } catch {}

  try {
    const models = getModels(provider as any);
    const found = models.find((m) => m.id === modelId);
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
    id: modelId,
    name: modelId,
    provider,
    api: apiMap[provider] || "openai-completions",
    baseUrl: baseUrl || defaultBaseUrls[provider] || "",
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    maxTokens: 8192,
    contextWindow: (provider === "ollama" || provider === "lm-studio") ? 32768 : 128000,
    maxOutputTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    supportedInputs: ["text"],
  } as Model<Api>;
}

function resolveModel(config: Config): Model<Api> {
  return resolveModelFor(config.llmProvider, config.llmModel, config.llmBaseUrl);
}

let cachedModel: Model<Api> | null = null;
let cachedQuickModel: Model<Api> | null = null;

/**
 * The LLM run was cut by a provider error (5xx, overload, timeout) and could
 * not be completed even after resume attempts. Callers must treat the run as
 * failed — the chat endpoint reports it, the job runner marks the job failed
 * so its retry machinery can re-run it — instead of passing partial work off
 * as a final answer.
 */
export class LLMInterruptedError extends Error {
  constructor(providerError: string) {
    super(`LLM run interrupted by provider error: ${providerError}`);
    this.name = "LLMInterruptedError";
  }
}

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
    let oauth;
    if (config.llmProvider === "github-copilot") {
      const { githubCopilotProvider } = await import("@earendil-works/pi-ai/providers/github-copilot");
      oauth = githubCopilotProvider().auth.oauth;
    } else {
      const { openaiCodexProvider } = await import("@earendil-works/pi-ai/providers/openai-codex");
      oauth = openaiCodexProvider().auth.oauth;
    }
    if (!oauth) throw new Error(`Provider '${config.llmProvider}' has no OAuth flow`);

    const creds = await oauth.refresh({
      type: "oauth",
      access: config.llmApiKey,
      refresh: config.oauthRefreshToken,
      expires: config.oauthTokenExpires ?? 0,
    });

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
 * Resolve the API key for the quick model. Same provider as the main model →
 * reuse its credentials (including OAuth auto-refresh, no separate login);
 * different provider → its own key (local providers accept a placeholder).
 */
async function ensureFreshQuickApiKey(config: Config): Promise<string> {
  if (config.llmQuickProvider === config.llmProvider) {
    return ensureFreshApiKey(config);
  }
  return config.llmQuickApiKey || config.llmQuickProvider;
}

/**
 * Quick single-turn prompt — no tools, no agent, minimal tokens.
 * Used for classification, entity extraction, and other lightweight LLM tasks.
 * Runs on the quick model (llmQuick* config), which defaults to the main
 * chat model with reasoning off.
 */
export async function quickPrompt(config: Config, prompt: string, maxTokens: number = 100): Promise<string> {
  if (!cachedQuickModel) {
    cachedQuickModel = resolveModelFor(
      config.llmQuickProvider,
      config.llmQuickModel,
      config.llmQuickBaseUrl ?? (config.llmQuickProvider === config.llmProvider ? config.llmBaseUrl : undefined),
    );
    logger.info(`Quick LLM resolved: ${cachedQuickModel.provider}/${cachedQuickModel.id} (api: ${cachedQuickModel.api}, reasoning: ${config.llmQuickReasoning})`);
  }
  const model = cachedQuickModel;

  const apiKey = await ensureFreshQuickApiKey(config);

  // One retry on stream errors (provider 5xx etc.); tool-free, so retrying is safe.
  for (let attempt = 0; attempt < 2; attempt++) {
    const agent = new Agent({
      initialState: {
        systemPrompt: "You are a JSON classifier. Respond ONLY with valid JSON, no other text.",
        model,
        tools: [],
        messages: [],
        thinkingLevel: config.llmQuickReasoning,
      },
      getApiKey: async () => apiKey,
    });

    await agent.prompt(prompt);

    if (agent.state.errorMessage) {
      logger.warn(`quickPrompt turn ended with stream error${attempt === 0 ? ", retrying" : ""}`, { error: agent.state.errorMessage });
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
    }

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
    logger.info(`LLM resolved: ${cachedModel.provider}/${cachedModel.id} (api: ${cachedModel.api}, reasoning: ${config.llmReasoning})`);
  }
  const model = cachedModel;

  const apiKey = await ensureFreshApiKey(config);

  // Capture the respond tool's output. run_code_job emits an ack through the
  // same callback so the "create job + respond" orchestration happens in a
  // single tool call.
  let pockethookResponses: PocketHookResponse[] | null = null;
  const onRespond = (responses: PocketHookResponse[]) => {
    pockethookResponses = responses;
  };
  const respondTools = createRespondTools(onRespond);
  const runCodeJobTool = createRunCodeJobTool(config.workingDir, onRespond);

  const allTools = [...tools, ...respondTools, runCodeJobTool];

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

  const makeAgent = () => new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: allTools,
      messages: [...messages.slice(0, -1)],
      thinkingLevel: config.llmReasoning,
    },
    getApiKey: async () => apiKey,
  });

  let agent = makeAgent();
  // Boundary so the fallback below cannot pick up text from prior turns.
  let turnStartIdx = agent.state.messages.length;

  // Stream failures (timeout, rate limit, provider 5xx) don't throw: the agent
  // ends the turn with stopReason "error" and the reason in state.errorMessage.
  // Retry with a fresh agent (clean transcript), but only while the failed
  // attempt executed no tools — otherwise side effects could run twice.
  const MAX_STREAM_RETRIES = 2;
  for (let attempt = 0; ; attempt++) {
    await agent.prompt(userText);
    const streamError = agent.state.errorMessage;
    if (pockethookResponses || !streamError) break;

    const attemptRanTools = agent.state.messages
      .slice(turnStartIdx)
      .some((m) => m.role === "assistant"
        && (m as AssistantMessage).content.some((c) => c.type === "toolCall"));
    if (attempt >= MAX_STREAM_RETRIES || attemptRanTools) {
      logger.warn("LLM turn ended with stream error, not retrying", {
        error: streamError,
        attempt: attempt + 1,
        ranTools: attemptRanTools,
      });
      break;
    }

    logger.warn(`LLM stream error, retrying (${attempt + 1}/${MAX_STREAM_RETRIES})`, { error: streamError });
    await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    agent = makeAgent();
    turnStartIdx = agent.state.messages.length;
  }

  // Turn interrupted mid-work by a provider error (tools already ran, or the
  // fresh retries above are exhausted). Ask the model to RESUME the task —
  // tools allowed — instead of forcing a premature reply: the transcript is
  // preserved, so tool calls that already succeeded are not repeated.
  if (!pockethookResponses && agent.state.errorMessage) {
    const RESUME_ATTEMPTS = 2;
    for (let attempt = 0; attempt < RESUME_ATTEMPTS && !pockethookResponses; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      logger.warn(`LLM turn interrupted by stream error, asking it to resume (${attempt + 1}/${RESUME_ATTEMPTS})`);
      try {
        await agent.prompt(
          "Your previous turn was interrupted by a temporary provider error mid-task. " +
          "Continue the task exactly where you left off — do not repeat work that already succeeded. " +
          "When the task is genuinely finished, call exactly ONE respond_* tool with the final answer.",
        );
      } catch (err) {
        logger.warn("Resume attempt failed", { error: err instanceof Error ? err.message : String(err) });
      }
      if (!agent.state.errorMessage) break; // ended cleanly; a missing respond_* is handled below
    }

    if (!pockethookResponses && agent.state.errorMessage) {
      // Still failing after resume attempts — surface an honest failure so the
      // chat endpoint can report it and the job runner can mark the job failed
      // and retry, instead of passing partial work off as a final answer.
      throw new LLMInterruptedError(agent.state.errorMessage);
    }
  }

  // Codex-family models (gpt-5.x-codex) sometimes end a turn after chained
  // tool calls without ever calling respond_*. Nudge once before falling
  // back, so the user gets a properly-typed reply (buttons/shortcut/image/etc.)
  // instead of plain text or a generic error. Only reached after a turn that
  // ended cleanly — interrupted turns resume above instead.
  if (!pockethookResponses) {
    logger.warn("LLM finished without respond_*, requesting one via steering prompt");
    try {
      await agent.prompt(
        "Your previous turn ended without sending a reply to the user. " +
        "Call exactly ONE respond_* tool NOW with the answer: respond_text for a normal message, " +
        "respond_buttons for choices, respond_image for an image URL, respond_shortcut for an iOS Shortcut, " +
        "respond_html for rich HTML, or respond_sequence to chain steps. Do not call any other tool first."
      );
    } catch (err) {
      logger.warn("Steering retry failed", { error: err instanceof Error ? err.message : String(err) });
    }
    if (agent.state.errorMessage) {
      logger.warn("Steering turn ended with stream error", { error: agent.state.errorMessage });
    }
  }

  if (pockethookResponses) {
    return pockethookResponses;
  }

  // Fallback: extract text from an assistant message produced in THIS turn only.
  // Walking past turnStartIdx would surface stale text from a previous turn,
  // which the user perceives as the agent "repeating" itself.
  const allMessages = agent.state.messages;
  for (let i = allMessages.length - 1; i >= turnStartIdx; i--) {
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

  // No usable output at all. If the last attempt died on a provider error,
  // report that honestly rather than blaming the model's tool support.
  if (agent.state.errorMessage) {
    throw new LLMInterruptedError(agent.state.errorMessage);
  }

  const turnAssistantCount = allMessages.slice(turnStartIdx).filter((m) => m?.role === "assistant").length;
  logger.warn(
    `LLM produced no usable response (tool call not made, no fallback text in current turn; assistant msgs this turn: ${turnAssistantCount})`,
  );
  return [{ msg: "I processed your request but have no text response. The model may not support tool calling properly." }];
}
