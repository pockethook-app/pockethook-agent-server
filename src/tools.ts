/**
 * Agent tools with granular permission enforcement.
 *
 * Permissions are checked before each tool execution.
 * Denied operations return an error result (the agent sees it and can adjust).
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Permissions } from "./permissions.js";
import { checkShellPermission, checkPathPermission } from "./permissions.js";
import { createJob, listJobs, deleteJob, updateJobEnabled, parseInterval } from "./jobs.js";
import type { Job } from "./jobs.js";

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
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 30)" })),
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

      const timeout = (params.timeout ?? 30) * 1000;
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
        writeFileSync(filePath, params.content, "utf-8");
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

// ── FlowMate respond tool ───────────────────────────────────────────────

const respondStepSchema = Type.Object({
  msg: Type.String({ description: "Message to display to the user" }),
  shortcut: Type.Optional(Type.String({ description: "iOS Shortcut name to execute (exact name as configured on the device)" })),
  data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "JSON data to pass to the shortcut" })),
  url: Type.Optional(Type.String({ description: "HTTPS URL to attach to the response" })),
});

const respondSchema = Type.Object({
  steps: Type.Array(respondStepSchema, {
    description: "One or more response steps. Each step can display a message and optionally trigger an iOS Shortcut. Steps execute sequentially on the device.",
    minItems: 1,
  }),
});

export interface FlowMateResponse {
  msg: string;
  shortcut?: string;
  data?: Record<string, unknown>;
  url?: string;
}

export function createRespondTool(
  onRespond: (responses: FlowMateResponse[]) => void,
): AgentTool<typeof respondSchema> {
  return {
    name: "respond",
    label: "Send response to FlowMate",
    description: `Send the final response to the user's FlowMate iOS app. You MUST call this tool to deliver your response. Each step can include a message and optionally trigger an iOS Shortcut by name. Use multiple steps for sequential automations.`,
    parameters: respondSchema,
    async execute(_id, params) {
      const responses: FlowMateResponse[] = params.steps.map((step) => ({
        msg: step.msg,
        shortcut: step.shortcut,
        data: step.data as Record<string, unknown> | undefined,
        url: step.url,
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
  schedule: Type.Optional(Type.String({ description: "Interval for cron jobs: '30s', '5m', '1h', '1d'. Required for cron type." })),
  prompt: Type.String({ description: "What to execute: shell command or agent prompt" }),
  execution_type: Type.Optional(Type.Union([Type.Literal("shell"), Type.Literal("prompt")], {
    description: "shell = run as bash command (default), prompt = send to AI agent",
  })),
  delay: Type.Optional(Type.String({ description: "Delay before first run: '5m', '1h', etc. Default: immediate" })),
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

// ── Tool factory ────────────────────────────────────────────────────────

type ToolName = "shell" | "read" | "write" | "ls" | "create_job" | "list_jobs" | "delete_job";

export function createTools(cwd: string, perms: Permissions): AgentTool<any>[] {
  const factories: Record<ToolName, () => AgentTool<any>> = {
    shell: () => createShellTool(cwd, perms),
    read: () => createReadTool(cwd, perms),
    write: () => createWriteTool(cwd, perms),
    ls: () => createLsTool(cwd, perms),
    create_job: () => createCreateJobTool(),
    list_jobs: () => createListJobsTool(),
    delete_job: () => createDeleteJobTool(),
  };

  const tools: AgentTool<any>[] = [];
  for (const name of perms.tools) {
    const factory = factories[name as ToolName];
    if (factory) {
      tools.push(factory());
    } else if (name !== "respond") {
      console.warn(`Unknown tool: ${name}`);
    }
  }

  return tools;
}
