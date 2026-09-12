import { getModels, type BuiltinProvider } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Temporary catalog supplement: pi 0.85.0 has Fable 5.1, but not GPT-6 Astra.
 * Prefer pi's definition once it ships one. Do not guess aliases or snapshots.
 * API metadata: https://developers.openai.com/api/docs/models/gpt-6-astra
 * Codex uses its own transport and a conservative 272K default context window.
 */
function supplementalModel(provider: string, modelId: string): Model<Api> | undefined {
  if (modelId !== "gpt-6-astra" || (provider !== "openai" && provider !== "openai-codex")) return;

  return {
    id: modelId,
    name: "GPT-6 Astra",
    provider,
    api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
    baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: provider === "openai" ? 1_050_000 : 272_000,
    maxTokens: 128_000,
    // API-equivalent estimates, not subscription billing. Includes long-context pricing.
    cost: {
      input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5,
      tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
    },
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
  };
}

/** Resolve catalog transport, vision and reasoning metadata before falling back to a custom model. */
export function resolveModelFor(provider: string, modelId: string, baseUrl?: string): Model<Api> {
  let model: Model<Api> | undefined;
  try {
    model = getModels(provider as BuiltinProvider).find((candidate) => candidate.id === modelId);
  } catch {}
  model ??= supplementalModel(provider, modelId);
  if (model) return baseUrl ? { ...model, baseUrl } : model;

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
    input: ["text"],
    maxTokens: 8192,
    contextWindow: (provider === "ollama" || provider === "lm-studio") ? 32768 : 128000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
