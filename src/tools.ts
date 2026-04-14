/**
 * Agent tools with granular permission enforcement.
 *
 * Permissions are checked before each tool execution.
 * Denied operations return an error result (the agent sees it and can adjust).
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, resolve, relative } from "path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Permissions } from "./permissions.js";
import { checkShellPermission, checkPathPermission } from "./permissions.js";
import { createJob, listJobs, deleteJob, updateJobEnabled } from "./jobs.js";
import type { Job } from "./jobs.js";
import { startServer, stopServer, listServers, getAvailableTunnels } from "./servers.js";
import { getCustomTools } from "./custom-tools.js";
import { commitWorkspace, backupConfigFile, backupSkills, configPaths } from "./versioning.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";

const MAX_OUTPUT = 50_000; // chars

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated, ${text.length} total chars]`;
}

function denied(reason: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `Permission denied: ${reason}` }],
    details: { denied: true, reason },
  };
}

// ── Shell tool ──────────────────────────────────────────────────────────

const shellSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 300)" })),
});

function createShellTool(cwd: string, perms: Permissions): AgentTool<typeof shellSchema> {
  return {
    name: "shell",
    label: "Execute shell command",
    description: "Execute a shell command and return its output (stdout + stderr).",
    parameters: shellSchema,
    async execute(_id, params) {
      const check = checkShellPermission(params.command, perms);
      if (!check.allowed) return denied(check.reason!);

      const timeout = (params.timeout ?? 300) * 1000;
      return new Promise<AgentToolResult<unknown>>((res) => {
        let output = "";
        const child = spawn("bash", ["-c", params.command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
        });

        child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

        child.on("close", (code) => {
          // Auto-commit workspace changes after shell commands
          if (code === 0) {
            commitWorkspace(`auto: shell \`${params.command.slice(0, 60)}\``);
          }

          const prefix = code === 0 ? "" : `[exit code: ${code}]\n`;
          res({
            content: [{ type: "text", text: truncate(prefix + output) }],
            details: { exitCode: code },
          });
        });

        child.on("error", (err) => {
          res({
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message },
          });
        });
      });
    },
  };
}

// ── Read tool ───────────────────────────────────────────────────────────

const readSchema = Type.Object({
  path: Type.String({ description: "File path to read (absolute or relative to working directory)" }),
  offset: Type.Optional(Type.Number({ description: "Start line (1-based, default: 1)" })),
  limit: Type.Optional(Type.Number({ description: "Max lines to read (default: all)" })),
});

function createReadTool(cwd: string, perms: Permissions): AgentTool<typeof readSchema> {
  return {
    name: "read",
    label: "Read file",
    description: "Read a file's contents. Supports offset and limit for large files.",
    parameters: readSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      const check = checkPathPermission(filePath, "read", cwd, perms);
      if (!check.allowed) return denied(check.reason!);

      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, (params.offset ?? 1) - 1);
        const end = params.limit ? start + params.limit : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
        return {
          content: [{ type: "text", text: truncate(numbered) }],
          details: { lines: lines.length, path: filePath },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading ${filePath}: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Write tool ──────────────────────────────────────────────────────────

const writeSchema = Type.Object({
  path: Type.String({ description: "File path to write (absolute or relative to working directory)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

function createWriteTool(cwd: string, perms: Permissions): AgentTool<typeof writeSchema> {
  return {
    name: "write",
    label: "Write file",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    parameters: writeSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      const check = checkPathPermission(filePath, "write", cwd, perms);
      if (!check.allowed) return denied(check.reason!);

      try {
        // Backup config files before overwriting
        if (filePath === configPaths.agentInstructions || filePath === configPaths.permissions) {
          backupConfigFile(filePath);
        }
        if (filePath.startsWith(configPaths.skillsDir) || filePath.startsWith(configPaths.customToolsDir)) {
          backupSkills();
        }

        writeFileSync(filePath, params.content, "utf-8");

        // Auto-commit workspace changes
        if (filePath.startsWith(resolve(cwd))) {
          const relPath = relative(cwd, filePath);
          commitWorkspace(`auto: update ${relPath}`);
        }

        return {
          content: [{ type: "text", text: `Written ${params.content.length} chars to ${filePath}` }],
          details: { path: filePath, size: params.content.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error writing ${filePath}: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Ls tool ─────────────────────────────────────────────────────────────

const lsSchema = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory path (default: working directory)" })),
});

function createLsTool(cwd: string, perms: Permissions): AgentTool<typeof lsSchema> {
  return {
    name: "ls",
    label: "List directory",
    description: "List files and directories in a path.",
    parameters: lsSchema,
    async execute(_id, params) {
      const dirPath = resolve(cwd, params.path ?? ".");
      const check = checkPathPermission(dirPath, "ls", cwd, perms);
      if (!check.allowed) return denied(check.reason!);

      try {
        const entries = readdirSync(dirPath);
        const lines = entries.map((name) => {
          try {
            const stat = statSync(join(dirPath, name));
            const type = stat.isDirectory() ? "dir" : "file";
            const size = stat.isDirectory() ? "" : ` (${stat.size}b)`;
            return `${type}\t${name}${size}`;
          } catch {
            return `?\t${name}`;
          }
        });
        return {
          content: [{ type: "text", text: lines.join("\n") || "(empty directory)" }],
          details: { path: dirPath, count: entries.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error listing ${dirPath}: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── PocketHook respond tool ──────────────────────────────────────────────

const respondStepSchema = Type.Object({
  msg: Type.String({ description: "Message to display to the user" }),
  shortcut: Type.Optional(Type.String({ description: "iOS Shortcut name to execute (exact name as configured on the device)" })),
  data: Type.Optional(Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Array(Type.Record(Type.String(), Type.Unknown())),
  ], { description: "JSON data to pass to the shortcut (object or array of objects)" })),
  url: Type.Optional(Type.String({ description: "HTTPS URL to attach to the response" })),
  run_on: Type.Optional(Type.Union([Type.Literal("server"), Type.Literal("device")], {
    description: "Where to execute the shortcut: 'server' (on the Mac server) or 'device' (on the iOS device, default). Use 'server' only for shortcuts from skills with target: mac.",
  })),
});

const respondSchema = Type.Object({
  steps: Type.Array(respondStepSchema, {
    description: "One or more response steps. Each step can display a message and optionally trigger an iOS Shortcut. Steps execute sequentially on the device.",
    minItems: 1,
  }),
});

export interface PocketHookResponse {
  msg: string;
  shortcut?: string;
  data?: Record<string, unknown> | Record<string, unknown>[];
  url?: string;
  run_on?: "server" | "device";
}

export function createRespondTool(
  onRespond: (responses: PocketHookResponse[]) => void,
): AgentTool<typeof respondSchema> {
  return {
    name: "respond",
    label: "Send response to PocketHook",
    description: `Send the final response to the user's PocketHook iOS app. You MUST call this tool to deliver your response. Each step can include a message and optionally trigger an iOS Shortcut by name. Use multiple steps for sequential automations.`,
    parameters: respondSchema,
    async execute(_id, params) {
      const responses: PocketHookResponse[] = params.steps.map((step) => ({
        msg: step.msg,
        shortcut: step.shortcut,
        data: step.data as Record<string, unknown> | Record<string, unknown>[] | undefined,
        url: step.url,
        run_on: step.run_on,
      }));
      onRespond(responses);
      return {
        content: [{ type: "text", text: `Response sent (${responses.length} step${responses.length > 1 ? "s" : ""})` }],
        details: { steps: responses.length },
      };
    },
  };
}

// ── Job tools ────────────────────────────────────────────────────────────

const createJobSchema = Type.Object({
  name: Type.String({ description: "Human-readable job name" }),
  type: Type.Union([Type.Literal("once"), Type.Literal("cron")], {
    description: "once = run once, cron = repeat on schedule",
  }),
  schedule: Type.Optional(Type.String({ description: "Schedule for cron jobs. Simple intervals: '30s', '5m', '1h', '1d', '2w'. Cron expressions: '0 9 * * MON' (at 9am every Monday), '*/30 * * * *' (every 30 min), '0 0 1 * *' (1st of each month). Required for cron type." })),
  prompt: Type.String({ description: "What to execute: shell command or agent prompt" }),
  execution_type: Type.Optional(Type.Union([Type.Literal("shell"), Type.Literal("prompt")], {
    description: "shell = run as bash command (default), prompt = send to AI agent",
  })),
  delay: Type.Optional(Type.String({ description: "Delay before first run: '5m', '1h', etc. Default: immediate" })),
  timeout: Type.Optional(Type.String({ description: "Max execution time for shell jobs. Use interval format: '5m', '30m', '1h'. Default: 60s. Set to '30m' or '1h' for long-running commands like Claude Code." })),
  silent: Type.Optional(Type.Boolean({ description: "If true, the job won't trigger /jobs polling when it completes. Default: false" })),
  on_complete_shortcut: Type.Optional(Type.String({ description: "iOS Shortcut to trigger when the job completes (exact name). The shortcut receives the job output in the 'output' field of data." })),
  on_complete_data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Extra data fields to pass to the shortcut on completion. The job output is automatically added as 'output'." })),
});

