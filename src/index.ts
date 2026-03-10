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

// Chat function for prompt-type jobs — stores full FlowMate response as JSON
const jobChatFn = async (prompt: string): Promise<string> => {
  const jobMessages = [{ role: "user" as const, content: prompt, timestamp: Date.now() }];
  const result = await chat(config, getSystemPrompt(config.agentName), jobMessages, tools);
  return JSON.stringify(result);
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
      const pending = hasUndeliveredResults();
      console.log(`[${new Date().toISOString()}] GET /jobs → ${pending}`);
      return new Response(pending ? "true" : "false", { status: 200 });
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

    // Direct delivery: if fetchPendingTasks and there are completed jobs, respond immediately without LLM
    const undelivered = getUndeliveredResults();
    if (undelivered.length > 0 && chatInput.toLowerCase().includes("fetchpendingtask")) {
      const jobResponses: { msg: string; shortcut?: string; data?: Record<string, unknown>; url?: string }[] = [];

      for (const j of undelivered) {
        if (j.status === "completed" && j.result) {
          // Try to parse as FlowMate response JSON (from prompt-type jobs)
          try {
            const parsed = JSON.parse(j.result);
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].msg) {
              for (const step of parsed) {
                jobResponses.push({
                  msg: step.msg,
                  shortcut: step.shortcut,
                  data: step.data,
                  url: step.url,
                });
              }
              continue;
            }
          } catch {
            // Not JSON — treat as plain text
          }
          // Shell job or non-JSON result — wrap with optional shortcut
          let data: Record<string, unknown> | undefined;
          if (j.on_complete_data) {
            try {
              const template = JSON.parse(j.on_complete_data);
              // Inject output into data under "output" key
              data = { ...template, output: j.result };
            } catch {
              data = { output: j.result };
            }
          } else if (j.on_complete_shortcut) {
            data = { output: j.result };
          }

          jobResponses.push({
            msg: `✅ Job #${j.id} "${j.name}"\n${j.result}`,
            shortcut: j.on_complete_shortcut || undefined,
            data,
          });
        } else {
          jobResponses.push({ msg: `❌ Job #${j.id} "${j.name}"\n${j.error || "No output"}` });
        }
      }

      const ids = undelivered.map((j) => j.id);
      markDelivered(ids);
      console.log(`[${sessionId.slice(0, 8)}] Delivered ${undelivered.length} job result(s) directly (no LLM) — marked delivered: [${ids.join(", ")}]`);

      return toResponse(responses(jobResponses));
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

const base = `http://localhost:${config.port}`;
console.log(`\nflowmate-agent-server running on ${base}`);
console.log(`  POST ${base}/           → Chat`);
console.log(`  GET  ${base}/health     → Health check`);
console.log(`  GET  ${base}/jobs       → Jobs polling`);
console.log(`\nLLM: ${config.llmProvider}/${config.llmModel}`);
