import { describe, expect, test } from "bun:test";
import { setMainProvider } from "../src/setup-provider.js";
import { resolveModelFor } from "../src/llm-models.js";

describe("provider endpoint isolation", () => {
  test("switching Ollama to Codex cannot route Sol or the inherited Luna endpoint to Ollama", () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: "ollama", LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      LLM_QUICK_PROVIDER: "openai-codex", LLM_QUICK_MODEL: "gpt-5.6-luna",
    };
    setMainProvider(env, "openai-codex");
    expect(env.LLM_BASE_URL).toBeUndefined();
    for (const id of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-6-astra"]) {
      expect(resolveModelFor(env.LLM_PROVIDER!, id, env.LLM_BASE_URL).baseUrl)
        .toBe("https://chatgpt.com/backend-api");
    }
  });

  test("switching remote providers clears the previous custom endpoint", () => {
    const env: Record<string, string> = { LLM_PROVIDER: "openai", LLM_BASE_URL: "https://example.invalid/v1" };
    setMainProvider(env, "anthropic");
    expect(resolveModelFor(env.LLM_PROVIDER!, "claude-fable-5-1", env.LLM_BASE_URL).baseUrl)
      .toBe("https://api.anthropic.com");
  });

  test("switching local providers allows the new provider's default", () => {
    const env: Record<string, string> = { LLM_PROVIDER: "ollama", LLM_BASE_URL: "http://localhost:11434/v1" };
    setMainProvider(env, "lm-studio");
    expect(resolveModelFor(env.LLM_PROVIDER!, "local", env.LLM_BASE_URL).baseUrl)
      .toBe("http://localhost:1234/v1");
  });

  test("reauthenticating or changing model on the same provider preserves intentional overrides", () => {
    const env: Record<string, string> = { LLM_PROVIDER: "openai-codex", LLM_BASE_URL: "https://example.invalid/proxy" };
    setMainProvider(env, "openai-codex");
    expect(env.LLM_BASE_URL).toBe("https://example.invalid/proxy");
  });

  test("does not alter credentials, model selections, or an independent quick endpoint", () => {
    const env: Record<string, string> = {
      LLM_PROVIDER: "ollama", LLM_BASE_URL: "http://localhost:11434/v1",
      LLM_API_KEY: "test-only", LLM_MODEL: "existing-model", OAUTH_REFRESH_TOKEN: "test-only-refresh",
      LLM_QUICK_PROVIDER: "lm-studio", LLM_QUICK_MODEL: "local", LLM_QUICK_BASE_URL: "http://localhost:1234/v1",
    };
    const expected: Record<string, string> = { ...env, LLM_PROVIDER: "openai-codex" };
    delete expected.LLM_BASE_URL;
    setMainProvider(env, "openai-codex");
    expect(env).toEqual(expected);
  });
});
