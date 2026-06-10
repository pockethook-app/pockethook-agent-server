/**
 * Agent tools with granular permission enforcement.
 *
 * DO NOT ADD NEW INTEGRATIONS HERE.
 * User/personal integrations live in the extension layer, never in this file:
 *   - Shell/CLI wrapper → create_custom_tool (writes data/user/custom-tools/*.md)
 *   - Behavior or iOS Shortcut → create_user_skill (writes data/user/skills/*.md)
 *   - Multi-file project → workspace/<name>/, invoked from a custom-tool
 * Only framework-level primitives belong here (shell, read, write, jobs,
 * servers, memory, respond_*, custom-tool/skill factories, LLM plumbing).
 *
 * Permissions are checked before each tool execution. Denied operations
 * return an error result (the agent sees it and can adjust).
 */

import { spawn } from "child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "fs";
import { dirname, join, resolve, relative } from "path";
import { fileURLToPath } from "url";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Permissions } from "./permissions.js";
import { checkShellPermission, checkPathPermission } from "./permissions.js";
import { createJob, listJobs, deleteJob, updateJobEnabled } from "./jobs.js";
import type { Job } from "./jobs.js";
import { startServer, stopServer, listServers, getAvailableTunnels } from "./servers.js";
import { getCustomTools } from "./custom-tools.js";
import { commitWorkspace, backupConfigFile, backupSkills, configPaths } from "./versioning.js";
import type { Config, ReasoningSetting } from "./config.js";
import { REASONING_VALUES, updateEnvFile } from "./config.js";
import { logger } from "./logger.js";

import { VALID_ROOMS, VALID_HALLS, VALID_STATUSES } from "./vector-memory.js";

function stringEnum(values: readonly string[], description: string) {
  return Type.Union(values.map((v) => Type.Literal(v)) as any, { description });
}

const MAX_OUTPUT = 50_000; // chars

// Shared schema patterns (used by multiple tools; kept at top for clarity).
const INTERVAL_PATTERN = "^\\d+(?:s|m|h|d|w)$";
const CRON_PATTERN = "^\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+$";
const PROJECT_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,40}$";

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

// ── Base-path write guard ───────────────────────────────────────────────
//
// The framework ships `skills/`, `custom-tools/`, and `config/` (agent-
// instructions.md + personality.md) as read-only base files. Any user-
// authored content (new skills, custom tools, global behavior rules) must
// go into `data/user/` instead so that framework updates don't clobber
// user data. This guard is applied to the `write` tool — shell is left
// unguarded (too many ways to write via shell; we rely on the prompt +
// this guard being explicit enough).

const TOOLS_PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const USER_INSTRUCTIONS_PATH = resolve(TOOLS_PROJECT_ROOT, "data/user/instructions.md");
const USER_SKILLS_DIR = resolve(TOOLS_PROJECT_ROOT, "data/user/skills");
const USER_CUSTOM_TOOLS_DIR = resolve(TOOLS_PROJECT_ROOT, "data/user/custom-tools");

const BASE_WRITE_REDIRECTS: Array<{ base: string; redirect: string; kind: "file" | "dir" }> = [
  { base: configPaths.agentInstructions, redirect: USER_INSTRUCTIONS_PATH, kind: "file" },
  { base: configPaths.skillsDir, redirect: USER_SKILLS_DIR, kind: "dir" },
  { base: configPaths.customToolsDir, redirect: USER_CUSTOM_TOOLS_DIR, kind: "dir" },
];

