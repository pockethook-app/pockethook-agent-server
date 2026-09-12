import { expect, test } from "bun:test";
import { chat, quickPrompt } from "../src/llm.js";
import type { Config } from "../src/config.js";

function sse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

test("chat executes GPT-6 respond_text and quickPrompt streams Fable using pi 0.85", async () => {
  const requests: { path: string; body: any }[] = [];
  let openaiCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = await request.json();
      requests.push({ path, body });
      if (path === "/v1/responses") {
        const output = openaiCalls++ === 0 ? [{
          type: "function_call", id: "fc_test", call_id: "call_test", name: "respond_text",
          arguments: JSON.stringify({ text: "Ready" }), status: "completed",
        }] : [];
        return sse([
          { type: "response.created", response: { id: "resp_test" } },
          ...output.flatMap((item, output_index) => [
            { type: "response.output_item.added", output_index, item: { ...item, arguments: "" } },
            { type: "response.output_item.done", output_index, item },
          ]),
          { type: "response.completed", response: {
            id: "resp_test", status: "completed", output,
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          } },
        ]);
      }
      if (path === "/v1/messages") {
        return sse([
          { type: "message_start", message: {
            id: "msg_test", type: "message", role: "assistant", model: "claude-fable-5-1",
            content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
          } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"ok":true}' } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ]);
      }
      return new Response("Unexpected test endpoint", { status: 400 });
    },
  });
  try {
    // Only fields consumed by chat/quickPrompt; never load deployment .env credentials.
    const config = {
      llmProvider: "openai", llmModel: "gpt-6-astra", llmApiKey: "test-key",
      llmBaseUrl: `${server.url.origin}/v1`, llmReasoning: "max",
      llmQuickProvider: "anthropic", llmQuickModel: "claude-fable-5-1", llmQuickApiKey: "test-key",
      llmQuickBaseUrl: server.url.origin, llmQuickReasoning: "low", workingDir: process.cwd(),
    } as Config;
    const result = await chat(config, "Reply using respond_text.", [{ role: "user", content: "Hello", timestamp: 0 }], [], [
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
    ]);
    expect(result).toEqual([{ msg: "Ready", url: undefined }]);
    expect(await quickPrompt(config, "Classify this.")).toBe('{"ok":true}');
    expect(openaiCalls).toBe(2);
    expect(requests[0]!.body.model).toBe("gpt-6-astra");
    expect(requests[0]!.body.reasoning.effort).toBe("max");
    expect(JSON.stringify(requests[0]!.body.input)).toContain("aW1hZ2U=");
    expect(requests[1]!.body.input.some((item: any) => item.type === "function_call_output")).toBe(true);
    const quick = requests.find((request) => request.path === "/v1/messages")!.body;
    expect(quick.model).toBe("claude-fable-5-1");
    expect(quick.messages.at(-1).output_config.effort).toBe("low");
  } finally {
    server.stop(true);
  }
});
