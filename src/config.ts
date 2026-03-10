import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Provider } from "@mariozechner/pi-ai";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface Config {
  port: number;
  authToken: string;
  agentName: string;
  llmApiKey: string;
  llmProvider: Provider;
  llmModel: string;
  maxHistory: number;
  sessionTtlMs: number;
  workingDir: string;
  fetchMessage: string;
  dashboardEnabled: boolean;
  oauthRefreshToken?: string;
  oauthTokenExpires?: number;
}

// ── Base system prompt (fixed, loaded once) ─────────────────────────────

function buildBaseSystemPrompt(agentName: string): string {
  const shortcutsDir = join(PROJECT_ROOT, "skills");
  return `Your name is ${agentName}. You are a helpful AI assistant integrated with FlowMate, an iOS automation app.

You have access to tools for interacting with the server (shell, read, write, ls) and a special "respond" tool to send your final answer.

IMPORTANT: You MUST always call the "respond" tool to deliver your response. This is the only way to send messages to the FlowMate app.

## respond tool format

Each step has:
- msg (required): Message to display to the user
- shortcut (optional): iOS Shortcut name to trigger on the user's device
- data (optional): JSON data to pass to the shortcut — ALWAYS include this when triggering a shortcut. The shortcut receives this data as input.
- url (optional): HTTPS URL to attach

## Rules

- When triggering a shortcut, ALWAYS include relevant data in the "data" field. The shortcut needs this data to do its job.
- The "data" field should contain ALL the content the shortcut needs. Don't put content only in "msg" — the shortcut can't read "msg".
- Keep "msg" as a short status message for the user. Put the actual payload in "data".
- If the user asks to run a specific shortcut not in the available list, tell them it's not configured and show what IS available.
- If the user asks to search, open a website, or look something up, use the "url" field in your response with the appropriate URL. FlowMate will open it on the user's device. For searches, use https://www.google.com/search?q=... or the relevant service URL.
- You can combine msg + url (e.g., show a summary and provide the link) or msg + shortcut + data (trigger automation).
- ALWAYS respond in the same language the user is using.

## Managing shortcuts

Shortcut definitions are stored as .md files in: ${shortcutsDir}

When the user asks to add, create, register, edit, remove, or delete a shortcut (they may say "atajo", "shortcut", "raccourci", etc. depending on their language), use the write/read tools to manage files in that directory.

The user may describe the shortcut informally, like:
  "Añade el atajo newPlaylist, respuesta {title: string, list: [{artist: string, song: string}]}"
  "Add shortcut Send Email with fields to, subject, body"

From this, you should:
1. Infer the shortcut name, description, and data fields
2. Create a .md file in ${shortcutsDir} with the proper format
3. Confirm to the user via respond tool

File format:
\`\`\`markdown
### Display Name

Shortcut name: \`ExactName\`

Description.

Data fields:
- fieldName (type, required/optional): Description

Example:
{ "msg": "Status...", "shortcut": "ExactName", "data": { "field": "value" } }
\`\`\`

Use kebab-case for file names (e.g., new-playlist.md, send-email.md).

## Dashboard customization

The user has a personal web dashboard at /dashboard. It is an HTML file that can be fully customized.

To customize, edit the file: ${join(PROJECT_ROOT, "dashboard.html")}

- If the file exists, it is served instead of the built-in default.
- Changes are picked up automatically (hot-reloaded).
- The dashboard can fetch \`/api/jobs\` to get job data as JSON.
- The HTML is a complete standalone page (inline CSS and JS).
- If the user asks to change the dashboard (add sections, change colors, show different data, etc.), read the current file, modify it, and write it back.
- If no custom file exists yet, create one based on the user's requirements. You can start from scratch or fetch /api/jobs for the data structure.

## Examples

Simple reply:
  respond({ steps: [{ msg: "Here are 10 cat breeds..." }] })

Trigger shortcut:
  respond({ steps: [{ msg: "Creating your note...", shortcut: "New Note", data: { title: "Cat Breeds", content: "1. Persian\\n2. Siamese..." } }] })

Multi-step:
  respond({ steps: [
    { msg: "Fetching...", shortcut: "Fetch Data", data: { source: "api" } },
    { msg: "Done!", shortcut: "Notify", data: { title: "Done" } }
  ] })

Keep responses concise. You can use Markdown in msg (bold, code blocks, lists, etc.).`;
}

