import { readFileSync } from "fs";
import { randomUUID, timingSafeEqual } from "crypto";
import { parseRequest, extractBearerToken, response, responses, text, toResponse } from "pockethook-sdk";
import { loadConfig, getSystemPrompt, autoDetectLocale, setLocale, getSkillTarget, getSyncAppForShortcut } from "./config.js";
import { chat, LLMInterruptedError } from "./llm.js";
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
import {
  initJobs,
  startScheduler,
  hasUndeliveredResults,
  getUndeliveredResults,
  getUndeliveredJobSummaries,
  markDelivered,
  getPendingDeliveries,
  getDeliveryForJob,
  confirmDeliveries,
  createIntentJob,
  getIntentJobStatuses,
  waitForIntentJob,
  markJobDelivered,
  triggerScheduler,
  IntentJobConflictError,
  type Job,
} from "./jobs.js";
import { initUploads, saveUpload, readUpload, getUploadById, isImageUpload, extractUploadText, supportedUploadMime, cleanupUploads, MAX_UPLOAD_BYTES, UPLOAD_MARKER_RE } from "./uploads.js";
import { deliveryResponses, jobResponses } from "./job-results.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getDashboardHtml, getJobsJson, hasDistDashboard, serveDashboardAsset } from "./dashboard.js";
import { initWorkspaceGit } from "./versioning.js";
import { cleanupServers } from "./servers.js";
import { checkRateLimit, configureRateLimit } from "./rate-limit.js";
import { logger } from "./logger.js";
import {
  createSafariPairingCode,
  pairSafariInstallation,
  pollSafariExtension,
  readSafariCapture,
  recordSafariExtensionResult,
  getSafariExtensionResult,
  dispatchSafariExtensionCommand,
  handleSafariExtensionMessage,
  removeSafariExtensionSocket,
  safariExtensionStatus,
  type SafariExtensionCommand,
} from "./safari-extension.js";
import {
  appleBridgePairingStatus,
  createAppleBridgePairingCode,
  pairAppleBridgeInstallation,
} from "./apple-bridge-pairing.js";

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
initUploads();
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

const jobChatFn = async (job: Job, signal: AbortSignal): Promise<string> => {
  if ((job.origin === "app_intent" || job.origin === "share") && job.session_id) {
    return JSON.stringify(await runChatPipeline(job.session_id, job.prompt, signal));
  }

  const jobMessages = [{ role: "user" as const, content: JOB_PREFIX + job.prompt, timestamp: Date.now() }];
  const result = await chat(config, getSystemPrompt(config.agentName, false, config.userName, config.onboardingChat), jobMessages, tools, [], signal);
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
const INTENT_JOBS_CAPABILITY = "intent-jobs-v1,result-acks-v1,uploads-v1";
const INTENT_WAIT_MS = 20_000;

function intentAcceptedResponse(job: Job): Response {
  return Response.json(
    {
      accepted: true,
      requestId: job.request_id,
      jobId: job.id,
      status: job.status,
    },
    {
      status: 202,
      headers: { "X-PocketHook-Capabilities": INTENT_JOBS_CAPABILITY },
    },
  );
}

function completedIntentResponse(job: Job, acknowledgedDelivery = false): Response | null {
  if (acknowledgedDelivery && !job.silent && (job.status === "completed" || job.status === "failed")) {
    const delivery = getDeliveryForJob(job);
    if (delivery) return Response.json(deliveryResponses(delivery));
  }
  if (job.status === "completed" && job.result) {
    try {
      const parsed = JSON.parse(job.result) as PocketHookResponse[];
      if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item.msg !== "string")) return null;
      markJobDelivered(job.id);
      return toResponse(responses(parsed.map((item) => ({
        msg: item.msg,
        shortcut: item.shortcut,
        data: item.data,
        url: item.url,
      }))));
    } catch {
      return null;
    }
  }

  if (job.status === "failed") {
    markJobDelivered(job.id);
    return toResponse(text(`Sorry, I couldn't process your request. ${job.error || "Unknown error"}`));
  }

  return null;
}