function createCreateJobTool(): AgentTool<typeof createJobSchema> {
  return {
    name: "create_job",
    label: "Create background job",
    description: "Create a background job that runs on a schedule (cron) or once. Shell jobs run bash commands; prompt jobs are processed by the AI agent.",
    parameters: createJobSchema,
    async execute(_id, params) {
      try {
        const job = createJob({
          name: params.name,
          type: params.type,
          schedule: params.schedule,
          prompt: params.prompt,
          execution_type: params.execution_type ?? "shell",
          delay: params.delay,
          timeout: params.timeout,
          silent: params.silent,
          on_complete_shortcut: params.on_complete_shortcut,
          on_complete_data: params.on_complete_data as Record<string, unknown> | undefined,
        });
        const nextRun = new Date(job.next_run_at).toISOString();
        return {
          content: [{ type: "text", text: `Job #${job.id} "${job.name}" created (${job.type}, ${job.execution_type}). Next run: ${nextRun}` }],
          details: { jobId: job.id },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error creating job: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

const listJobsSchema = Type.Object({});

function createListJobsTool(): AgentTool<typeof listJobsSchema> {
  return {
    name: "list_jobs",
    label: "List background jobs",
    description: "List all background jobs with their status, schedule, and last result.",
    parameters: listJobsSchema,
    async execute() {
      const jobs = listJobs();
      if (jobs.length === 0) {
        return {
          content: [{ type: "text", text: "No jobs found." }],
          details: { count: 0 },
        };
      }

      const lines = jobs.map((j: Job) => {
        const status = j.enabled ? j.status : "disabled";
        const schedule = j.schedule ? ` every ${j.schedule}` : "";
        const nextRun = j.status === "pending" ? ` next: ${new Date(j.next_run_at).toISOString()}` : "";
        const lastResult = j.result ? ` result: ${j.result.slice(0, 100)}` : "";
        const lastError = j.error ? ` error: ${j.error.slice(0, 100)}` : "";
        return `#${j.id} "${j.name}" [${j.type}${schedule}] (${status})${nextRun}${lastResult}${lastError}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: jobs.length },
      };
    },
  };
}

const deleteJobSchema = Type.Object({
  id: Type.Number({ description: "Job ID to delete" }),
});

function createDeleteJobTool(): AgentTool<typeof deleteJobSchema> {
  return {
    name: "delete_job",
    label: "Delete background job",
    description: "Delete a background job by ID.",
    parameters: deleteJobSchema,
    async execute(_id, params) {
      const deleted = deleteJob(params.id);
      return {
        content: [{ type: "text", text: deleted ? `Job #${params.id} deleted.` : `Job #${params.id} not found.` }],
        details: { deleted },
      };
    },
  };
}

// ── Web search tool ──────────────────────────────────────────────────

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Search query" }),
  num_results: Type.Optional(Type.Number({ description: "Number of results to return (default: 5, max: 10)" })),
});

function createWebSearchTool(config: Config): AgentTool<typeof webSearchSchema> {
  return {
    name: "web_search",
    label: "Search the web",
    description: "Search the web and return results with titles, snippets, and URLs. Use this to find information, products, reviews, news, etc.",
    parameters: webSearchSchema,
    async execute(_id, params) {
      const num = Math.min(params.num_results ?? 5, 10);

      try {
        let results: { title: string; snippet: string; url: string }[];

        if (config.searchProvider === "searxng" && config.searchUrl) {
          // SearXNG
          const searchUrl = new URL("/search", config.searchUrl);
          searchUrl.searchParams.set("q", params.query);
          searchUrl.searchParams.set("format", "json");
          searchUrl.searchParams.set("categories", "general");

          const res = await fetch(searchUrl.toString());
          if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
          const data = await res.json() as { results: { title: string; content: string; url: string }[] };

          results = (data.results || []).slice(0, num).map((r) => ({
            title: r.title,
            snippet: r.content,
            url: r.url,
          }));
        } else if (config.searchApiKey) {
          // Serper.dev
          const res = await fetch("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": config.searchApiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: params.query, num }),
          });
          if (!res.ok) throw new Error(`Serper returned ${res.status}`);
          const data = await res.json() as { organic: { title: string; snippet: string; link: string }[] };

          results = (data.organic || []).slice(0, num).map((r) => ({
            title: r.title,
            snippet: r.snippet,
            url: r.link,
          }));
        } else {
          return {
            content: [{ type: "text", text: "Web search not configured. Set SEARCH_API_KEY (Serper) or SEARCH_PROVIDER=searxng + SEARCH_URL in .env." }],
            details: { error: "not_configured" },
          };
        }

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for: ${params.query}` }],
            details: { count: 0 },
          };
        }

        const formatted = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.snippet}\n   ${r.url}`
        ).join("\n\n");

        return {
          content: [{ type: "text", text: formatted }],
          details: { count: results.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Search error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Web fetch tool ──────────────────────────────────────────────────

const webFetchSchema = Type.Object({
  url: Type.String({ description: "URL to fetch and extract content from" }),
});

function createWebFetchTool(): AgentTool<typeof webFetchSchema> {
  return {
    name: "web_fetch",
    label: "Fetch web page content",
    description: "Fetch a web page and extract its main content as clean readable text. Use this after web_search to read full articles, product pages, reviews, etc.",
    parameters: webFetchSchema,
    async execute(_id, params) {
      try {
        // Use Jina Reader to get clean markdown content (30s timeout)
        const jinaUrl = `https://r.jina.ai/${params.url}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch(jinaUrl, {
          headers: {
            "Accept": "text/markdown",
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          throw new Error(`Jina Reader returned ${res.status}`);
        }

        let content = await res.text();

        // Truncate if too long
        if (content.length > MAX_OUTPUT) {
          content = content.slice(0, MAX_OUTPUT) + `\n\n... [truncated, ${content.length} total chars]`;
        }

        return {
          content: [{ type: "text", text: content }],
          details: { url: params.url, size: content.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Fetch error for ${params.url}: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Server management tools ──────────────────────────────────────────────

const startServerSchema = Type.Object({
  name: Type.String({ description: "Human-readable name for the server (e.g., 'Hugo blog', 'React app')" }),
  command: Type.String({ description: "Shell command to start the dev server. Use $PORT as placeholder for the assigned port (e.g., 'hugo server -p $PORT', 'npm run dev -- --port $PORT')" }),
  cwd: Type.String({ description: "Working directory for the command (absolute path or relative to workspace)" }),
  port: Type.Optional(Type.Number({ description: "Preferred port (default: auto-assign starting from 4000)" })),
  tunnel: Type.Optional(Type.Boolean({ description: "Expose via HTTPS tunnel (Tailscale). Default: false" })),
});

function createStartServerTool(cwd: string, perms: Permissions): AgentTool<typeof startServerSchema> {
  return {
    name: "start_server",
    label: "Start a dev server",
    description: "Start a long-running dev server for a workspace project. The server runs in the background and can optionally be exposed via HTTPS tunnel. Use $PORT in the command as a placeholder for the assigned port.",
    parameters: startServerSchema,
    async execute(_id, params) {
      const check = checkShellPermission(params.command, perms);
      if (!check.allowed) return denied(check.reason!);

      try {
        const resolvedCwd = resolve(cwd, params.cwd);
        const entry = startServer({
          name: params.name,
          command: params.command,
          cwd: resolvedCwd,
          port: params.port,
          tunnel: params.tunnel,
        });

        let msg = `Server "${entry.name}" started (ID #${entry.id}, port ${entry.port}, PID ${entry.pid}).`;
        msg += `\nLocal: http://localhost:${entry.port}`;
        if (entry.tunnelUrl) {
          msg += `\nPublic: ${entry.tunnelUrl}`;
        }
        return {
          content: [{ type: "text", text: msg }],
          details: { id: entry.id, port: entry.port, tunnelUrl: entry.tunnelUrl },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error starting server: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

const stopServerSchema = Type.Object({
  id: Type.Number({ description: "Server ID to stop" }),
});

function createStopServerTool(): AgentTool<typeof stopServerSchema> {
  return {
    name: "stop_server",
    label: "Stop a dev server",
    description: "Stop a running dev server by ID. Also removes its tunnel if one was configured.",
    parameters: stopServerSchema,
    async execute(_id, params) {
      const result = stopServer(params.id);
      if (result.stopped) {
        return {
          content: [{ type: "text", text: `Server "${result.name}" (ID #${params.id}) stopped.` }],
          details: { stopped: true },
        };
      }
      return {
        content: [{ type: "text", text: `Server #${params.id} not found.` }],
        details: { stopped: false },
      };
    },
  };
}

const listServersSchema = Type.Object({});

function createListServersTool(): AgentTool<typeof listServersSchema> {
  return {
    name: "list_servers",
    label: "List running dev servers",
    description: "List all running dev servers with their ports, PIDs, and tunnel URLs.",
    parameters: listServersSchema,
    async execute() {
      const servers = listServers();
      const tunnels = getAvailableTunnels();

      if (servers.length === 0) {
        const availableTunnels = tunnels.filter((t) => t.available).map((t) => t.name);
        const tunnelInfo = availableTunnels.length > 0
          ? `Available tunnels: ${availableTunnels.join(", ")}`
          : "No tunnel tools installed (Tailscale, ngrok, or cloudflared)";
        return {
          content: [{ type: "text", text: `No servers running.\n${tunnelInfo}` }],
          details: { count: 0, tunnels: availableTunnels },
        };
      }

      const lines = servers.map((s) => {
        let line = `#${s.id} "${s.name}" — port ${s.port} (PID ${s.pid})`;
        line += `\n    Local: http://localhost:${s.port}`;
        if (s.tunnelUrl) {
          line += `\n    Public: ${s.tunnelUrl}`;
        }
        line += `\n    Dir: ${s.cwd}`;
        line += `\n    Started: ${s.startedAt}`;
        return line;
      });

      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { count: servers.length },
      };
    },
  };
}

// ── Memory search tool ──────────────────────────────────────────────────

const searchMemorySchema = Type.Object({
  query: Type.String({ description: "Search query — keywords or phrases to find in past conversations" }),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default: 10, max: 20)" })),
  semantic: Type.Optional(Type.Boolean({ description: "Use semantic (vector) search instead of keyword search. Better for conceptual queries. Default: false" })),
  wing: Type.Optional(Type.String({ description: "Filter by wing (entity). E.g., 'user', 'project:blog', 'person:juan'" })),
  room: Type.Optional(Type.String({ description: "Filter by room (memory type). E.g., 'decisions', 'preferences', 'events', 'facts', 'context'" })),
  status: Type.Optional(Type.String({ description: "Filter by PARA status: 'project' (active with outcome), 'area' (ongoing), 'resource' (reference), 'archive' (inactive). If omitted, archived items are excluded by default." })),
  include_archived: Type.Optional(Type.Boolean({ description: "Include archived items in results. Default: false" })),
});

function createSearchMemoryTool(configRef?: Config): AgentTool<typeof searchMemorySchema> {
  return {
    name: "search_memory",
    label: "Search conversation history",
    description: "Search past conversations stored in long-term memory. Use this when the user refers to something discussed before, or when you need to find details from a previous exchange (e.g., field names, shortcut names, decisions made). Supports semantic search with wing/room filters when semantic memory is enabled.",
    parameters: searchMemorySchema,
    async execute(_id, params) {
      try {
        const limit = Math.min(params.limit ?? 10, 20);
        const vectorEnabled = configRef?.vectorMemoryEnabled ?? false;

        if (params.semantic && vectorEnabled) {
          const { searchSemantic } = await import("./vector-memory.js");
          const { getMessagesByIds } = await import("./memory.js");
          const filters: { wing?: string; room?: string; status?: string; includeArchived?: boolean } = {};
          if (params.wing) filters.wing = params.wing;
          if (params.room) filters.room = params.room;
          if (params.status) filters.status = params.status;
          if (params.include_archived) filters.includeArchived = true;

          const vectorResults = await searchSemantic(params.query, limit, filters);
          if (vectorResults.length === 0) {
            return {
              content: [{ type: "text", text: `No semantic results found for: ${params.query}` }],
              details: { count: 0 },
            };
          }

          const messages = getMessagesByIds(vectorResults.map((r) => r.messageId));
          const formatted = messages.map((r) =>
            `[${r.dateStr}] ${r.role}: ${r.content}`
          ).join("\n\n");

          return {
            content: [{ type: "text", text: formatted }],
            details: { count: messages.length, mode: "semantic" },
          };
        }

        // Default: FTS5 keyword search
        const { recall } = await import("./memory.js");
        const results = recall(params.query, limit);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for: ${params.query}` }],
            details: { count: 0 },
          };
        }

        const formatted = results.map((r) =>
          `[${r.dateStr}] ${r.role}: ${r.content}`
        ).join("\n\n");

        return {
          content: [{ type: "text", text: formatted }],
          details: { count: results.length, mode: "keyword" },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Memory search error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Knowledge graph tools ───────────────────────────────────────────────

const rememberFactSchema = Type.Object({
  subject: Type.String({ description: "The entity (e.g., 'user', 'John', 'project-blog')" }),
  predicate: Type.String({ description: "The relationship/property (e.g., 'lives_in', 'prefers', 'works_at')" }),
  object: Type.String({ description: "The value (e.g., 'Madrid', 'dark mode', 'Google')" }),
});

function createRememberFactTool(): AgentTool<typeof rememberFactSchema> {
  return {
    name: "remember_fact",
    label: "Store a fact in the knowledge graph",
    description: "Store a durable fact as a triple (subject, predicate, object). Use this when the user shares factual information about themselves or their world (preferences, locations, relationships, etc.). For single-value facts (lives_in, partner), the old value is auto-invalidated when it changes. For multi-value facts (child, friend, colleague, hobby, pet, skill, language), multiple values coexist — call this once per value (e.g., one call per child, one call per friend).",
    parameters: rememberFactSchema,
    async execute(_id, params) {
      try {
        const { addTriple } = await import("./knowledge-graph.js");
        const id = addTriple(params.subject, params.predicate, params.object);
        return {
          content: [{ type: "text", text: `Fact stored: ${params.subject} → ${params.predicate} → ${params.object} (id: ${id})` }],
          details: { tripleId: id },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error storing fact: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

const queryFactsSchema = Type.Object({
  subject: Type.String({ description: "Entity to query facts about (e.g., 'user', 'John', 'project-blog')" }),
  predicate: Type.Optional(Type.String({ description: "Optional: specific relationship to query (e.g., 'lives_in', 'prefers')" })),
  include_expired: Type.Optional(Type.Boolean({ description: "Include facts that are no longer valid (default: false)" })),
});

function createQueryFactsTool(): AgentTool<typeof queryFactsSchema> {
  return {
    name: "query_facts",
    label: "Query the knowledge graph",
    description: "Retrieve stored facts about an entity from the knowledge graph. Returns currently valid facts by default. Use this to recall preferences, relationships, locations, and other structured information.",
    parameters: queryFactsSchema,
    async execute(_id, params) {
      try {
        const { queryTriples } = await import("./knowledge-graph.js");
        const activeOnly = !params.include_expired;
        const results = queryTriples(params.subject, params.predicate, activeOnly);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No facts found for: ${params.subject}${params.predicate ? ` → ${params.predicate}` : ""}` }],
            details: { count: 0 },
          };
        }

        const formatted = results.map((t) => {
          const since = new Date(t.validFrom).toISOString().slice(0, 10);
          let line = `${t.subject} → ${t.predicate} → ${t.object} [since ${since}]`;
          if (t.validUntil) {
            const until = new Date(t.validUntil).toISOString().slice(0, 10);
            line = `${t.subject} → ${t.predicate} → ${t.object} [${since} → expired ${until}]`;
          }
          return line;
        }).join("\n");

        return {
          content: [{ type: "text", text: formatted }],
          details: { count: results.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Knowledge graph error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Update memory status tool (PARA) ─────────────────────────────────────

const updateStatusSchema = Type.Object({
  wing: Type.String({ description: "The entity whose memories should be updated (e.g., 'project:blog', 'person:juan')" }),
  status: Type.String({ description: "New PARA status: 'project' (active with outcome), 'area' (ongoing), 'resource' (reference), 'archive' (completed/cancelled/inactive)" }),
  room: Type.Optional(Type.String({ description: "Optional: only update memories matching this room (e.g., 'events', 'decisions')" })),
});

function createUpdateStatusTool(): AgentTool<typeof updateStatusSchema> {
  return {
    name: "update_memory_status",
    label: "Update PARA status of memories",
    description: "Change the PARA status of stored memories. Use this to mark a project as complete/cancelled (set status to 'archive'), promote an area to a project when it gets a deadline, or file reference material. Operates on all memories matching a wing (and optionally a room).",
    parameters: updateStatusSchema,
    async execute(_id, params) {
      try {
        const { updateStatus } = await import("./vector-memory.js");
        const count = updateStatus(params.wing, params.status, params.room);
        return {
          content: [{ type: "text", text: `Updated ${count} memories for wing="${params.wing}"${params.room ? `, room="${params.room}"` : ""} → status="${params.status}"` }],
          details: { updated: count },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error updating status: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Complete project tool (PARA transition) ─────────────────────────────

const completeProjectSchema = Type.Object({
  project_description: Type.String({ description: "A short description identifying the specific project to close (e.g., 'trip to Japan June 2026', 'writing scifi novel', 'blog redesign'). Semantic similarity is used to find only the vectors related to THIS project, leaving other concurrent projects untouched." }),
  hall: Type.Optional(Type.String({ description: "Optional hall filter to narrow the scope (e.g., 'travel', 'work'). Default: no filter, scans all project-status vectors." })),
  threshold: Type.Optional(Type.Number({ description: "Similarity threshold 0-1 (default 0.55). Higher = stricter matching. Only vectors above this threshold are affected." })),
});

function createCompleteProjectTool(): AgentTool<typeof completeProjectSchema> {
  return {
    name: "complete_project",
    label: "Complete or cancel a project (PARA)",
    description: "Close a specific project using PARA-style transition. Uses semantic similarity on a project description so only the relevant project is affected — NOT every project in the same hall. Events/decisions/requests related to the project are archived, while reference material (lists, recommendations, how-tos) is preserved as 'resource'. Call this when the user cancels or completes a project. Provide a precise description that identifies THIS project uniquely (include destination, topic, dates, or project name).",
    parameters: completeProjectSchema,
    async execute(_id, params) {
      try {
        const { completeProject } = await import("./vector-memory.js");
        const result = await completeProject(params.project_description, {
          hall: params.hall,
          threshold: params.threshold,
        });
        return {
          content: [{ type: "text", text: `Project "${params.project_description}" closed: scanned ${result.scanned} project vectors, ${result.archived} archived, ${result.keptAsResource} kept as resource.` }],
          details: result,
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error completing project: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Load skill tool ──────────────────────────────────────────────────────

const loadSkillSchema = Type.Object({
  name: Type.String({ description: "Name of the skill to load (filename without extension)" }),
});

function createLoadSkillTool(): AgentTool<typeof loadSkillSchema> {
  return {
    name: "load_skill",
    label: "Load skill content",
    description: "Load the full content of a skill by name. Use this when you need detailed instructions for a skill listed in the 'Available Skills' section. Skills contain shortcut definitions, behavior rules, and usage guidance.",
    parameters: loadSkillSchema,
    async execute(_id, params) {
      try {
        const { getSkillContent, listSkillNames } = await import("./config.js");
        const content = getSkillContent(params.name);
        if (!content) {
          const available = listSkillNames();
          return {
            content: [{ type: "text", text: `Skill "${params.name}" not found. Available skills: ${available.join(", ")}` }],
            details: { error: "not_found" },
          };
        }
        return {
          content: [{ type: "text", text: content }],
          details: { name: params.name, size: content.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error loading skill: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Load doc tool ────────────────────────────────────────────────────────

const loadDocSchema = Type.Object({
  name: Type.String({ description: "Name of the doc to load (filename without extension, e.g. 'settings-reference')" }),
});

function createLoadDocTool(): AgentTool<typeof loadDocSchema> {
  return {
    name: "load_doc",
    label: "Load documentation",
    description: "Load the full content of a PocketHook documentation page by name. Call this in two cases: (1) when the user asks about features, settings, API, setup, or product behavior; (2) when you yourself are unsure about how the product works and a doc can resolve the doubt — consult before guessing. The available docs are listed in the 'Available Documentation' section of the system prompt. Always prefer the actual doc over training data.",
    parameters: loadDocSchema,
    async execute(_id, params) {
      try {
        const { getDocContent, listDocNames } = await import("./config.js");
        const content = getDocContent(params.name);
        if (!content) {
          const available = listDocNames();
          return {
            content: [{ type: "text", text: `Doc "${params.name}" not found. Available docs: ${available.join(", ")}` }],
            details: { error: "not_found" },
          };
        }
        return {
          content: [{ type: "text", text: content }],
          details: { name: params.name, size: content.length },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error loading doc: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Tool factory ────────────────────────────────────────────────────────

type ToolName = "shell" | "read" | "write" | "ls" | "create_job" | "list_jobs" | "delete_job" | "web_search" | "web_fetch" | "start_server" | "stop_server" | "list_servers" | "search_memory" | "remember_fact" | "query_facts" | "load_skill" | "load_doc" | "update_memory_status" | "complete_project";

export function createTools(cwd: string, perms: Permissions, config?: Config): AgentTool<any>[] {
  // Note: config is a live reference — vectorMemoryEnabled may change after Ollama health check
  const factories: Record<ToolName, () => AgentTool<any>> = {
    shell: () => createShellTool(cwd, perms),
    read: () => createReadTool(cwd, perms),
    write: () => createWriteTool(cwd, perms),
    ls: () => createLsTool(cwd, perms),
    create_job: () => createCreateJobTool(),
    list_jobs: () => createListJobsTool(),
    delete_job: () => createDeleteJobTool(),
    web_search: () => createWebSearchTool(config!),
    web_fetch: () => createWebFetchTool(),
    start_server: () => createStartServerTool(cwd, perms),
    stop_server: () => createStopServerTool(),
    list_servers: () => createListServersTool(),
    search_memory: () => createSearchMemoryTool(config),
    remember_fact: () => createRememberFactTool(),
    query_facts: () => createQueryFactsTool(),
    load_skill: () => createLoadSkillTool(),
    load_doc: () => createLoadDocTool(),
    update_memory_status: () => createUpdateStatusTool(),
    complete_project: () => createCompleteProjectTool(),
  };

  const tools: AgentTool<any>[] = [];
  for (const name of perms.tools) {
    const factory = factories[name as ToolName];
    if (factory) {
      tools.push(factory());
    } else if (name !== "respond") {
      logger.warn(`Unknown tool: ${name}`);
    }
  }

  // Append custom tools (hot-reloaded from custom-tools/*.md)
  const customTools = getCustomTools(cwd);
  tools.push(...customTools);

  return tools;
}
