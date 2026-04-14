import { timingSafeEqual } from "crypto";
import { parseRequest, extractBearerToken, response, responses, text, toResponse } from "pockethook-sdk";
import { loadConfig, getSystemPrompt, autoDetectLocale, setLocale, getSkillTarget, getSyncAppForShortcut } from "./config.js";
import { chat } from "./llm.js";
import { createTools, type PocketHookResponse } from "./tools.js";
import {
  buildContext,
  addUserMessage,
  addAssistantMessage,
  trimHistory,
  cleanExpiredSessions,
} from "./sessions.js";
import { memoryStats, getDbPath } from "./memory.js";
import { checkEmbeddingAvailable, configure as configureEmbeddings } from "./embeddings.js";
import { migrateEmbeddings, configureClassifier } from "./vector-memory.js";
import { loadPermissions } from "./permissions.js";
import { initJobs, startScheduler, hasUndeliveredResults, getUndeliveredResults, markDelivered } from "./jobs.js";
import { getDashboardHtml, getJobsJson, hasDistDashboard, serveDashboardAsset, getDashboardToken } from "./dashboard.js";
import { initWorkspaceGit } from "./versioning.js";
import { cleanupServers } from "./servers.js";
import { checkRateLimit, configureRateLimit } from "./rate-limit.js";
import { logger } from "./logger.js";

const config = loadConfig();

// Configure rate limiting from env
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX) || undefined;
const rateLimitWindow = Number(process.env.RATE_LIMIT_WINDOW_MS) || undefined;
if (rateLimitMax || rateLimitWindow) {
  configureRateLimit({ maxRequests: rateLimitMax, windowMs: rateLimitWindow });
}

const permissions = loadPermissions(process.env.TOOLS);
const tools = createTools(config.workingDir, permissions, config);

logger.info(`Tools: [${permissions.tools.join(", ")}]`);
logger.info(`Working dir: ${config.workingDir}`);
logger.info(`Boundary: ${permissions.enforceWorkingDir ? "enforced" : "open"}`);
if (permissions.shell.blockedCommands.length > 0) {
  logger.info("Shell permissions", { blockedCommands: permissions.shell.blockedCommands.length, blockedPatterns: permissions.shell.blockedPatterns.length });
}
if (permissions.filesystem.blockedPaths.length > 0) {
  logger.info(`Filesystem blocked: ${permissions.filesystem.blockedPaths.join(", ")}`);
}

// Initialize jobs system and workspace versioning
initJobs();
initWorkspaceGit();

// Semantic memory: check embedding provider availability if enabled
if (config.vectorMemoryEnabled) {
  configureEmbeddings({
    provider: config.embeddingProvider,
    baseUrl: config.embeddingUrl,
    model: config.embeddingModel,
    apiKey: config.embeddingApiKey,
  });
  // Configure LLM classifier for room/hall auto-classification
  configureClassifier(config);

  checkEmbeddingAvailable().then((available) => {
    if (available) {
      logger.info(`Semantic memory: enabled (${config.embeddingProvider}/${config.embeddingModel} via ${config.embeddingUrl})`);
      // Backfill embeddings for existing messages in background
      migrateEmbeddings(getDbPath()).catch((err) => {
        logger.warn(`Embedding migration failed: ${err instanceof Error ? err.message : err}`);
      });
    } else {
      config.vectorMemoryEnabled = false;
      logger.warn(`Semantic memory: disabled (${config.embeddingProvider} unreachable or model not found)`);
    }
  });
} else {
  logger.info("Semantic memory: disabled (VECTOR_MEMORY not set to true)");
}

// Locale: use manual config or auto-detect from IP
if (config.locale) {
  setLocale(config.locale);
  logger.info("Locale configured", { country: config.locale.country, city: config.locale.city });
} else {
  autoDetectLocale(config).then(() => {
    if (config.locale) setLocale(config.locale);
  });
}

// Chat function for prompt-type jobs — stores full PocketHook response as JSON
const JOB_PREFIX = "[BACKGROUND JOB] You are running inside a background job. Do the work directly — do NOT create more jobs. Use web_search, web_fetch, shell, read, write tools directly to complete the task.\n\n";