function checkBaseWriteGuard(filePath: string): { allowed: true } | { allowed: false; reason: string } {
  for (const { base, redirect, kind } of BASE_WRITE_REDIRECTS) {
    const hit = kind === "file"
      ? filePath === base
      : filePath === base || filePath.startsWith(base + "/");
    if (hit) {
      const suggestion = kind === "file"
        ? redirect
        : filePath.replace(base, redirect);
      return {
        allowed: false,
        reason:
          `"${filePath}" is inside the read-only framework base and cannot be written directly. ` +
          `Write user-authored content to "${suggestion}" instead. ` +
          `Create the parent directory if it doesn't exist. ` +
          `This split keeps framework updates clean from user customization — see the "User customization layout" section of the system prompt.`,
      };
    }
  }
  return { allowed: true };
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

      const guard = checkBaseWriteGuard(filePath);
      if (!guard.allowed) return denied(guard.reason);

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

// ── PocketHook respond tools ─────────────────────────────────────────────

export interface PocketHookResponse {
  msg: string;
  shortcut?: string;
  data?: Record<string, unknown> | Record<string, unknown>[];
  url?: string;
  run_on?: "server" | "device";
}

// Shared: optional URL attached to a response. Rendered by the iOS app as a
// link / preview alongside the message. Sanitized for localhost rewrites.
const urlSchema = Type.Optional(Type.String({
  description: "Optional HTTPS URL attached to the response. Use this when the message references something the user should be able to tap (web page, image, document). Distinct from msg — the URL is rendered as a separate link, not embedded in the text.",
}));

// Shared: button spec used by respond_buttons and sequence steps.
const buttonSchema = Type.Object({
  label: Type.String({ description: "Button label shown to the user.", maxLength: 40 }),
  action: Type.Union([
    Type.Literal("sendMessage"),
    Type.Literal("openURL"),
    Type.Literal("triggerShortcut"),
  ], { description: "sendMessage: value is sent back as a new message. openURL: value is an https URL opened in the browser. triggerShortcut: value is the exact name of an iOS Shortcut to run." }),
  value: Type.String({ description: "Value for the action: message text, URL, or shortcut name." }),
});

function buildButtonsMsg(msg: string, buttons: Array<{ label: string; action: string; value: string }>): string {
  const lines = buttons.map((b) => `Button: ${b.label} | ${b.action}: ${b.value}`);
  return msg.trimEnd() + "\n" + lines.join("\n");
}

function wrapHtml(html: string): string {
  const trimmed = html.trimStart();
  if (trimmed.startsWith("<div") || trimmed.startsWith("<html") || trimmed.startsWith("<!DOCTYPE")) {
    return html;
  }
  return `<div>${html}</div>`;
}

// ── Respond URL sanitization ────────────────────────────────────────────
//
// The iOS device can't reach localhost / 127.0.0.1 on the Mac. Any URL the
// agent emits must be reachable externally (typically via a Tailscale or
// similar tunnel). Rather than relying on a prompt rule for this, we
// post-process every respond call:
//
//   1. Scan msg and url for localhost URLs.
//   2. If a managed server is listening on that port with an active tunnel,
//      rewrite the URL to the tunnel URL.
//   3. Otherwise, log a warning so the behavior is visible — the agent has
//      given the user something unreachable.
//
// If msg contains a rewritten URL and the step has no explicit url field,
// the first rewritten URL is also surfaced on the url field so it renders
// as a clickable link on the device.

const LOCALHOST_URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/[^\s<>")]*)?/gi;

function buildPortToTunnelMap(): Map<number, string> {
  const map = new Map<number, string>();
  try {
    const servers = listServers();
    for (const server of servers) {
      if (server.tunnelUrl && typeof server.port === "number") {
        map.set(server.port, server.tunnelUrl);
      }
    }
  } catch (err: any) {
    logger.warn(`Could not enumerate tunnels for URL sanitization: ${err.message}`);
  }
  return map;
}

function rewriteLocalhostUrls(
  text: string,
  tunnels: Map<number, string>,
): { text: string; rewrites: number; leaks: number; firstRewritten: string | null } {
  let rewrites = 0;
  let leaks = 0;
  let firstRewritten: string | null = null;

  const replaced = text.replace(LOCALHOST_URL_RE, (match, portStr: string | undefined, pathStr: string | undefined) => {
    const port = portStr ? parseInt(portStr, 10) : NaN;
    const tunnelBase = Number.isFinite(port) ? tunnels.get(port) : undefined;
    if (tunnelBase) {
      rewrites++;
      const rewritten = tunnelBase.replace(/\/$/, "") + (pathStr ?? "");
      if (!firstRewritten) firstRewritten = rewritten;
      return rewritten;
    }
    leaks++;
    return match;
  });

  return { text: replaced, rewrites, leaks, firstRewritten };
}

function sanitizeResponseStep(step: PocketHookResponse, tunnels: Map<number, string>): PocketHookResponse {
  const msgResult = rewriteLocalhostUrls(step.msg ?? "", tunnels);

  let url = step.url;
  let urlRewriteCount = 0;
  let urlLeakCount = 0;
  if (url) {
    const r = rewriteLocalhostUrls(url, tunnels);
    url = r.text;
    urlRewriteCount = r.rewrites;
    urlLeakCount = r.leaks;
  } else if (msgResult.firstRewritten) {
    // No explicit url field but msg had a rewritten localhost URL — surface
    // it on the url field so PocketHook renders it as a clickable link.
    url = msgResult.firstRewritten;
  }

  const totalLeaks = msgResult.leaks + urlLeakCount;
  const totalRewrites = msgResult.rewrites + urlRewriteCount;
  if (totalLeaks > 0) {
    logger.warn(`respond: ${totalLeaks} localhost URL(s) emitted with no matching tunnel — iOS device cannot reach them. Start the server with tunnel: true to make it externally accessible.`);
  }
  if (totalRewrites > 0) {
    logger.info(`respond: rewrote ${totalRewrites} localhost URL(s) to tunnel URL(s)`);
  }

  return { ...step, msg: msgResult.text, url };
}

function emit(
  onRespond: (responses: PocketHookResponse[]) => void,
  raw: PocketHookResponse | PocketHookResponse[],
): number {
  const tunnels = buildPortToTunnelMap();
  const list = Array.isArray(raw) ? raw : [raw];
  const sanitized = list.map((step) => sanitizeResponseStep(step, tunnels));
  onRespond(sanitized);
  return sanitized.length;
}

// ── respond_text ─────────────────────────────────────────────────────────

const respondTextSchema = Type.Object({
  text: Type.String({ description: "Message text. Markdown is supported (bold, italic, code, links, lists)." }),
  url: urlSchema,
});

function createRespondTextTool(onRespond: (responses: PocketHookResponse[]) => void): AgentTool<typeof respondTextSchema> {
  return {
    name: "respond_text",
    label: "Send text message",
    description: "Send a plain text (or Markdown) message to the user. This is the default way to reply when you just need to say something. For images use respond_image, for buttons respond_buttons, for HTML respond_html, for shortcuts respond_shortcut. NEVER embed image URLs or Button: lines in the text here — those require their dedicated tools.",
    parameters: respondTextSchema,
    async execute(_id, params) {
      emit(onRespond, { msg: params.text, url: params.url });
      return { content: [{ type: "text", text: "Text response sent." }], details: { kind: "text" } };
    },
  };
}

// ── respond_image ────────────────────────────────────────────────────────

const respondImageSchema = Type.Object({
  url: Type.String({
    pattern: "^https?://\\S+\\.(?:png|jpg|jpeg|gif|webp)(?:\\?\\S*)?$",
    description: "Image URL. MUST end in .png/.jpg/.jpeg/.gif/.webp (optionally with a querystring). The URL is sent as the ENTIRE message — no caption, no prefix, no suffix. If you need text alongside an image, send the text separately via respond_text AFTER this call is not possible (one response per turn); instead pick the more important of text vs image for this turn.",
  }),
});

function createRespondImageTool(onRespond: (responses: PocketHookResponse[]) => void): AgentTool<typeof respondImageSchema> {
  return {
    name: "respond_image",
    label: "Send image",
    description: "Send an image to the user. The iOS app renders the URL as an inline image ONLY when the msg is EXACTLY the URL (starts with https and ends with a valid image extension). This tool enforces that — you pass only the URL, nothing else. Don't try to caption it; any surrounding text breaks the render.",
    parameters: respondImageSchema,
    async execute(_id, params) {
      emit(onRespond, { msg: params.url });
      return { content: [{ type: "text", text: "Image response sent." }], details: { kind: "image" } };
    },
  };
}

// ── respond_buttons ──────────────────────────────────────────────────────

const respondButtonsSchema = Type.Object({
  msg: Type.String({ description: "Text shown above the buttons. Markdown supported." }),
  buttons: Type.Array(buttonSchema, {
    minItems: 1,
    maxItems: 5,
    description: "1 to 5 interactive buttons rendered below the msg.",
  }),
  url: urlSchema,
});

function createRespondButtonsTool(onRespond: (responses: PocketHookResponse[]) => void): AgentTool<typeof respondButtonsSchema> {
  return {
    name: "respond_buttons",
    label: "Send message with buttons",
    description: "Send a message with interactive buttons. The tool builds the exact `Button: label | action: value` syntax internally — do NOT hand-craft that syntax in respond_text. Each button has an action: sendMessage (text echoes back), openURL (opens browser), or triggerShortcut (runs iOS Shortcut by exact name).",
    parameters: respondButtonsSchema,
    async execute(_id, params) {
      const combined = buildButtonsMsg(params.msg, params.buttons);
      emit(onRespond, { msg: combined, url: params.url });
      return { content: [{ type: "text", text: `Sent message with ${params.buttons.length} button(s).` }], details: { kind: "buttons", count: params.buttons.length } };
    },
  };
}

// ── respond_shortcut ─────────────────────────────────────────────────────

const respondShortcutSchema = Type.Object({
  msg: Type.String({ description: "Message shown while the shortcut runs (e.g., 'Creating note...')." }),
  shortcut_name: Type.String({ description: "EXACT name of the iOS Shortcut as configured on the device — case and spacing matter." }),
  data: Type.Optional(Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Array(Type.Record(Type.String(), Type.Unknown())),
  ], { description: "Payload passed to the shortcut. Object for single-input shortcuts, array for batch ones." })),
  run_on: Type.Optional(Type.Union([Type.Literal("device"), Type.Literal("server")], {
    description: "device (default): run on the iOS device. server: run on the Mac server (only for skills with target: mac).",
  })),
  url: urlSchema,
});