function isAuthorized(req: Request): boolean {
  const token = extractBearerToken(req.headers.get("Authorization"));
  return Boolean(
    token &&
    token.length === config.authToken.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(config.authToken)),
  );
}

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
  signal?: AbortSignal,
): Promise<PocketHookResponse[]> {
  const processed: PocketHookResponse[] = [];

  for (const r of pockethookResponses) {
    signal?.throwIfAborted();
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

/**
 * Full chat pipeline shared by the synchronous handler and the
 * asynchronous Share Extension path: history, context, LLM, server-side
 * shortcuts, session bookkeeping.
 */
/**
 * Resolves [FILE:<id>] markers in a message: image uploads become vision
 * input, textual/PDF uploads are inlined as context, and each marker is
 * replaced by a readable note (which is also what session history keeps).
 */
async function resolveAttachments(chatInput: string): Promise<{ text: string; images: ImageContent[] }> {
  const images: ImageContent[] = [];
  const inlined: string[] = [];
  const matches = [...chatInput.matchAll(UPLOAD_MARKER_RE)];
  let text = chatInput;
  for (const match of matches) {
    const upload = getUploadById(match[1] ?? "");
    let note: string;
    if (!upload) {
      note = "[attached file no longer available]";
    } else if (isImageUpload(upload)) {
      images.push({
        type: "image",
        data: Buffer.from(readFileSync(upload.path)).toString("base64"),
        mimeType: upload.mimeType,
      });
      note = `[attached image: ${upload.name}]`;
    } else {
      note = `[attached file: ${upload.name}]`;
      const extracted = await extractUploadText(upload);
      if (extracted) {
        inlined.push(`--- Content of attached file "${upload.name}" ---\n${extracted}\n--- End of "${upload.name}" ---`);
      } else {
        note = `[attached file: ${upload.name} — stored at ${upload.path}, content not extractable]`;
      }
    }
    text = text.replace(match[0], note);
  }
  if (inlined.length > 0) {
    text = `${text}\n\n${inlined.join("\n\n")}`;
  }
  return { text, images };
}

async function runChatPipeline(
  sessionId: string,
  chatInput: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof processServerSideShortcuts>>> {
  signal?.throwIfAborted();
  const { text: resolvedInput, images } = await resolveAttachments(chatInput);
  signal?.throwIfAborted();
  addUserMessage(sessionId, resolvedInput, config.vectorMemoryEnabled);

  // Build context: recent messages + relevant memories (FTS5 + vector if enabled)
  const messages = await buildContext(sessionId, resolvedInput, config.vectorMemoryEnabled, config.maxRecall);
  const rawResponses = await chat(config, getSystemPrompt(config.agentName, config.vectorMemoryEnabled, config.userName, config.onboardingChat), messages, tools, images, signal);
  signal?.throwIfAborted();

  // Execute server-side shortcuts (macOS only) before sending to device
  const pockethookResponses = await processServerSideShortcuts(rawResponses, signal);
  signal?.throwIfAborted();

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

  return pockethookResponses;
}

const server = Bun.serve({
  port: config.port,
  maxRequestBodySize: Math.max(MAX_UPLOAD_BYTES, 1_048_576),

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/safari-extension") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("true", {
        status: 200,
        headers: {
          "X-API-Version": API_VERSION,
          "X-PocketHook-Capabilities": INTENT_JOBS_CAPABILITY,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      // Content negotiation: newer app builds send `Accept: application/json` to
      // get the list of pending jobs (id + name) so they can dedupe notifications
      // and show what each job is about. Older builds get the plain "true"/"false"
      // boolean unchanged, so polling and health checks keep working either way.
      const wantsJson = (req.headers.get("Accept") || "").toLowerCase().includes("application/json");
      if (wantsJson) {
        const jobs = getUndeliveredJobSummaries();
        logger.debug("GET /jobs (json)", { count: jobs.length });
        return new Response(JSON.stringify({ pending: jobs.length > 0, jobs }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      const pending = hasUndeliveredResults();
      logger.debug("GET /jobs", { pending });
      return new Response(pending ? "true" : "false", { status: 200 });
    }

    // File uploads from the app / Share Extension. Stored under
    // data/uploads and referenced from chat messages via [FILE:<id>].
    if (req.method === "POST" && url.pathname === "/uploads") {
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const mimeType = ((req.headers.get("content-type") || "").split(";")[0] ?? "").trim().toLowerCase();
      if (!supportedUploadMime(mimeType)) {
        return Response.json({ error: `Unsupported file type: ${mimeType || "unknown"}` }, { status: 415 });
      }
      const raw = await req.arrayBuffer();
      if (raw.byteLength > MAX_UPLOAD_BYTES) {
        return new Response("Payload Too Large", { status: 413 });
      }
      let name: string | undefined;
      try {
        name = decodeURIComponent(req.headers.get("x-file-name") || "") || undefined;
      } catch {
        name = undefined;
      }
      try {
        const meta = saveUpload(new Uint8Array(raw), mimeType, name);
        return Response.json(
          { id: meta.id, file: meta.file, path: `/uploads/${meta.file}`, name: meta.name },
          { status: 201 },
        );
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 400 });
      }
    }

    // Uploads are private resources; UUID filenames are identifiers, not credentials.
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      const upload = readUpload(url.pathname.slice("/uploads/".length));
      if (!upload) return new Response("Not Found", { status: 404 });
      return new Response(upload.data, {
        status: 200,
        headers: { "Content-Type": upload.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
      });
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
      return new Response(JSON.stringify(getJobsJson()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/safari-extension/")) {
      if (req.method === "POST" && url.pathname === "/safari-extension/native/pair") {
        try {
          const body = await req.json() as { installationId?: string; code?: string };
          if (!body.installationId || !body.code) return Response.json({ error: "installationId and code are required" }, { status: 400 });
          return Response.json(pairSafariInstallation(body.installationId, body.code));
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Pairing failed" }, { status: 400 });
        }
      }
      if (req.method === "POST" && url.pathname === "/safari-extension/native/poll") {
        try {
          const body = await req.json() as { installationId?: string; credential?: string };
          if (!body.installationId || !body.credential) return Response.json({ error: "installationId and credential are required" }, { status: 400 });
          return Response.json(pollSafariExtension(body.installationId, body.credential));
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Polling failed" }, { status: 401 });
        }
      }
      if (req.method === "POST" && url.pathname === "/safari-extension/native/result") {
        try {
          const body = await req.json() as { installationId?: string; credential?: string; requestId?: string; ok?: boolean; result?: unknown; resultJson?: string; error?: string };
          if (!body.installationId || !body.credential || !body.requestId || typeof body.ok !== "boolean") {
            return Response.json({ error: "installationId, credential, requestId and ok are required" }, { status: 400 });
          }
          let result = body.result;
          if (body.resultJson) {
            try { result = JSON.parse(body.resultJson); }
            catch { return Response.json({ error: "Invalid result payload" }, { status: 400 }); }
          }
          recordSafariExtensionResult(body.installationId, body.credential, body.requestId, { ok: body.ok, result, error: body.error });
          return Response.json({ ok: true });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Result submission failed" }, { status: 401 });
        }
      }
      // Served without bearer auth: the user's app loads this URL as a plain
      // inline image. File names are unguessable UUIDs and the route is only
      // reachable on localhost and the tailnet proxy.
      if (req.method === "GET" && url.pathname.startsWith("/safari-extension/capture/")) {
        const capture = readSafariCapture(url.pathname.slice("/safari-extension/capture/".length));
        if (!capture) return new Response("Not Found", { status: 404 });
        return new Response(capture.data, { headers: { "Content-Type": capture.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
      }
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });

      if (req.method === "POST" && url.pathname === "/safari-extension/pairing-code") {
        return Response.json(createSafariPairingCode());
      }
      if (req.method === "GET" && url.pathname === "/safari-extension/status") {
        return Response.json(safariExtensionStatus());
      }
      if (req.method === "POST" && url.pathname === "/safari-extension/command") {
        try {
          const body = await req.json() as { command?: SafariExtensionCommand["command"]; payload?: Record<string, unknown>; installationId?: string };
          const allowed = new Set<SafariExtensionCommand["command"]>(["open_tab", "navigate_tab", "get_active_tab", "close_tab", "capture_visible_tab", "get_page_snapshot", "page_action"]);
          if (!body.command || !allowed.has(body.command)) return Response.json({ error: "Unsupported Safari command" }, { status: 400 });
          return Response.json(dispatchSafariExtensionCommand({ command: body.command, payload: body.payload }, body.installationId));
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid command";
          return Response.json({ error: message }, { status: 400 });
        }
      }
      if (req.method === "GET" && url.pathname.startsWith("/safari-extension/result/")) {
        const requestId = url.pathname.slice("/safari-extension/result/".length);
        const result = getSafariExtensionResult(requestId);
        if (!result) return Response.json({ error: "Result not available" }, { status: 404 });
        return Response.json(result);
      }
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname.startsWith("/apple-bridge/")) {
      // The one-time code is the authorization for this single native request,
      // matching Safari's pairing flow. Every management route still requires
      // the Agent Server's normal bearer token.
      if (req.method === "POST" && url.pathname === "/apple-bridge/native/pair") {
        try {
          const body = await req.json() as { installationId?: string; code?: string };
          if (!body.installationId || !body.code) {
            return Response.json({ error: "installationId and code are required" }, { status: 400 });
          }
          return Response.json(pairAppleBridgeInstallation(body.installationId, body.code));
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Pairing failed" }, { status: 400 });
        }
      }

      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      if (req.method === "POST" && url.pathname === "/apple-bridge/pairing-code") {
        return Response.json(createAppleBridgePairingCode());
      }
      if (req.method === "GET" && url.pathname === "/apple-bridge/status") {
        return Response.json(appleBridgePairingStatus());
      }
      return new Response("Not Found", { status: 404 });
    }

    if (req.method === "POST" && url.pathname === "/deliveries/ack") {
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      try {
        const raw = await req.arrayBuffer();
        if (raw.byteLength > 16_384) return new Response("Payload Too Large", { status: 413 });
        const body = JSON.parse(new TextDecoder().decode(raw));
        if (!Array.isArray(body.ids) || body.ids.length > 100 ||
            body.ids.some((id: unknown) => typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))) {
          return Response.json({ error: "ids must contain at most 100 delivery UUIDs" }, { status: 400 });
        }
        confirmDeliveries(body.ids);
        return Response.json({ acknowledged: true });
      } catch { return Response.json({ error: "Invalid acknowledgement" }, { status: 400 }); }
    }

    if (req.method === "POST" && url.pathname === "/intent-jobs/status") {
      if (!isAuthorized(req)) return new Response("Unauthorized", { status: 401 });
      try {
        const statusBody = await req.arrayBuffer();
        if (statusBody.byteLength > 16_384) return new Response("Payload Too Large", { status: 413 });
        const body = JSON.parse(new TextDecoder().decode(statusBody)) as { requestIds?: unknown };
        if (!Array.isArray(body.requestIds) || body.requestIds.length > 50 ||
            body.requestIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)) {
          return Response.json({ error: "requestIds must contain at most 50 valid ids" }, { status: 400 });
        }
        return Response.json({ jobs: getIntentJobStatuses(body.requestIds as string[]) });
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
    }

    if (req.method !== "POST" || url.pathname !== "/") {
      return new Response("Not Found", { status: 404 });
    }

    const token = extractBearerToken(req.headers.get("Authorization"));
    if (!isAuthorized(req) || !token) {
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

    // New clients retain each result until they confirm local durable storage.
    if (chatInput.toLowerCase().includes(config.fetchMessage)) {
      const deliveries = getPendingDeliveries();
      if (deliveries.length === 0) return toResponse(text("false"));
      if (req.headers.get("x-pockethook-result-acks") === "1") {
        return Response.json(deliveries.flatMap(deliveryResponses));
      }
      const legacyResponses = deliveries.flatMap((delivery) => jobResponses(delivery.job));
      markDelivered(deliveries.map((delivery) => delivery.job.id));
      return Response.json(legacyResponses);
    }

    // App Intents need to finish before iOS terminates their background host.
    // Persist first, then acknowledge. Both modes use the same durable job:
    // wait=1 may return a quick result, while wait=0 always returns immediately.
    if (req.headers.get("x-pockethook-intent") === "1") {
      const requestId = (req.headers.get("x-pockethook-request-id") || "").trim();
      if (!requestId) {
        return Response.json({ error: "x-pockethook-request-id is required" }, { status: 400 });
      }

      try {
        const { job, created } = createIntentJob({
          requestId,
          sessionId,
          prompt: chatInput,
          silent: req.headers.get("x-pockethook-silent") === "1",
        });
        logger.info(created ? "Intent job queued" : "Intent job deduplicated", {
          job: job.id,
          session: sessionId.slice(0, 8),
          request: requestId.slice(0, 8),
        });

        if (job.status === "completed" || job.status === "failed") {
          return completedIntentResponse(job, req.headers.get("x-pockethook-result-acks") === "1") ?? intentAcceptedResponse(job);
        }

        triggerScheduler();
        if (req.headers.get("x-pockethook-wait") === "1") {
          const completed = await waitForIntentJob(requestId, INTENT_WAIT_MS);
          if (completed) {
            const direct = completedIntentResponse(completed, req.headers.get("x-pockethook-result-acks") === "1");
            if (direct) return direct;
            return intentAcceptedResponse(completed);
          }
        }

        return intentAcceptedResponse(job);
      } catch (error) {
        if (error instanceof IntentJobConflictError) {
          return Response.json({ error: error.message }, { status: 409 });
        }
        const message = error instanceof Error ? error.message : "Could not queue intent";
        logger.error("Intent queue failed", { error: message });
        return Response.json({ error: message }, { status: 400 });
      }
    }

    // Persist before acknowledging, including older extensions without request IDs.
    if (req.headers.get("x-pockethook-share") === "1") {
      try {
        const requestId = req.headers.get("x-pockethook-request-id")?.trim() || randomUUID();
        const { job } = createIntentJob({ requestId, sessionId, prompt: chatInput, origin: "share" });
        triggerScheduler();
        return intentAcceptedResponse(job);
      } catch (error) {
        return Response.json({ error: "Could not queue shared content" },
          { status: error instanceof IntentJobConflictError ? 409 : 400 });
      }
    }

    try {
      const pockethookResponses = await runChatPipeline(sessionId, chatInput);

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
      if (err instanceof LLMInterruptedError) {
        logger.error("LLM interrupted", { session: sessionId.slice(0, 8), error: err.message });
        return toResponse(text("The AI provider had a temporary error and this request couldn't be completed. Please try again in a moment."));
      }
      const message = err instanceof Error ? err.message : "LLM request failed";
      logger.error("LLM error", { session: sessionId.slice(0, 8), error: message });
      return toResponse(text("Sorry, I couldn't process your request. Please try again."));
    }
  },

  websocket: {
    message(socket, message) {
      handleSafariExtensionMessage(socket, typeof message === "string" ? message : new TextDecoder().decode(message));
    },
    close(socket) {
      removeSafariExtensionSocket(socket);
    },
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
logger.info(`LLM: ${config.llmProvider}/${config.llmModel} (reasoning: ${config.llmReasoning})`);
logger.info(`Quick LLM: ${config.llmQuickProvider}/${config.llmQuickModel} (reasoning: ${config.llmQuickReasoning})`);

// Cleanup dev servers on shutdown
process.on("SIGINT", () => { cleanupServers(); process.exit(0); });
process.on("SIGTERM", () => { cleanupServers(); process.exit(0); });