const jobChatFn = async (prompt: string): Promise<string> => {
  const jobMessages = [{ role: "user" as const, content: JOB_PREFIX + prompt, timestamp: Date.now() }];
  const result = await chat(config, getSystemPrompt(config.agentName, false, config.userName, config.onboardingChat), jobMessages, tools);
  return JSON.stringify(result);
};

startScheduler(config.workingDir, jobChatFn);

// Clean expired sessions periodically
setInterval(() => {
  const cleaned = cleanExpiredSessions(config.sessionTtlMs);
  if (cleaned > 0) {
    logger.info(`Cleaned ${cleaned} expired session(s)`);
  }
}, 5 * 60 * 1000);

const API_VERSION = "1";

// ── Server-side shortcut execution (macOS only) ─────────────────────────

const IS_MACOS = process.platform === "darwin";

async function executeShortcutOnServer(
  name: string,
  data?: Record<string, unknown> | Record<string, unknown>[],
  syncApp?: string,
): Promise<{ success: boolean; error?: string }> {
  const input = JSON.stringify({
    context: "server_triggered",
    timestamp: new Date().toISOString(),
    app: "PocketHook",
    data: data ?? {},
  });

  try {
    const proc = Bun.spawn(["shortcuts", "run", name], {
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => proc.kill(), 30_000);
    const exitCode = await proc.exited;
    clearTimeout(timeout);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return { success: false, error: stderr.trim() || `Exit code ${exitCode}` };
    }

    // Nudge iCloud sync: open the app in background, wait, then close it
    if (syncApp) {
      Bun.spawn(["open", "-gj", "-a", syncApp], { stdout: "ignore", stderr: "ignore" });
      setTimeout(() => {
        Bun.spawn(["osascript", "-e", `tell application "${syncApp}" to quit`], { stdout: "ignore", stderr: "ignore" });
      }, 5_000);
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function processServerSideShortcuts(
  pockethookResponses: PocketHookResponse[],
): Promise<PocketHookResponse[]> {
  const processed: PocketHookResponse[] = [];

  for (const r of pockethookResponses) {
    if (r.run_on === "server" && r.shortcut) {
      if (!IS_MACOS) {
        logger.warn(`Shortcut "${r.shortcut}" marked as server-side but server is not macOS. Falling back to device.`);
        const { run_on, ...rest } = r;
        processed.push(rest);
        continue;
      }

      logger.info(`Executing shortcut on server: ${r.shortcut}`);
      const syncApp = getSyncAppForShortcut(r.shortcut);
      const result = await executeShortcutOnServer(r.shortcut, r.data as Record<string, unknown> | Record<string, unknown>[] | undefined, syncApp);

      if (result.success) {
        processed.push({ msg: r.msg, url: r.url });
      } else {
        logger.error(`Server shortcut failed: ${r.shortcut}`, { error: result.error });
        processed.push({ msg: `${r.msg}\n\n⚠ Server execution failed: ${result.error}`, url: r.url });
      }
    } else {
      const { run_on, ...rest } = r;
      processed.push(rest);
    }
  }

  return processed;
}

Bun.serve({
  port: config.port,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("true", { status: 200, headers: { "X-API-Version": API_VERSION } });
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      const pending = hasUndeliveredResults();
      logger.debug("GET /jobs", { pending });
      return new Response(pending ? "true" : "false", { status: 200 });
    }

    if (req.method === "GET" && (url.pathname === "/dashboard" || url.pathname.startsWith("/dashboard/"))) {
      if (!config.dashboardEnabled) {
        return new Response("Dashboard is disabled. Set DASHBOARD=true in .env to enable.", { status: 404 });
      }

      // Serve static assets from dist/ (for built projects like Svelte/React/Vue)
      const subpath = url.pathname.replace(/^\/dashboard\/?/, "");
      if (subpath && hasDistDashboard()) {
        const asset = serveDashboardAsset(subpath);
        if (asset) return asset;
        return new Response("Not Found", { status: 404 });
      }

      // Serve index HTML (dist/index.html > dashboard.html > built-in default)
      return new Response(getDashboardHtml(), {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "X-Frame-Options": "DENY",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      if (!config.dashboardEnabled) {
        return new Response("Not Found", { status: 404 });
      }
      const dtk = req.headers.get("X-Dashboard-Token");
      if (dtk !== getDashboardToken()) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(JSON.stringify(getJobsJson()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method !== "POST" || url.pathname !== "/") {
      return new Response("Not Found", { status: 404 });
    }

    const token = extractBearerToken(req.headers.get("Authorization"));
    if (
      !token ||
      token.length !== config.authToken.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(config.authToken))
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Rate limiting
    const rateCheck = checkRateLimit(token);
    if (!rateCheck.allowed) {
      logger.warn("Rate limit exceeded");
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((rateCheck.retryAfterMs ?? 60_000) / 1000)) },
      });
    }

    // Request size limit (1MB) — read raw body to enforce regardless of headers
    const MAX_BODY = 1_048_576;
    const rawBody = await req.arrayBuffer();
    if (rawBody.byteLength > MAX_BODY) {
      return new Response("Payload Too Large", { status: 413 });
    }

    let sessionId: string;
    let chatInput: string;
    try {
      const parsed = parseRequest(JSON.parse(new TextDecoder().decode(rawBody)));
      sessionId = parsed.sessionId;
      chatInput = parsed.chatInput;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bad Request";
      return new Response(message, { status: 400 });
    }

    // Message length limit (10,000 chars — matches PocketHook app limit)
    if (chatInput.length > 10_000) {
      return new Response("Message too long (max 10,000 characters)", { status: 413 });
    }

    logger.info("Chat request", { session: sessionId.slice(0, 8), inputLength: chatInput.length });

    // Direct delivery: if fetchPendingTasks and there are completed jobs, respond immediately without LLM
    const undelivered = getUndeliveredResults();
    if (undelivered.length > 0 && chatInput.toLowerCase().includes(config.fetchMessage)) {
      const jobResponses: { msg: string; shortcut?: string; data?: Record<string, unknown>; url?: string }[] = [];

      for (const j of undelivered) {
        if (j.status === "completed" && j.result) {
          // Try to parse as PocketHook response JSON (from prompt-type jobs)
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
            // Not JSON — treat as plain text (expected for shell job output)
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
      logger.info("Delivered job results directly", { session: sessionId.slice(0, 8), count: undelivered.length, ids });

      return toResponse(responses(jobResponses));
    }

    addUserMessage(sessionId, chatInput, config.vectorMemoryEnabled);

    try {
      // Build context: recent messages + relevant memories (FTS5 + vector if enabled)
      const messages = await buildContext(sessionId, chatInput, config.vectorMemoryEnabled);
      const rawResponses = await chat(config, getSystemPrompt(config.agentName, config.vectorMemoryEnabled, config.userName, config.onboardingChat), messages, tools);

      // Execute server-side shortcuts (macOS only) before sending to device
      const pockethookResponses = await processServerSideShortcuts(rawResponses);

      // Store summary in session history
      const summaryText = pockethookResponses.map((r) => r.msg).join("\n");
      addAssistantMessage(sessionId, {
        role: "assistant",
        content: [{ type: "text", text: summaryText }],
        api: "anthropic-messages" as any,
        provider: config.llmProvider,
        model: config.llmModel,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      }, config.vectorMemoryEnabled);
      trimHistory(sessionId, config.maxHistory);

      // Build PocketHook SDK response — pass all fields (msg, shortcut, data, url)
      return toResponse(
        responses(
          pockethookResponses.map((r) => ({
            msg: r.msg,
            shortcut: r.shortcut,
            data: r.data,
            url: r.url,
          })),
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "LLM request failed";
      logger.error("LLM error", { session: sessionId.slice(0, 8), error: message });
      return toResponse(text("Sorry, I couldn't process your request. Please try again."));
    }
  },
});

const base = `http://localhost:${config.port}`;
logger.info(`pockethook-agent-server running on ${base}`);
logger.info(`  POST ${base}/           → Chat`);
logger.info(`  GET  ${base}/health     → Health check`);
logger.info(`  GET  ${base}/jobs       → Jobs polling`);
if (config.dashboardEnabled) {
  logger.info(`  GET  ${base}/dashboard  → Dashboard`);
}
logger.info(`LLM: ${config.llmProvider}/${config.llmModel}`);

// Cleanup dev servers on shutdown
process.on("SIGINT", () => { cleanupServers(); process.exit(0); });
process.on("SIGTERM", () => { cleanupServers(); process.exit(0); });
