import { describe, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import { getModels, streamSimple } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels, type Context, type ThinkingLevel } from "@earendil-works/pi-ai";
import { resolveModelFor } from "../src/llm-models.js";

const cases = [
  ["openai", "gpt-6-astra", "openai-responses"],
  ["openai-codex", "gpt-6-astra", "openai-codex-responses"],
  ["anthropic", "claude-fable-5-1", "anthropic-messages"],
  ["github-copilot", "claude-fable-5.1", "anthropic-messages"],
] as const;

// Fake, unsigned token: the Codex adapter only needs an account claim to build a request.
const fakeToken = `test.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }))}.test`;
const context: Context = {
  systemPrompt: "Use respond_text.",
  messages: [{ role: "user", timestamp: 0, content: [
    { type: "text", text: "Describe this image." },
    { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
  ] }],
  tools: [{ name: "respond_text", description: "Reply", parameters: Type.Object({ text: Type.String() }) }],
};

describe("latest model resolution", () => {
  for (const [provider, id, api] of cases) {
    test(`${provider}/${id} retains its transport, vision and reasoning`, () => {
      const model = resolveModelFor(provider, id);
      expect(model.api).toBe(api);
      expect(model.baseUrl).toStartWith("https://");
      expect(model.reasoning).toBe(true);
      expect(model.input).toContain("image");
      expect(model.maxTokens).toBe(128_000);
      expect(getSupportedThinkingLevels(model)).toContain("max");
      expect(getSupportedThinkingLevels(model)).not.toContain("off");
    });
  }

  test("uses the upstream Fable definition without discarding compatibility flags", () => {
    expect(resolveModelFor("anthropic", "claude-fable-5-1"))
      .toEqual(getModels("anthropic").find((model) => model.id === "claude-fable-5-1")!);
  });

  test("endpoint overrides do not mutate the shared catalog", () => {
    const original = resolveModelFor("anthropic", "claude-fable-5-1");
    const overridden = resolveModelFor("anthropic", "claude-fable-5-1", "http://localhost:1234");
    expect(overridden.baseUrl).toBe("http://localhost:1234");
    expect(overridden.compat).toEqual(original.compat);
    expect(resolveModelFor("anthropic", "claude-fable-5-1").baseUrl).toBe(original.baseUrl);
    expect(resolveModelFor("openai", "gpt-6-astra", "http://localhost:1234/v1").baseUrl)
      .toBe("http://localhost:1234/v1");
  });

  test("retains local/custom models and does not invent GPT-6 aliases", () => {
    expect(resolveModelFor("ollama", "my-local-model")).toMatchObject({
      api: "openai-completions", baseUrl: "http://localhost:11434/v1", reasoning: false,
    });
    expect(resolveModelFor("lm-studio", "local").baseUrl).toBe("http://localhost:1234/v1");
    expect(resolveModelFor("custom", "model", "https://example.invalid/v1").baseUrl)
      .toBe("https://example.invalid/v1");
    expect(resolveModelFor("openai", "gpt-6").reasoning).toBe(false);
    expect(resolveModelFor("openai", "gpt-4.1-mini")).toEqual(
      getModels("openai").find((model) => model.id === "gpt-4.1-mini")!,
    );
  });
});

describe("real pi request serialization (no network)", () => {
  for (const [provider, id, api] of cases) {
    for (const reasoning of [undefined, "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      test(`${provider}/${id}: ${reasoning ?? "off/default"}`, async () => {
        let payload: any;
        let fetchCalls = 0;
        const result = await streamSimple(resolveModelFor(provider, id), context, {
          apiKey: provider === "openai-codex" ? fakeToken : "test-key",
          reasoning: reasoning as ThinkingLevel | undefined,
          transport: "sse",
          env: {},
          onPayload: (body) => {
            payload = body;
            throw new Error("captured test payload");
          },
          fetch: (async () => { fetchCalls++; throw new Error("Network forbidden"); }) as unknown as typeof fetch,
        }).result();
        expect(result.errorMessage).toContain("captured test payload");
        expect(fetchCalls).toBe(0);
        expect(payload.model).toBe(id);
        expect(payload.stream).toBe(true);
        expect(payload.tools.some((tool: any) => tool.name === "respond_text")).toBe(true);
        expect(JSON.stringify(payload)).toContain("aW1hZ2U=");
        if (api === "anthropic-messages") {
          expect(payload.thinking?.type).not.toBe("disabled");
          if (reasoning) {
            expect(payload.thinking.type).toBe("adaptive");
            const effort = provider === "anthropic"
              ? payload.messages.at(-1).output_config.effort // pi's per-turn effort marker
              : payload.output_config.effort;
            expect(effort).toBe(reasoning === "minimal" ? "low" : reasoning);
          }
        } else {
          expect(payload.reasoning?.effort).not.toBe("none");
          if (reasoning) expect(payload.reasoning.effort).toBe(reasoning === "minimal" ? "low" : reasoning);
        }
      });
    }
  }
});