function createRespondShortcutTool(onRespond: (responses: PocketHookResponse[]) => void): AgentTool<typeof respondShortcutSchema> {
  return {
    name: "respond_shortcut",
    label: "Trigger iOS Shortcut",
    description: "Send a message and trigger an iOS Shortcut by name. Use this when the user asks for an action that maps to a shortcut (create note, schedule calendar event, etc.) — the shortcut name must match exactly. Load the relevant skill first (load_skill) to know the required fields in `data`.",
    parameters: respondShortcutSchema,
    async execute(_id, params) {
      emit(onRespond, {
        msg: params.msg,
        shortcut: params.shortcut_name,
        data: params.data as Record<string, unknown> | Record<string, unknown>[] | undefined,
        run_on: params.run_on,
        url: params.url,
      });
      return { content: [{ type: "text", text: `Shortcut response sent (${params.shortcut_name}).` }], details: { kind: "shortcut", shortcut: params.shortcut_name } };
    },
  };
}

// ── respond_html ─────────────────────────────────────────────────────────

const respondHtmlSchema = Type.Object({
  html: Type.String({ description: "HTML content. Will be auto-wrapped in <div>…</div> if it doesn't already start with <div, <html or <!DOCTYPE — iOS requires one of those prefixes to detect HTML mode." }),
  url: urlSchema,
});

function createRespondHtmlTool(onRespond: (responses: PocketHookResponse[]) => void): AgentTool<typeof respondHtmlSchema> {
  return {
    name: "respond_html",
    label: "Send HTML",
    description: "Send rich HTML content. Use when Markdown isn't enough (tables, complex layouts, inline images via <img>). The tool auto-wraps in <div> if the prefix is missing.",
    parameters: respondHtmlSchema,
    async execute(_id, params) {
      emit(onRespond, { msg: wrapHtml(params.html), url: params.url });
      return { content: [{ type: "text", text: "HTML response sent." }], details: { kind: "html" } };
    },
  };
}

// ── respond_sequence ─────────────────────────────────────────────────────

const seqTextStepSchema = Type.Object({
  kind: Type.Literal("text"),
  text: Type.String({ description: "Message text for this step." }),
  url: urlSchema,
});

const seqShortcutStepSchema = Type.Object({
  kind: Type.Literal("shortcut"),
  msg: Type.String(),
  shortcut_name: Type.String(),
  data: Type.Optional(Type.Union([
    Type.Record(Type.String(), Type.Unknown()),
    Type.Array(Type.Record(Type.String(), Type.Unknown())),
  ])),
  run_on: Type.Optional(Type.Union([Type.Literal("device"), Type.Literal("server")])),
  url: urlSchema,
});

const seqButtonsStepSchema = Type.Object({
  kind: Type.Literal("buttons"),
  msg: Type.String(),
  buttons: Type.Array(buttonSchema, { minItems: 1, maxItems: 5 }),
  url: urlSchema,
});

const respondSequenceSchema = Type.Object({
  steps: Type.Array(Type.Union([
    seqTextStepSchema,
    seqShortcutStepSchema,
    seqButtonsStepSchema,
  ]), {
    minItems: 2,
    description: "Ordered steps. iOS concatenates all msg values into ONE bubble (with bullets) and runs each shortcut in order. This is NOT multi-bubble — it's for chaining shortcuts with textual acks. If you just want to reply with one message, use respond_text.",
  }),
});

type SeqStep =
  | { kind: "text"; text: string; url?: string }
  | { kind: "shortcut"; msg: string; shortcut_name: string; data?: Record<string, unknown> | Record<string, unknown>[]; run_on?: "device" | "server"; url?: string }
  | { kind: "buttons"; msg: string; buttons: Array<{ label: string; action: "sendMessage" | "openURL" | "triggerShortcut"; value: string }>; url?: string };

function createRespondSequenceTool(onRespond: (responses: PocketHookResponse[]) => void): AgentTool<typeof respondSequenceSchema> {
  return {
    name: "respond_sequence",
    label: "Send sequence of response steps",
    description: "Chain multiple response steps in one turn. iOS concatenates the msg values into ONE bubble with bullets, and runs shortcuts in order. Image and HTML steps are NOT allowed here — they require the full msg to be just the URL or HTML, which breaks in the concatenation. Use this only when you need multiple shortcuts with textual acks.",
    parameters: respondSequenceSchema,
    async execute(_id, params) {
      const responses: PocketHookResponse[] = (params.steps as SeqStep[]).map((step) => {
        if (step.kind === "text") {
          return { msg: step.text, url: step.url };
        }
        if (step.kind === "shortcut") {
          return {
            msg: step.msg,
            shortcut: step.shortcut_name,
            data: step.data,
            run_on: step.run_on,
            url: step.url,
          };
        }
        return { msg: buildButtonsMsg(step.msg, step.buttons), url: step.url };
      });
      const count = emit(onRespond, responses);
      return { content: [{ type: "text", text: `Sequence sent (${count} step${count > 1 ? "s" : ""}).` }], details: { kind: "sequence", count } };
    },
  };
}

// ── Public factory: all respond sub-tools ────────────────────────────────

export function createRespondTools(
  onRespond: (responses: PocketHookResponse[]) => void,
): AgentTool<any>[] {
  return [
    createRespondTextTool(onRespond),
    createRespondImageTool(onRespond),
    createRespondButtonsTool(onRespond),
    createRespondShortcutTool(onRespond),
    createRespondHtmlTool(onRespond),
    createRespondSequenceTool(onRespond),
  ];
}

// ── run_code_job (compound tool) ─────────────────────────────────────────
//
// Encapsulates the "respond ack + create background programming job"
// pattern so the agent only has to make one decision ("is this a
// programming task?") instead of orchestrating two tool calls. The handler
// creates a prompt-type job (executed by the configured model) and emits
// the user-facing ack via the shared respond callback.

const runCodeJobSchema = Type.Object({
  task: Type.String({ description: "What the programming job should do. Natural language. Include success criteria (e.g., 'create a Bun + Hono API with GET /health, install deps, verify it compiles')." }),
  project_name: Type.Optional(Type.String({
    pattern: PROJECT_NAME_PATTERN,
    description: "Workspace project to work in (e.g. 'my-blog', 'dashboard'). Lowercase letters/digits/underscore/dash only, max 40 chars. NEVER pass a path — the tool resolves it under the workspace root. Omit to work at the workspace root itself. The project is created if it doesn't exist yet.",
  })),
  timeout: Type.Optional(Type.String({ pattern: INTERVAL_PATTERN, description: "Max runtime. '30m' default, '1h' for heavy tasks." })),
  ack_message: Type.Optional(Type.String({ description: "User-facing ack sent immediately, in the user's language. Default: 'On it — I'll let you know when it's done.'" })),
});

