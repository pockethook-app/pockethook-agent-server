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
import { loadPermissions } from "./permissions.js";
import { initJobs, startScheduler, hasUndeliveredResults, getUndeliveredResults, markDelivered } from "./jobs.js";

const config = loadConfig();
const permissions = loadPermissions(process.env.TOOLS);
const tools = createTools(config.workingDir, permissions);

console.log(`Tools: [${permissions.tools.join(", ")}]`);
console.log(`Working dir: ${config.workingDir}`);
console.log(`Boundary: ${permissions.enforceWorkingDir ? "enforced" : "open"}`);
if (permissions.shell.blockedCommands.length > 0) {
  console.log(`Shell blocked: ${permissions.shell.blockedCommands.length} commands, ${permissions.shell.blockedPatterns.length} patterns`);
}
if (permissions.filesystem.blockedPaths.length > 0) {
  console.log(`Filesystem blocked: ${permissions.filesystem.blockedPaths.join(", ")}`);
}

// Initialize jobs system and scheduler
initJobs();

// Chat function for prompt-type jobs (agent processes the prompt)
const jobChatFn = async (prompt: string): Promise<string> => {
  const jobMessages = [{ role: "user" as const, content: prompt, timestamp: Date.now() }];
  const responses = await chat(config, getSystemPrompt(config.agentName), jobMessages, tools);
  return responses.map((r) => r.msg).join("\n");
};

startScheduler(config.workingDir, jobChatFn);

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

    if (req.method === "GET" && url.pathname === "/jobs") {
      return new Response(hasUndeliveredResults() ? "true" : "false", { status: 200 });
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

    // Inject completed job results when polling triggers a fetch
    const undelivered = getUndeliveredResults();
    if (undelivered.length > 0 && chatInput.toLowerCase().includes("fetchpendingtask")) {
      const jobContext = undelivered.map((j) => {
        const status = j.status === "completed" ? "completed" : "failed";
        const output = j.result || j.error || "No output";
        return `[Job #${j.id} "${j.name}" ${status} at ${new Date(j.completed_at!).toISOString()}]\n${output}`;
      }).join("\n\n");

      chatInput += `\n\n--- Completed Background Jobs ---\n${jobContext}`;
      markDelivered(undelivered.map((j) => j.id));
    }

    addUserMessage(sessionId, chatInput);

    try {
      // Build context: recent messages + relevant memories from FTS5
      const messages = buildContext(sessionId, chatInput);
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
