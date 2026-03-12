/**
 * Custom tools loaded from markdown files in custom-tools/.
 *
 * Each .md file defines a tool with a shell command template.
 * Hot-reloaded on change (checked via mtime), same pattern as skills.
 * The agent can create, edit, and delete custom tools.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { logger } from "./logger.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CUSTOM_TOOLS_DIR = join(PROJECT_ROOT, "custom-tools");

const MAX_OUTPUT = 50_000;

// ── Parsed tool definition ──────────────────────────────────────────────

export interface CustomToolDef {
  displayName: string;
  toolName: string;
  description: string;
  install: string | null;
  command: string;
  parameters: { name: string; type: string; required: boolean; description: string; defaultValue: string | null }[];
  sourceFile: string;
}

// ── Parser ───────────────────────────────────────────────────────────────

function parseCustomTool(content: string, sourceFile: string): CustomToolDef | null {
  const lines = content.split("\n");

  // Display name: first ### heading
  const headingLine = lines.find((l) => l.startsWith("### ") && !l.includes("Template"));
  if (!headingLine) return null;
  const displayName = headingLine.replace(/^###\s+/, "").trim();

  // Tool name
  const nameMatch = content.match(/Tool name:\s*`([^`]+)`/);
  if (!nameMatch) return null;
  const toolName = nameMatch[1]!;

  // Validate tool name
  if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
    logger.warn(`Invalid custom tool name: "${toolName}" in ${sourceFile}`);
    return null;
  }

  // Description: text between tool name line and Install/Command/Parameters
  const nameLineIdx = lines.findIndex((l) => l.includes("Tool name:"));
  const nextSectionIdx = lines.findIndex(
    (l, i) => i > nameLineIdx && (l.startsWith("Install:") || l.startsWith("Command:") || l.startsWith("Parameters:")),
  );
  const description = lines
    .slice(nameLineIdx + 1, nextSectionIdx > 0 ? nextSectionIdx : undefined)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");

  // Install command (optional)
  const installMatch = content.match(/Install:\s*`([^`]+)`/);
  const install = installMatch ? installMatch[1]! : null;

  // Command template
  const commandMatch = content.match(/Command:\s*`([^`]+)`/);
  if (!commandMatch) return null;
  const command = commandMatch[1]!;

  // Parameters
  const parameters: CustomToolDef["parameters"] = [];
  const paramsIdx = lines.findIndex((l) => l.startsWith("Parameters:"));
  if (paramsIdx >= 0) {
    for (let i = paramsIdx + 1; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line.startsWith("- ")) break;

      // Format: - name (type, required/optional): Description. Default: value
      const paramMatch = line.match(
        /^-\s+(\w+)\s+\((\w+),\s*(required|optional)\):\s*(.+?)(?:\.\s*Default:\s*(.+))?$/,
      );
      if (paramMatch) {
        parameters.push({
          name: paramMatch[1]!,
          type: paramMatch[2]!,
          required: paramMatch[3] === "required",
          description: paramMatch[4]!.replace(/\.\s*$/, ""),
          defaultValue: paramMatch[5]?.trim() ?? null,
        });
      }
    }
  }

  return { displayName, toolName, description, install, command, parameters, sourceFile };
}

// ── Hot-reload cache ─────────────────────────────────────────────────────

let cachedDefs: CustomToolDef[] = [];
let cachedMtime: number = 0;

function getMaxMtime(): number {
  if (!existsSync(CUSTOM_TOOLS_DIR)) return 0;
  let maxMtime = 0;
  try {
    const files = readdirSync(CUSTOM_TOOLS_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
    for (const file of files) {
      const mtime = statSync(join(CUSTOM_TOOLS_DIR, file)).mtimeMs;
      if (mtime > maxMtime) maxMtime = mtime;
    }
  } catch {}
  return maxMtime;
}

export function loadCustomToolDefs(): CustomToolDef[] {
  const currentMtime = getMaxMtime();
  if (currentMtime === cachedMtime && cachedDefs.length > 0) {
    return cachedDefs;
  }

  if (!existsSync(CUSTOM_TOOLS_DIR)) return [];

  const files = readdirSync(CUSTOM_TOOLS_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .sort();

  const defs: CustomToolDef[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(CUSTOM_TOOLS_DIR, file), "utf-8");
      const def = parseCustomTool(content, file);
      if (def) {
        defs.push(def);
      } else {
        logger.warn(`Could not parse custom tool: ${file}`);
      }
    } catch (err) {
      logger.warn(`Error reading custom tool ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (currentMtime !== cachedMtime && defs.length > 0) {
    logger.info(`Custom tools reloaded (${defs.length} tool(s))`);
  }

  cachedDefs = defs;
  cachedMtime = currentMtime;
  return defs;
}

// ── Install dependencies ─────────────────────────────────────────────────

const installedTools = new Set<string>();

async function ensureInstalled(def: CustomToolDef, cwd: string): Promise<string | null> {
  if (!def.install || installedTools.has(def.toolName)) return null;

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", def.install!], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });

    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

    child.on("close", (code) => {
      if (code === 0) {
        installedTools.add(def.toolName);
        logger.info(`Custom tool "${def.toolName}" dependencies installed`);
        resolve(null);
      } else {
        resolve(`Install failed (exit ${code}): ${output.slice(0, 500)}`);
      }
    });

    child.on("error", (err) => {
      resolve(`Install error: ${err.message}`);
    });
  });
}

// ── Generate AgentTool from definition ───────────────────────────────────

function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n... [truncated, ${text.length} total chars]`;
}

export function createCustomAgentTool(def: CustomToolDef, cwd: string): AgentTool<any> {
  // Build typebox schema from parameters
  const schemaProps: Record<string, any> = {};
  for (const param of def.parameters) {
    const typeMap: Record<string, any> = {
      string: Type.String({ description: param.description }),
      number: Type.Number({ description: param.description }),
      boolean: Type.Boolean({ description: param.description }),
    };
    const schema = typeMap[param.type] ?? Type.String({ description: param.description });
    schemaProps[param.name] = param.required ? schema : Type.Optional(schema);
  }

  const paramsSchema = Type.Object(schemaProps);

  return {
    name: def.toolName,
    label: def.displayName,
    description: def.description,
    parameters: paramsSchema,
    async execute(_id, params) {
      // Ensure dependencies are installed
      const installError = await ensureInstalled(def, cwd);
      if (installError) {
        return {
          content: [{ type: "text", text: installError }],
          details: { error: "install_failed" },
        };
      }

      // Substitute parameters into command template
      let command = def.command;
      for (const param of def.parameters) {
        const value = (params as any)[param.name] ?? param.defaultValue ?? "";
        // Shell-escape the value
        const escaped = String(value).replace(/'/g, "'\\''");
        command = command.replace(new RegExp(`\\$${param.name}\\b`, "g"), `'${escaped}'`);
      }

      // Execute
      return new Promise<AgentToolResult<unknown>>((resolve) => {
        let output = "";
        const child = spawn("bash", ["-c", command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        });

        child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
        child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });

        child.on("close", (code) => {
          const prefix = code === 0 ? "" : `[exit code: ${code}]\n`;
          resolve({
            content: [{ type: "text", text: truncate(prefix + output) }],
            details: { exitCode: code, tool: def.toolName },
          });
        });

        child.on("error", (err) => {
          resolve({
            content: [{ type: "text", text: `Error: ${err.message}` }],
            details: { error: err.message, tool: def.toolName },
          });
        });
      });
    },
  };
}

// ── Public: get all custom tools as AgentTools ───────────────────────────

export function getCustomTools(cwd: string): AgentTool<any>[] {
  const defs = loadCustomToolDefs();
  return defs.map((def) => createCustomAgentTool(def, cwd));
}

// ── Public: get custom tools info for system prompt ──────────────────────

export function getCustomToolsPrompt(): string {
  const defs = loadCustomToolDefs();
  if (defs.length === 0) return "";

  const lines = defs.map((def) => {
    const params = def.parameters.map((p) => `${p.name} (${p.type}, ${p.required ? "required" : "optional"}): ${p.description}`).join("\n  - ");
    return `- **${def.displayName}** (\`${def.toolName}\`): ${def.description}${params ? "\n  - " + params : ""}`;
  });

  return "\n\n## Custom Tools\n\nThese tools were added by the user or by you. They are available for use:\n\n" + lines.join("\n");
}

export { CUSTOM_TOOLS_DIR };