export function createRunCodeJobTool(
  cwd: string,
  onRespond?: (responses: PocketHookResponse[]) => void,
): AgentTool<typeof runCodeJobSchema> {
  return {
    name: "run_code_job",
    label: "Run programming task as a background job",
    description: "Run any programming task (create project, review code, debug, build, tests, refactor) as a background job executed by the configured model. Use this INSTEAD of calling shell/read/write directly for code work — PocketHook's HTTP request has a short timeout, so heavy work must go to a background job. This tool handles the respond ack + job creation in one call. Do NOT use for single simple reads (e.g., 'show me file X') — use the `read` tool for that. If you are already running inside a background job (your message starts with [BACKGROUND JOB]), do NOT call this; do the work directly.",
    parameters: runCodeJobSchema,
    async execute(_id, params) {
      try {
        const defaultAck = "On it — I'll let you know when it's done.";
        const ackMessage = (params.ack_message ?? defaultAck).trim() || defaultAck;
        const timeout = params.timeout ?? "30m";

        const workspaceRoot = cwd;
        const targetDir = params.project_name
          ? join(workspaceRoot, params.project_name)
          : workspaceRoot;

        if (!existsSync(targetDir)) {
          mkdirSync(targetDir, { recursive: true });
        }

        const jobPrompt = `Working directory: ${targetDir}\n\nTask:\n${params.task}\n\nComplete the task end-to-end. Use your shell/read/write tools as needed, and verify your work (builds compile, tests pass, files exist). Always use non-interactive flags (--yes, -y, --defaults, --no-interactive) in CLI commands — you cannot respond to interactive prompts.`;

        const jobName = params.task.length > 60 ? params.task.slice(0, 57) + "..." : params.task;

        const job = createJob({
          name: jobName,
          type: "once",
          schedule: undefined,
          prompt: jobPrompt,
          execution_type: "prompt",
          delay: undefined,
          timeout,
          silent: undefined,
          on_complete_shortcut: undefined,
          on_complete_data: undefined,
        });

        // Emit the user-facing ack directly if the respond callback is wired.
        // When run_code_job is called from a flow that doesn't have a
        // respond channel (e.g., unit tests), the agent can still call
        // respond manually using the message in the returned text.
        if (onRespond) {
          onRespond([{ msg: ackMessage }]);
        }

        return {
          content: [{
            type: "text",
            text: `Job #${job.id} "${jobName}" created (once/prompt, timeout ${timeout}). Ack "${ackMessage}" ${onRespond ? "sent to user" : "(no respond channel — call respond manually)"}. Do NOT call respond again for this task; the user will receive the result when the job completes.`,
          }],
          details: { jobId: job.id, ackMessage, targetDir },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error creating code job: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── Workspace project tools ──────────────────────────────────────────────
//
// Dedicated, name-only tools for managing projects under the workspace dir.
// Before these tools the agent had to compose paths (often getting them
// wrong: workspace/workspace/…). These tools accept just a project NAME and
// resolve the absolute path internally.

const createProjectSchema = Type.Object({
  name: Type.String({
    pattern: PROJECT_NAME_PATTERN,
    description: "Project name. Lowercase letters/digits/underscore/dash, starting with a letter, max 40 chars. The actual directory is created at <workspace>/<name>/.",
  }),
  template: Type.Optional(Type.Union([
    Type.Literal("empty"),
    Type.Literal("node"),
    Type.Literal("python"),
    Type.Literal("static"),
  ], { description: "Optional scaffold. empty (default): just the directory. node: package.json stub. python: main.py + requirements.txt. static: index.html." })),
  description: Type.Optional(Type.String({ description: "One-line description stored in a README.md if the template has one." })),
});

function scaffoldProject(dir: string, name: string, template: string, description: string | undefined): string[] {
  const created: string[] = [];
  if (template === "empty") return created;

  if (template === "node") {
    const pkg = {
      name,
      version: "0.0.1",
      ...(description ? { description } : {}),
      scripts: { start: "node index.js" },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    writeFileSync(join(dir, "index.js"), `console.log("${name} running");\n`);
    created.push("package.json", "index.js");
  } else if (template === "python") {
    writeFileSync(join(dir, "main.py"), `def main():\n    print("${name} running")\n\n\nif __name__ == "__main__":\n    main()\n`);
    writeFileSync(join(dir, "requirements.txt"), "");
    created.push("main.py", "requirements.txt");
  } else if (template === "static") {
    const html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>${name}</title>\n</head>\n<body>\n  <h1>${name}</h1>\n  ${description ? `<p>${description}</p>` : ""}\n</body>\n</html>\n`;
    writeFileSync(join(dir, "index.html"), html);
    created.push("index.html");
  }
  return created;
}

function createCreateProjectTool(cwd: string): AgentTool<typeof createProjectSchema> {
  return {
    name: "create_project",
    label: "Create workspace project",
    description: "Create a new project directory inside the workspace. Pass only a NAME — the tool resolves the path automatically. Optionally pick a template (node/python/static) for a minimal scaffold. Use this instead of building paths with shell/write.",
    parameters: createProjectSchema,
    async execute(_id, params) {
      const dir = join(cwd, params.name);
      if (existsSync(dir)) {
        return {
          content: [{ type: "text", text: `Project "${params.name}" already exists at ${dir}. Use a different name or work on the existing one.` }],
          details: { error: "exists", dir },
        };
      }
      try {
        mkdirSync(dir, { recursive: true });
        const template = params.template ?? "empty";
        const created = scaffoldProject(dir, params.name, template, params.description);
        commitWorkspace(`auto: create project ${params.name}`);
        return {
          content: [{ type: "text", text: `Created project "${params.name}" at ${dir} (${template} template). Files: ${created.length > 0 ? created.join(", ") : "none (empty)"}.` }],
          details: { name: params.name, dir, template, files: created },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error creating project: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

const listProjectsSchema = Type.Object({});

function createListProjectsTool(cwd: string): AgentTool<typeof listProjectsSchema> {
  return {
    name: "list_projects",
    label: "List workspace projects",
    description: "List all projects (subdirectories) under the workspace. Use this before creating a new project to check for name collisions, or when the user asks what they have.",
    parameters: listProjectsSchema,
    async execute() {
      try {
        const entries = readdirSync(cwd, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort();
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "No projects in workspace yet." }], details: { count: 0 } };
        }
        return {
          content: [{ type: "text", text: `Projects (${entries.length}):\n` + entries.map((n) => `- ${n}`).join("\n") }],
          details: { count: entries.length, projects: entries },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error listing projects: ${err.message}` }], details: { error: err.message } };
      }
    },
  };
}

const deleteProjectSchema = Type.Object({
  name: Type.String({ pattern: PROJECT_NAME_PATTERN, description: "Project name to delete (must match an existing workspace project)." }),
  confirm: Type.Literal(true, { description: "Must be `true`. An explicit confirmation so this destructive call isn't made by accident." }),
});

function createDeleteProjectTool(cwd: string, perms: Permissions): AgentTool<typeof deleteProjectSchema> {
  return {
    name: "delete_project",
    label: "Delete workspace project",
    description: "Delete a workspace project (removes its directory recursively). Requires `confirm: true`. Ask the user for explicit confirmation before calling — this cannot be undone outside of git history.",
    parameters: deleteProjectSchema,
    async execute(_id, params) {
      const dir = join(cwd, params.name);
      if (!existsSync(dir)) {
        return { content: [{ type: "text", text: `Project "${params.name}" not found at ${dir}.` }], details: { error: "not_found" } };
      }
      // Use shell rm -rf so we reuse the shell permission layer rather than
      // reimplementing a recursive delete here.
      const check = checkShellPermission(`rm -rf ${dir}`, perms);
      if (!check.allowed) return denied(check.reason!);
      try {
        const { spawnSync } = await import("child_process");
        const result = spawnSync("rm", ["-rf", dir]);
        if (result.status !== 0) {
          return { content: [{ type: "text", text: `Error deleting project: ${result.stderr?.toString() ?? "unknown"}` }], details: { error: "rm_failed" } };
        }
        commitWorkspace(`auto: delete project ${params.name}`);
        return {
          content: [{ type: "text", text: `Deleted project "${params.name}".` }],
          details: { name: params.name },
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error deleting project: ${err.message}` }], details: { error: err.message } };
      }
    },
  };
}

// ── Job tools ────────────────────────────────────────────────────────────
//
// Typed replacements for the old `create_job`. Two tools (once / cron) +
// discriminated-union `body` prevent the invalid combinations the LLM used
// to produce (e.g. type=once with a schedule, shell+prompt mixups).

const jobBodySchema = Type.Union([
  Type.Object({
    kind: Type.Literal("shell"),
    command: Type.String({ description: "Bash command to run. Use non-interactive flags (--yes, -y, --defaults) — you cannot respond to prompts." }),
  }),
  Type.Object({
    kind: Type.Literal("prompt"),
    prompt: Type.String({ description: "Natural-language task sent to the AI agent. Include success criteria so the agent can verify completion." }),
  }),
], { description: "What the job does. Pick 'shell' to run a bash command, 'prompt' to run an AI sub-agent." });

const cronScheduleSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("interval"),
    value: Type.String({ pattern: INTERVAL_PATTERN, description: "Interval like '30s', '5m', '1h', '1d', '2w'." }),
  }),
  Type.Object({
    kind: Type.Literal("cron"),
    expression: Type.String({ pattern: CRON_PATTERN, description: "5-field cron expression: 'min hour day month weekday'. Examples: '0 9 * * MON', '*/30 * * * *', '0 0 1 * *'." }),
  }),
], { description: "Cron job schedule. Pick 'interval' for simple periods, 'cron' for specific times." });

type JobBody =
  | { kind: "shell"; command: string }
  | { kind: "prompt"; prompt: string };

function bodyToOpts(body: JobBody): { prompt: string; execution_type: "shell" | "prompt" } {
  return body.kind === "shell"
    ? { prompt: body.command, execution_type: "shell" }
    : { prompt: body.prompt, execution_type: "prompt" };
}

// ── create_once_job ──────────────────────────────────────────────────────

const createOnceJobSchema = Type.Object({
  name: Type.String({ description: "Human-readable job name." }),
  body: jobBodySchema,
  delay: Type.Optional(Type.String({ pattern: INTERVAL_PATTERN, description: "Delay before the (single) run. Default: immediate." })),
  timeout: Type.Optional(Type.String({ pattern: INTERVAL_PATTERN, description: "Max runtime. Default: 60s for shell, 30m for prompt." })),
  silent: Type.Optional(Type.Boolean({ description: "If true, completion won't trigger /jobs polling." })),
  on_complete_shortcut: Type.Optional(Type.String({ description: "iOS Shortcut to trigger on completion (exact name). Receives the job output as `output`." })),
  on_complete_data: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Extra data fields passed to the completion shortcut." })),
});

function createOnceJobTool(): AgentTool<typeof createOnceJobSchema> {
  return {
    name: "create_once_job",
    label: "Create one-off background job",
    description: "Create a background job that runs ONCE. Use for long-running work the agent can't do inline (deep research, multi-page scraping, reports). For programming tasks prefer `run_code_job`. Pass `body: { kind: 'shell', command }` for a bash command, or `body: { kind: 'prompt', prompt }` for an AI-driven task.",
    parameters: createOnceJobSchema,
    async execute(_id, params) {
      try {
        const { prompt, execution_type } = bodyToOpts(params.body as JobBody);
        const job = createJob({
          name: params.name,
          type: "once",
          prompt,
          execution_type,
          delay: params.delay,
          timeout: params.timeout,
          silent: params.silent,
          on_complete_shortcut: params.on_complete_shortcut,
          on_complete_data: params.on_complete_data as Record<string, unknown> | undefined,
        });
        const nextRun = new Date(job.next_run_at).toISOString();
        return {
          content: [{ type: "text", text: `Job #${job.id} "${job.name}" created (once, ${execution_type}). Runs at: ${nextRun}` }],
          details: { jobId: job.id },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error creating once job: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ── create_cron_job ──────────────────────────────────────────────────────

const createCronJobSchema = Type.Object({
  name: Type.String({ description: "Human-readable job name." }),
  schedule: cronScheduleSchema,
  body: jobBodySchema,
  timeout: Type.Optional(Type.String({ pattern: INTERVAL_PATTERN, description: "Max runtime per run." })),
  silent: Type.Optional(Type.Boolean({ description: "If true, completion won't trigger /jobs polling." })),
});

function createCronJobTool(): AgentTool<typeof createCronJobSchema> {
  return {
    name: "create_cron_job",
    label: "Create recurring background job",
    description: "Create a background job that runs on a SCHEDULE. Use `schedule: { kind: 'interval', value: '5m' }` for simple periods or `schedule: { kind: 'cron', expression: '0 9 * * MON' }` for specific times. Body is the same shell/prompt union as create_once_job.",
    parameters: createCronJobSchema,
    async execute(_id, params) {
      try {
        const schedule = params.schedule as { kind: "interval"; value: string } | { kind: "cron"; expression: string };
        const scheduleStr = schedule.kind === "interval" ? schedule.value : schedule.expression;
        const { prompt, execution_type } = bodyToOpts(params.body as JobBody);
        const job = createJob({
          name: params.name,
          type: "cron",
          schedule: scheduleStr,
          prompt,
          execution_type,
          timeout: params.timeout,
          silent: params.silent,
        });
        const nextRun = new Date(job.next_run_at).toISOString();
        return {
          content: [{ type: "text", text: `Job #${job.id} "${job.name}" created (cron "${scheduleStr}", ${execution_type}). Next run: ${nextRun}` }],
          details: { jobId: job.id },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error creating cron job: ${err.message}` }],
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
  num_results: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: "Number of results to return (1-10, default 5)" })),
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
  name: Type.String({ description: "Human-readable name for the server (e.g., 'Hugo blog', 'React app')." }),
  command: Type.String({ description: "Shell command to start the dev server. Use $PORT as the port placeholder (e.g., 'hugo server -p $PORT', 'npm run dev -- --port $PORT'). Bind to 0.0.0.0/--host when possible so external requests (tunnel) reach it." }),
  project_name: Type.String({
    pattern: PROJECT_NAME_PATTERN,
    description: "Workspace project to run the server in. Name only — the tool resolves the path. Create the project first with create_project if it doesn't exist.",
  }),
  port: Type.Optional(Type.Number({ description: "Preferred port. Default: auto-assign starting from 4000." })),
  tunnel: Type.Optional(Type.Boolean({ description: "Expose via HTTPS tunnel (Tailscale). Default: false. Set to true whenever the user will open the URL on their phone." })),
});

function createStartServerTool(cwd: string, perms: Permissions): AgentTool<typeof startServerSchema> {
  return {
    name: "start_server",
    label: "Start a dev server",
    description: "Start a long-running dev server for a workspace project. The server runs in the background and can optionally be exposed via HTTPS tunnel so the user can reach it from their iOS device. Use $PORT in the command as a placeholder for the assigned port. Set tunnel: true whenever the user will actually open the URL on their phone — localhost URLs are unreachable from the device and are returned as errors.",
    parameters: startServerSchema,
    async execute(_id, params) {
      const check = checkShellPermission(params.command, perms);
      if (!check.allowed) return denied(check.reason!);

      // Pre-flight: if tunnel is requested, make sure at least one tunnel
      // tool is installed before spawning the server. Failing fast avoids
      // leaving an unreachable localhost process behind.
      if (params.tunnel) {
        const tunnels = getAvailableTunnels();
        const anyAvailable = tunnels.some((t) => t.available);
        if (!anyAvailable) {
          const names = tunnels.map((t) => t.name).join(", ");
          return {
            content: [{
              type: "text",
              text: `tunnel: true was requested but no tunnel tool is installed (${names}). Install Tailscale (recommended on macOS) or start the server with tunnel: false if it only needs local access. iOS devices cannot reach localhost URLs directly.`,
            }],
            details: { error: "no_tunnel_available", tunnels },
          };
        }
      }

      try {
        const resolvedCwd = join(cwd, params.project_name);
        if (!existsSync(resolvedCwd)) {
          return {
            content: [{ type: "text", text: `Project "${params.project_name}" doesn't exist. Create it with create_project first.` }],
            details: { error: "project_not_found", project_name: params.project_name },
          };
        }
        const entry = startServer({
          name: params.name,
          command: params.command,
          cwd: resolvedCwd,
          port: params.port,
          tunnel: params.tunnel,
        });

        // If tunnel was requested but setup failed post-spawn, stop the
        // orphan server and surface the error. Without this, the agent
        // silently gets a localhost-only server it would then leak to the
        // device.
        if (params.tunnel && !entry.tunnelUrl) {
          stopServer(entry.id);
          return {
            content: [{
              type: "text",
              text: `Server "${params.name}" started on port ${entry.port} but tunnel setup failed. The server has been stopped. Check that Tailscale Serve is available and retry, or call start_server with tunnel: false if local-only access is acceptable.`,
            }],
            details: { error: "tunnel_setup_failed", port: entry.port },
          };
        }

        const primaryUrl = entry.tunnelUrl ?? `http://localhost:${entry.port}`;
        let msg = `Server "${entry.name}" started (ID #${entry.id}, port ${entry.port}, PID ${entry.pid}).`;
        msg += `\nURL: ${primaryUrl}`;
        if (entry.tunnelUrl) {
          msg += `\nLocal (host-only): http://localhost:${entry.port}`;
          msg += `\nThis URL is reachable from the user's iOS device — use it in the respond url field.`;
        } else {
          msg += `\nNOTE: This URL is only reachable from the host machine. Do NOT send it to the user's iOS device — it won't resolve. Restart with tunnel: true if the user needs to view the project on their phone.`;
        }
        return {
          content: [{ type: "text", text: msg }],
          details: { id: entry.id, port: entry.port, tunnelUrl: entry.tunnelUrl, primaryUrl },
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
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Max results to return (1-20, default 10)" })),
  semantic: Type.Optional(Type.Boolean({ description: "Use semantic (vector) search instead of keyword search. Better for conceptual queries. Default: false" })),
  wing: Type.Optional(Type.String({ description: "Filter by wing (entity). E.g., 'user', 'project:blog', 'person:juan'" })),
  room: Type.Optional(stringEnum(VALID_ROOMS, `Filter by room (memory type). One of: ${VALID_ROOMS.join(", ")}.`)),
  status: Type.Optional(stringEnum(VALID_STATUSES, `Filter by PARA status: ${VALID_STATUSES.join(", ")}. If omitted, archived items are excluded by default.`)),
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
          if (params.room) filters.room = params.room as string;
          if (params.status) filters.status = params.status as string;
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
  status: stringEnum(VALID_STATUSES, `New PARA status. One of: ${VALID_STATUSES.join(", ")}.`),
  room: Type.Optional(stringEnum(VALID_ROOMS, `Optional: only update memories matching this room. One of: ${VALID_ROOMS.join(", ")}.`)),
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
        const count = updateStatus(params.wing, params.status as string, params.room as string | undefined);
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
  project_slug: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9_]*$", description: "Slug identifying this project's predicates in the knowledge graph. Lowercase letters, digits, underscores; must start with a letter (e.g., 'visit_barcelona', 'scifi_novel', 'blog_redesign'). When provided, the handler automatically invalidates every active triple whose predicate contains this slug (e.g., 'scheduled_visit_barcelona', 'planning_visit_barcelona', 'confirmed_visit_barcelona') AND records a single cancellation/completion triple. This replaces the old two-step pattern." })),
  reason: Type.Optional(Type.Union([Type.Literal("cancelled"), Type.Literal("completed")], { description: "Why the project is closing. Defaults to 'completed'. Combined with project_slug to form the new triple predicate (e.g. reason='cancelled' + slug='visit_barcelona' → ('user','cancelled_visit_barcelona',<today>))." })),
  hall: Type.Optional(stringEnum(VALID_HALLS, `Optional hall filter to narrow the scope. One of: ${VALID_HALLS.join(", ")}.`)),
  threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Similarity threshold 0-1 (default 0.55). Higher = stricter matching. Only vectors above this threshold are affected." })),
});

function createCompleteProjectTool(): AgentTool<typeof completeProjectSchema> {
  return {
    name: "complete_project",
    label: "Complete or cancel a project (PARA)",
    description: "Close a specific project in one call. (1) Uses semantic similarity on project_description to archive related events/decisions/requests while keeping reference material as 'resource'. (2) If project_slug is provided, ALSO invalidates all active knowledge-graph triples whose predicate contains that slug, and records a single cancellation/completion triple — so you no longer need a separate remember_fact call. Use this whenever the user cancels, abandons, or completes a plan. Provide a precise project_description that identifies THIS project uniquely.",
    parameters: completeProjectSchema,
    async execute(_id, params) {
      try {
        const { completeProject } = await import("./vector-memory.js");
        const { invalidateTriplesByProjectSlug, addTriple } = await import("./knowledge-graph.js");

        const vectorResult = await completeProject(params.project_description, {
          hall: params.hall as string | undefined,
          threshold: params.threshold,
        });

        let invalidatedTriples = 0;
        let recordedPredicate: string | null = null;

        if (params.project_slug) {
          const slug = params.project_slug.trim();
          if (slug) {
            invalidatedTriples = invalidateTriplesByProjectSlug(slug, "user");

            const reason = params.reason ?? "completed";
            recordedPredicate = `${reason}_${slug}`;
            const today = new Date().toISOString().slice(0, 10);
            addTriple("user", recordedPredicate, today);
          }
        }

        const parts = [
          `Project "${params.project_description}" closed: scanned ${vectorResult.scanned} project vectors, ${vectorResult.archived} archived, ${vectorResult.keptAsResource} kept as resource.`,
        ];
        if (params.project_slug) {
          parts.push(`Knowledge graph: invalidated ${invalidatedTriples} triple(s) matching slug "${params.project_slug}"; recorded ("user", "${recordedPredicate}", today).`);
        }

        return {
          content: [{ type: "text", text: parts.join(" ") }],
          details: {
            ...vectorResult,
            invalidatedTriples,
            recordedPredicate,
          },
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

// ── create_custom_tool ───────────────────────────────────────────────────
//
// Typed writer for user-layer custom tools. Avoids two classes of bug:
//   1. The agent tries to edit src/tools.ts (the core file) instead of
//      adding a user-layer definition.
//   2. The agent hand-writes the markdown and gets the parser format
//      slightly wrong, so the tool never loads.
// Schema enforces the shape; generator produces a file the parser accepts.

const paramTypeSchema = Type.Union([
  Type.Literal("string"),
  Type.Literal("number"),
  Type.Literal("boolean"),
]);

const customToolParamSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_]*$", description: "Parameter name (lowercase, letters/digits/underscore)." }),
  type: paramTypeSchema,
  required: Type.Boolean(),
  description: Type.String(),
  default: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()], { description: "Default value (only for optional params)." })),
});

const createCustomToolSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_]*$", description: "Tool name (what the agent calls). Lowercase, letters/digits/underscore, max 40 chars." }),
  display_name: Type.String({ description: "Human-readable title shown in the custom tools index." }),
  description: Type.String({ description: "What the tool does and when to use it. Shown to the agent — be concrete." }),
  command: Type.String({ description: "Shell command. MUST invoke a file inside workspace/<name>/ (commands run with cwd=workspace), e.g. `bun <name>/src/cli.ts --flag $flag`. Inline scripts (python3 -c, node -e, bash -c, heredocs) are REJECTED — put the logic in workspace/<name>/. Use $param_name for placeholders — substituted with the agent's arguments at call time." }),
  install: Type.Optional(Type.String({ description: "Optional one-off install/setup command (e.g., 'brew install foo'). Runs once on first load if the dep is missing." })),
  parameters: Type.Array(customToolParamSchema, { description: "Parameters the agent must/may pass. Names must match the $name placeholders in command." }),
  overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing user-layer tool with the same name. Default: false." })),
});

const CORE_TOOL_NAMES = new Set([
  "shell", "read", "write", "ls",
  "create_project", "list_projects", "delete_project",
  "create_once_job", "create_cron_job", "list_jobs", "delete_job",
  "web_search", "web_fetch",
  "start_server", "stop_server", "list_servers",
  "search_memory", "remember_fact", "query_facts",
  "load_skill", "update_memory_status", "complete_project",
  "run_code_job",
  "respond_text", "respond_image", "respond_buttons", "respond_shortcut", "respond_html", "respond_sequence",

  "create_custom_tool", "create_user_skill",
]);

type CustomToolParam = {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description: string;
  default?: string | number | boolean;
};

function renderCustomToolMarkdown(params: {
  name: string;
  display_name: string;
  description: string;
  command: string;
  install?: string;
  parameters: CustomToolParam[];
}): string {
  const lines: string[] = [];
  lines.push(`### ${params.display_name}`);
  lines.push("");
  lines.push(`Tool name: \`${params.name}\``);
  lines.push("");
  lines.push(params.description.trim());
  lines.push("");
  if (params.install) {
    lines.push(`Install: \`${params.install}\``);
    lines.push("");
  }
  lines.push(`Command: \`${params.command}\``);
  lines.push("");
  lines.push("Parameters:");
  for (const p of params.parameters) {
    const req = p.required ? "required" : "optional";
    const def = p.default !== undefined && p.default !== null ? `. Default: ${p.default}` : "";
    lines.push(`- ${p.name} (${p.type}, ${req}): ${p.description.replace(/\.\s*$/, "")}${def}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Enforce the "integration pattern": custom-tool Commands must invoke an
// executable inside workspace/<name>/ rather than embed logic inline. This is
// the guardrail that keeps the extension system from degenerating into a shell
// of one-liners that bypass the project/stack defaults in integrationDefaults.
function checkCommandShape(command: string): string | null {
  const cmd = command.trim();

  if (/\b(python3?|node|bun|deno|ruby|perl|php|bash|sh|zsh)\s+-[ce]\b/.test(cmd)) {
    return `Invalid Command: inline interpreter flags (-e/-c) are not allowed. The tool's logic must live in workspace/<name>/ and be invoked via \`bun <name>/src/cli.ts …\` (or the equivalent for your stack). See custom-tools/_example-integration.md for the canonical shape.`;
  }

  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) {
    return `Invalid Command: heredocs (<<EOF, <<'PY', …) are not allowed. Move the script into workspace/<name>/ and invoke it. See custom-tools/_example-integration.md for the pattern.`;
  }

  if (!cmd.includes("/")) {
    return `Invalid Command: must invoke a file under workspace/<name>/ (commands run with cwd=workspace). Create a project in workspace/<name>/ with the real code and make Command reference it, e.g. \`bun <name>/src/cli.ts --flag $flag\`. See custom-tools/_example-integration.md.`;
  }

  return null;
}

function createCreateCustomToolTool(): AgentTool<typeof createCustomToolSchema> {
  return {
    name: "create_custom_tool",
    label: "Create a user custom tool",
    description: "Create or overwrite a user-layer custom tool. The tool is stored at data/user/custom-tools/<name>.md, hot-reloaded on next request, and available to the agent immediately. NEVER edit src/tools.ts or any other core file — use this. Before calling: read data/user/prefs.json → integrationDefaults for the stack (language/runtime/compileToBinary); scaffold a proper project under workspace/<name>/ with the real code in that stack; then call this tool with Command invoking that project (e.g. `bun <name>/src/cli.ts …`). Inline scripts (python3 -c, node -e, heredocs) are REJECTED by this tool — the logic MUST live in workspace/<name>/. See custom-tools/_example-integration.md for the canonical shape.",
    parameters: createCustomToolSchema,
    async execute(_id, params) {
      const name = params.name;
      if (CORE_TOOL_NAMES.has(name)) {
        return {
          content: [{ type: "text", text: `"${name}" is a core tool name — pick a different one for the user-layer custom tool.` }],
          details: { error: "reserved_name" },
        };
      }
      // Validate placeholders are declared as parameters.
      const placeholders = Array.from(params.command.matchAll(/\$([a-z_][a-z0-9_]*)/g)).map((m) => m[1]!);
      const declared = new Set((params.parameters as CustomToolParam[]).map((p) => p.name));
      const missing = placeholders.filter((p) => !declared.has(p));
      if (missing.length > 0) {
        return {
          content: [{ type: "text", text: `Command references unknown placeholder(s): ${missing.map((m) => "$" + m).join(", ")}. Declare them as parameters first.` }],
          details: { error: "unknown_placeholders", missing },
        };
      }

      // Reject inline-script commands — the logic must live in workspace/<name>/.
      const cmdViolation = checkCommandShape(params.command);
      if (cmdViolation) {
        return {
          content: [{ type: "text", text: cmdViolation }],
          details: { error: "invalid_command_shape" },
        };
      }

      const USER_CT_DIR = resolve(TOOLS_PROJECT_ROOT, "data/user/custom-tools");
      if (!existsSync(USER_CT_DIR)) mkdirSync(USER_CT_DIR, { recursive: true });
      const target = join(USER_CT_DIR, `${name}.md`);
      if (existsSync(target) && !params.overwrite) {
        return {
          content: [{ type: "text", text: `User-layer tool "${name}" already exists at ${target}. Pass overwrite: true to replace it, or pick a different name.` }],
          details: { error: "exists", path: target },
        };
      }

      const md = renderCustomToolMarkdown({
        name: params.name,
        display_name: params.display_name,
        description: params.description,
        command: params.command,
        install: params.install,
        parameters: params.parameters as CustomToolParam[],
      });
      writeFileSync(target, md);
      return {
        content: [{ type: "text", text: `Custom tool "${name}" written to ${target}. It will load on the next request (hot-reload).` }],
        details: { name, path: target, bytes: md.length },
      };
    },
  };
}

// ── create_user_skill ────────────────────────────────────────────────────
//
// Typed writer for user-layer skills. Same motivation as create_custom_tool:
// the agent should never hand-craft the frontmatter YAML.

const createUserSkillSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]*$", description: "Skill filename (without .md)." }),
  title: Type.String({ description: "Human-readable title shown in the skills index." }),
  description: Type.String({ description: "One-line summary of the skill's purpose." }),
  shortcuts: Type.Optional(Type.Array(Type.String(), { description: "iOS Shortcut names this skill covers. Must match device names exactly." })),
  target: Type.Optional(Type.Union([Type.Literal("device"), Type.Literal("mac")], { description: "Where the skill's shortcuts run. device (default) = iOS via PocketHook; mac = Mac server via shortcuts://." })),
  sync_app: Type.Optional(Type.String({ description: "iOS app to nudge after server-side runs (for iCloud sync)." })),
  body: Type.String({ description: "Markdown body (shortcut definitions, behavior rules, examples). The tool prepends the YAML frontmatter; you just write the body." }),
  overwrite: Type.Optional(Type.Boolean({ description: "Overwrite an existing user skill with the same name. Default: false." })),
});

