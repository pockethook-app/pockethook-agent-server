import { parseRequest, extractBearerToken, response, responses, text, toResponse } from "@flow-mate/sdk";
import { loadConfig, getSystemPrompt } from "./config.js";
import { chat } from "./llm.js";
import { createTools } from "./tools.js";
import {
  buildContext,
  addUserMessage,
  addAssistantMessage,
  trimHistory,
  cleanExpiredSessions,
} from "./sessions.js";
import { memoryStats } from "./memory.js";

const config = loadConfig();
const tools = createTools(config.workingDir, config.tools);

console.log(`Tools: [${tools.map((t) => t.name).join(", ")}]`);
console.log(`Working dir: ${config.workingDir}`);

// Clean expired sessions periodically
setInterval(() => {
  const cleaned = cleanExpiredSessions(config.sessionTtlMs);
  if (cleaned > 0) {
    console.log(`Cleaned ${cleaned} expired session(s)`);
  }
}, 5 * 60 * 1000);

Bun.serve({
  port: config.port,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("true", { status: 200 });
    }

    if (req.method !== "POST" || url.pathname !== "/") {
      return new Response("Not Found", { status: 404 });
    }

    const token = extractBearerToken(req.headers.get("Authorization"));
    if (token !== config.authToken) {
      return new Response("Unauthorized", { status: 401 });
    }

    let sessionId: string;
    let chatInput: string;
    try {
      const parsed = parseRequest(await req.json());
      sessionId = parsed.sessionId;
      chatInput = parsed.chatInput;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bad Request";
      return new Response(message, { status: 400 });
    }

    console.log(`[${new Date().toISOString()}] ${sessionId.slice(0, 8)}: ${chatInput.slice(0, 100)}`);

    addUserMessage(sessionId, chatInput);

    try {
      // Build context: recent messages + relevant memories from FTS5
      const messages = buildContext(sessionId, chatInput);
      console.log(`[context] ${sessionId.slice(0, 8)}: ${messages.length} messages`);
      for (const m of messages) {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        console.log(`  [${m.role}] ${text.slice(0, 120)}`);
      }
      const flowmateResponses = await chat(config, getSystemPrompt(config.agentName), messages, tools);

      // Store summary in session history
      const summaryText = flowmateResponses.map((r) => r.msg).join("\n");
      addAssistantMessage(sessionId, {
        role: "assistant",
        content: [{ type: "text", text: summaryText }],
        api: "anthropic-messages" as any,
        provider: config.llmProvider,
        model: config.llmModel,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      trimHistory(sessionId, config.maxHistory);

      // Build FlowMate SDK response — pass all fields (msg, shortcut, data, url)
      return toResponse(
        responses(
          flowmateResponses.map((r) => ({
            msg: r.msg,
            shortcut: r.shortcut,
            data: r.data,
            url: r.url,
          })),
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM request failed";
      console.error(`LLM error for ${sessionId.slice(0, 8)}: ${message}`);
      return toResponse(text("Sorry, I couldn't process your request. Please try again."));
    }
  },
});

console.log(`flowmate-agent-server running on http://localhost:${config.port}`);
console.log(`LLM provider: ${config.llmProvider}, model: ${config.llmModel}`);