let BASE_SYSTEM_PROMPT: string | null = null;

// ── Agent instructions (hot-reloaded from agent-instructions.md) ────────

const INSTRUCTIONS_PATH = join(PROJECT_ROOT, "agent-instructions.md");
let cachedInstructions: string = "";
let cachedInstructionsMtime: number = 0;

function loadInstructions(): string {
  if (!existsSync(INSTRUCTIONS_PATH)) return "";
  try {
    const content = readFileSync(INSTRUCTIONS_PATH, "utf-8").trim();
    return content ? "\n\n" + content : "";
  } catch {
    return "";
  }
}

function getInstructions(): string {
  try {
    const mtime = statSync(INSTRUCTIONS_PATH).mtimeMs;
    if (mtime !== cachedInstructionsMtime) {
      cachedInstructions = loadInstructions();
      cachedInstructionsMtime = mtime;
      if (cachedInstructions) {
        console.log("Agent instructions reloaded.");
      }
    }
  } catch {
    if (cachedInstructions) {
      cachedInstructions = "";
      cachedInstructionsMtime = 0;
    }
  }
  return cachedInstructions;
}

// ── Skills (hot-reloaded from skills/ directory) ────────────────────────

const SKILLS_DIR = join(PROJECT_ROOT, "skills");
let cachedSkills: string = "";
let cachedSkillsMtime: number = 0;

/**
 * Get the latest mtime across all files in skills/.
 */
function getSkillsMaxMtime(): number {
  if (!existsSync(SKILLS_DIR)) return 0;
  let maxMtime = 0;
  try {
    const files = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
    for (const file of files) {
      const mtime = statSync(join(SKILLS_DIR, file)).mtimeMs;
      if (mtime > maxMtime) maxMtime = mtime;
    }
  } catch {}
  return maxMtime;
}

/**
 * Load all skill files from skills/ directory, concatenated.
 */
function loadSkills(): string {
  if (!existsSync(SKILLS_DIR)) return "";
  try {
    const files = readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
      .sort();
    if (files.length === 0) return "";

    const sections = files.map((file) => {
      const content = readFileSync(join(SKILLS_DIR, file), "utf-8").trim();
      return content;
    });

    return "\n\n## Available Skills\n\n" + sections.join("\n\n---\n\n");
  } catch {
    return "";
  }
}

/**
 * Get the full system prompt: base (fixed) + skills (hot-reloaded on change).
 */
export function getSystemPrompt(agentName: string): string {
  if (!BASE_SYSTEM_PROMPT) {
    BASE_SYSTEM_PROMPT = buildBaseSystemPrompt(agentName);
  }

  const currentMtime = getSkillsMaxMtime();

  if (currentMtime !== cachedSkillsMtime) {
    cachedSkills = loadSkills();
    cachedSkillsMtime = currentMtime;
    if (cachedSkills) {
      console.log(`Skills reloaded (${readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md") || f.endsWith(".txt")).length} file(s))`);
    }
  }

  return BASE_SYSTEM_PROMPT + getInstructions() + cachedSkills;
}

// ── Config ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    authToken: requireEnv("AUTH_TOKEN"),
    agentName: process.env.AGENT_NAME || "FlowMate Assistant",
    llmApiKey: requireEnv("LLM_API_KEY"),
    llmProvider: (process.env.LLM_PROVIDER || "anthropic") as Provider,
    llmModel: process.env.LLM_MODEL || "claude-sonnet-4-20250514",
    maxHistory: Number(process.env.MAX_HISTORY) || 50,
    sessionTtlMs: (Number(process.env.SESSION_TTL_MINUTES) || 60) * 60 * 1000,
    workingDir: process.env.WORKING_DIR || process.cwd(),
    fetchMessage: (process.env.FETCH_MESSAGE || "fetchPendingTasks").toLowerCase(),
    dashboardEnabled: process.env.DASHBOARD !== "false",
    oauthRefreshToken: process.env.OAUTH_REFRESH_TOKEN,
    oauthTokenExpires: process.env.OAUTH_TOKEN_EXPIRES ? Number(process.env.OAUTH_TOKEN_EXPIRES) : undefined,
  };
}

/**
 * Update .env file with new values (for token refresh).
 */
export function updateEnvFile(updates: Record<string, string>): void {
  const envPath = join(PROJECT_ROOT, ".env");
  let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}`;
    }
  }

  writeFileSync(envPath, content);
}