function renderUserSkillMarkdown(params: {
  name: string;
  title: string;
  description: string;
  shortcuts?: string[];
  target?: "device" | "mac";
  sync_app?: string;
  body: string;
}): string {
  const fm: string[] = ["---"];
  fm.push(`title: ${JSON.stringify(params.title)}`);
  fm.push(`description: ${JSON.stringify(params.description)}`);
  if (params.shortcuts && params.shortcuts.length > 0) {
    fm.push(`shortcuts: [${params.shortcuts.map((s) => JSON.stringify(s)).join(", ")}]`);
  } else {
    fm.push(`shortcuts: []`);
  }
  if (params.target) fm.push(`target: ${params.target}`);
  if (params.sync_app) fm.push(`sync_app: ${JSON.stringify(params.sync_app)}`);
  fm.push("---");
  fm.push("");
  return fm.join("\n") + "\n" + params.body.trimEnd() + "\n";
}

function createCreateUserSkillTool(): AgentTool<typeof createUserSkillSchema> {
  return {
    name: "create_user_skill",
    label: "Create a user skill",
    description: "Create or overwrite a user-layer skill at data/user/skills/<name>.md. The tool builds the YAML frontmatter from your typed fields, so the loader always parses it correctly. NEVER edit skills/ (core) — use this. Hot-reloaded on next request.",
    parameters: createUserSkillSchema,
    async execute(_id, params) {
      const USER_SK_DIR = resolve(TOOLS_PROJECT_ROOT, "data/user/skills");
      if (!existsSync(USER_SK_DIR)) mkdirSync(USER_SK_DIR, { recursive: true });
      const target = join(USER_SK_DIR, `${params.name}.md`);
      if (existsSync(target) && !params.overwrite) {
        return {
          content: [{ type: "text", text: `User skill "${params.name}" already exists at ${target}. Pass overwrite: true to replace it.` }],
          details: { error: "exists", path: target },
        };
      }
      const md = renderUserSkillMarkdown({
        name: params.name,
        title: params.title,
        description: params.description,
        shortcuts: params.shortcuts as string[] | undefined,
        target: params.target as "device" | "mac" | undefined,
        sync_app: params.sync_app,
        body: params.body,
      });
      writeFileSync(target, md);
      return {
        content: [{ type: "text", text: `User skill "${params.name}" written to ${target}. It will load on the next request.` }],
        details: { name: params.name, path: target, bytes: md.length },
      };
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

// ── Reasoning level ─────────────────────────────────────────────────────

const setReasoningSchema = Type.Object({
  level: stringEnum(
    REASONING_VALUES,
    "Reasoning level: off, minimal, low, medium, high or xhigh",
  ),
});

function createSetReasoningTool(config: Config): AgentTool<typeof setReasoningSchema> {
  return {
    name: "set_reasoning",
    label: "Set LLM reasoning level",
    description: "Change the model's reasoning (thinking) level at runtime. Use when the user asks for deeper thinking on hard problems (high/xhigh) or faster, cheaper replies (off/low). Takes effect from the NEXT message onward and persists across restarts. Only has an effect on models that support reasoning; on other models the level is ignored.",
    parameters: setReasoningSchema,
    async execute(_id, params) {
      const previous = config.llmReasoning;
      const level = params.level as ReasoningSetting;
      config.llmReasoning = level;
      updateEnvFile({ LLM_REASONING: level });
      logger.info(`Reasoning level changed via set_reasoning: ${previous} → ${level}`);
      return {
        content: [{ type: "text", text: `Reasoning level set to "${level}" (was "${previous}"). It applies from the next message onward.` }],
        details: { previous, level },
      };
    },
  };
}

// ── Tool factory ────────────────────────────────────────────────────────

type ToolName = "shell" | "read" | "write" | "ls" | "create_project" | "list_projects" | "delete_project" | "create_once_job" | "create_cron_job" | "list_jobs" | "delete_job" | "web_search" | "web_fetch" | "start_server" | "stop_server" | "list_servers" | "search_memory" | "remember_fact" | "query_facts" | "load_skill" | "update_memory_status" | "complete_project" | "create_custom_tool" | "create_user_skill" | "set_reasoning";

// Tool names that are added separately (respond sub-tools, run_code_job,
// custom tools). Permissions may reference them; this set prevents false warnings.
export const RESPOND_TOOL_NAMES = new Set<string>([
  "respond", // legacy name for back-compat during migration
  "respond_text",
  "respond_image",
  "respond_buttons",
  "respond_shortcut",
  "respond_html",
  "respond_sequence",
]);

export function createTools(cwd: string, perms: Permissions, config?: Config): AgentTool<any>[] {
  // Note: config is a live reference — vectorMemoryEnabled may change after Ollama health check
  const factories: Record<ToolName, () => AgentTool<any>> = {
    shell: () => createShellTool(cwd, perms),
    read: () => createReadTool(cwd, perms),
    write: () => createWriteTool(cwd, perms),
    ls: () => createLsTool(cwd, perms),
    create_project: () => createCreateProjectTool(cwd),
    list_projects: () => createListProjectsTool(cwd),
    delete_project: () => createDeleteProjectTool(cwd, perms),
    create_once_job: () => createOnceJobTool(),
    create_cron_job: () => createCronJobTool(),
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
    update_memory_status: () => createUpdateStatusTool(),
    complete_project: () => createCompleteProjectTool(),
    create_custom_tool: () => createCreateCustomToolTool(),
    create_user_skill: () => createCreateUserSkillTool(),
    set_reasoning: () => createSetReasoningTool(config!),
  };

  const tools: AgentTool<any>[] = [];
  for (const name of perms.tools) {
    const factory = factories[name as ToolName];
    if (factory) {
      tools.push(factory());
    } else if (!RESPOND_TOOL_NAMES.has(name)) {
      logger.warn(`Unknown tool: ${name}`);
    }
  }




  // Append custom tools (hot-reloaded from custom-tools/*.md)
  const customTools = getCustomTools(cwd);
  tools.push(...customTools);

  return tools;
}
