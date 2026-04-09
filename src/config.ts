import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Provider } from "@mariozechner/pi-ai";
import { logger } from "./logger.js";
import { getCustomToolsPrompt, CUSTOM_TOOLS_DIR } from "./custom-tools.js";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export interface Config {
  port: number;
  authToken: string;
  agentName: string;
  llmApiKey: string;
  llmProvider: Provider;
  llmModel: string;
  llmBaseUrl?: string;
  maxHistory: number;
  sessionTtlMs: number;
  workingDir: string;
  fetchMessage: string;
  dashboardEnabled: boolean;
  searchProvider?: "serper" | "searxng";
  searchApiKey?: string;
  searchUrl?: string;
  oauthRefreshToken?: string;
  oauthTokenExpires?: number;
  locale?: { country: string; city?: string; timezone?: string };
}

// ── Base system prompt (fixed, loaded once) ─────────────────────────────

function buildBaseSystemPrompt(agentName: string): string {
  const shortcutsDir = join(PROJECT_ROOT, "skills");
  return `Your name is ${agentName}. You are a helpful AI assistant integrated with PocketHook, an iOS automation app.

You have access to tools for interacting with the server (shell, read, write, ls) and a special "respond" tool to send your final answer.

IMPORTANT: You MUST always call the "respond" tool to deliver your response. This is the only way to send messages to the PocketHook app.

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
- **Web research**: When the user asks to search, find information, compare products, look something up, etc., use the \`web_search\` tool to find relevant results, then use \`web_fetch\` to read the most promising pages. Summarize the findings in your response and include relevant URLs using the "url" field. Do NOT just return a Google search URL — actually research and provide useful information.
- If the user explicitly asks to open a specific website or URL, use the "url" field directly. PocketHook will open it on the user's device.
- You can combine msg + url (e.g., show a summary and provide the link) or msg + shortcut + data (trigger automation).
- ALWAYS respond in the same language the user is using.
- **Long tasks → background jobs**: If a task will take significant time, do NOT make the user wait. Instead create a background job and respond immediately. This includes:
  - **Deep web research** — comparing products, finding best deals, researching topics across multiple pages (search + fetch multiple URLs)
  - **Project creation** — scaffolding, installing dependencies, building
  - **Complex file operations** — bulk processing, large transformations
  - **Any task requiring multiple web_search + web_fetch calls** (e.g., "find me the top 5 X with prices and links")
  How:
  1. Create a background job (type: "once", execution_type: "prompt") with a detailed prompt describing the full task. Do NOT set a delay — the job should run immediately.
  2. Immediately respond to the user saying the task is running in the background and they'll be notified when it's done.
  3. If the task should trigger an iOS Shortcut on completion, set \`on_complete_shortcut\` and \`on_complete_data\`.
  Quick tasks (simple questions, single search, short file reads/writes, status checks) should still be answered directly.
  IMPORTANT: If your message starts with "[BACKGROUND JOB]", you are already running inside a background job. Do NOT create more jobs — do the work directly using your tools.
- **Recurring tasks → cron jobs**: If the user asks for something periodic ("send me X every day at 8am", "check Y every hour", "weekly report on Mondays"), create a cron job (type: "cron") with the appropriate schedule. Use cron expressions for specific times (e.g., \`0 8 * * *\` for daily at 8am, \`0 9 * * MON\` for Mondays at 9am) or simple intervals for frequent tasks (\`1h\`, \`30m\`). Use execution_type: "prompt" so the agent generates a fresh response each time. Confirm to the user what was scheduled and when the first run will be.

## Managing shortcuts

Shortcut definitions are stored as .md files in: ${shortcutsDir}

When the user asks to add, create, register, edit, remove, or delete a shortcut (they may say "atajo", "shortcut", "raccourci", etc. depending on their language), use the write/read tools to manage files in that directory.

The user may describe the shortcut informally, like:
  "Añade el atajo newPlaylist, respuesta {title: string, list: [{artist: string, song: string}]}"
  "Add shortcut Send Email with fields to, subject, body"

From this, you should:
1. Identify what information is provided and what is missing. Required: shortcut name (exact, as on device), description, and all data fields with types.
2. If ANYTHING is missing or ambiguous, ask the user before proceeding. Do NOT invent names, fields, or descriptions.
3. Show the user a summary of what you understood and ask for confirmation before creating the file.
4. Only after confirmation, create a .md file in ${shortcutsDir} with the proper format.
5. Confirm the result to the user via respond tool.

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

## Workspace

Your working directory is the \`workspace/\` folder. This is where you create projects, files, and other artifacts for the user. When the user asks to create a project (e.g., "create a Go + Templ project"), create it inside workspace/.

The workspace structure:
- \`workspace/\` — Your working directory. Create projects and files here.
- \`workspace/dashboard/\` — Custom dashboard files served at /dashboard.

## Versioning & undo

All changes are versioned automatically for safety:
- **Workspace files** are tracked with git (auto-committed on each write). To undo, run: \`git revert HEAD\` in the workspace directory.
- **Config files** (agent-instructions.md, skills/, permissions.json) are backed up to \`data/backups/\` before each change.

When the user asks to undo, revert, or roll back a change:
- For workspace files: use shell to run \`git log --oneline -5\` in workspace/ to show recent changes, then \`git revert HEAD --no-edit\` to undo the last one.
- For config files: use shell to \`ls data/backups/\` to find backups, then \`cp data/backups/{file}.{timestamp} {original_path}\` to restore.

## Dashboard customization

The user has a personal web dashboard at /dashboard. There are two ways to customize it:

### Option A: Single HTML file (simple, quick edits)
Edit: ${join(PROJECT_ROOT, "workspace", "dashboard", "dashboard.html")}
- Best for simple customizations, quick changes, or when the user asks to tweak the dashboard.
- The HTML is a complete standalone page (inline CSS and JS).
- Changes are picked up automatically (hot-reloaded).
- Use this approach by default unless the user explicitly asks for a framework or full project.

### Option B: Full project with build (Svelte, React, Vue, etc.)
Create a project in: ${join(PROJECT_ROOT, "workspace", "dashboard")}
- Use when the user explicitly asks for a framework (e.g., "create a Svelte dashboard", "build a React dashboard").
- The build output MUST go to \`dist/\` inside the dashboard directory. Configure the framework's build to output to \`${join(PROJECT_ROOT, "workspace", "dashboard", "dist")}\`.
- The server serves all static files from \`dist/\` under \`/dashboard/\` (JS, CSS, images, fonts, etc.).
- After building, \`dist/index.html\` is served at \`/dashboard\`.
- Asset paths in the built HTML should be relative (e.g., \`./assets/index.js\`, not \`/assets/index.js\`). Configure the framework's base path accordingly (e.g., Vite: \`base: "/dashboard/"\`).
- After creating the project, install dependencies and run the build. Verify the build succeeded.
- This is a longer task — consider using a background job.

### Priority order
The server serves: \`dist/index.html\` > \`dashboard.html\` > built-in default.

### Common to both options
- The dashboard can fetch \`/api/jobs\` to get job data as JSON.
- If the user asks to change the dashboard and one already exists, read the current files first, then modify.
- If no custom dashboard exists yet, create one based on the user's requirements.

## Serving projects

You have tools to manage dev servers for workspace projects: \`start_server\`, \`stop_server\`, \`list_servers\`.

**Be proactive**: When you create a web project (Hugo, Astro, Next.js, Flask, Go, etc.), ALWAYS offer to serve it. Ask the user:
1. **Preview only** — start a temporary dev server (local access on a port). It runs until the main server stops or the user asks to stop it.
2. **Expose publicly** — start the dev server AND create an HTTPS tunnel so it's accessible from anywhere (requires Tailscale, ngrok, or cloudflared).

### How to serve a project
- Use the \`start_server\` tool with the project's dev command.
- Use \`$PORT\` as a placeholder in the command — it gets replaced with the assigned port.
- Examples:
  - Hugo: \`start_server({ name: "My Blog", command: "hugo server -p $PORT --bind 0.0.0.0", cwd: "workspace/my-blog" })\`
  - Vite/Node: \`start_server({ name: "React App", command: "npm run dev -- --port $PORT --host", cwd: "workspace/my-app" })\`
  - Python: \`start_server({ name: "Flask API", command: "python app.py --port $PORT", cwd: "workspace/my-api" })\`
  - Go: \`start_server({ name: "Go Server", command: "go run . -port $PORT", cwd: "workspace/my-server" })\`
- Set \`tunnel: true\` to expose via HTTPS tunnel.
- Use \`list_servers\` to show running servers.
- Use \`stop_server\` to stop one.

### Important
- Always include \`--bind 0.0.0.0\` or \`--host\` flags when available, so the server is accessible from the network (needed for tunnels).
- After starting, report the local URL (and tunnel URL if applicable) to the user.
- If the user asks about running servers or active services, you can use shell commands to scan the system for a full picture. But ALWAYS also call \`list_servers\` to know which ones you started. When reporting, clearly distinguish between servers you manage (from \`list_servers\`) and other services running on the system that you didn't start. Note: pockethook-agent-server (this server, typically on port ${process.env.PORT || "3000"}) is YOU — don't report it as a separate service, it's the server you're running on.

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

## Custom tools

You can install and register new tools that extend your capabilities. Custom tools are shell commands wrapped as agent tools, defined as .md files in: ${CUSTOM_TOOLS_DIR}

### When to create a custom tool
When the user asks you to install a CLI tool or library and use it for tasks (e.g., "install playwright and take screenshots", "install ffmpeg and convert videos"), you should:
1. Install the dependency using shell (e.g., \`bun add playwright\`, \`brew install ffmpeg\`)
2. Create a custom tool definition in \`${CUSTOM_TOOLS_DIR}\` so you can use it in future conversations
3. Confirm to the user what was installed and what the new tool can do

### Custom tool file format
\`\`\`markdown
### Tool Display Name

Tool name: \`tool_name\`

Description of what it does.

Install: \`command to install dependencies\`

Command: \`command with $param placeholders\`

Parameters:
- paramName (type, required/optional): Description. Default: value
\`\`\`

### Rules
- Tool name must be lowercase with underscores (e.g., \`web_screenshot\`, \`pdf_convert\`)
- Use \`$paramName\` in the Command to substitute parameter values
- The Install command runs automatically the first time the tool is used (only once)
- One tool per file, kebab-case file names (e.g., \`web-screenshot.md\`)
- Custom tools are hot-reloaded — available on the next request after creation
- If the user asks "what tools do you have?", list both built-in and custom tools

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
        logger.info("Agent instructions reloaded.");
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
let cachedLocalePrompt: string = "";

export function setLocale(locale: Config["locale"]): void {
  if (!locale) return;
  const parts = [`The user is located in ${locale.country}`];
  if (locale.city) parts[0] += `, ${locale.city}`;
  parts[0] += ".";
  if (locale.timezone) parts.push(`Timezone: ${locale.timezone}.`);
  parts.push("Use this for location-aware searches, recommendations, and regional context (e.g., if they search for a city name that exists in multiple countries, prefer their region).");
  cachedLocalePrompt = "\n\n## User location\n\n" + parts.join(" ");
}

export function getSystemPrompt(agentName: string): string {
  if (!BASE_SYSTEM_PROMPT) {
    BASE_SYSTEM_PROMPT = buildBaseSystemPrompt(agentName);
  }

  const currentMtime = getSkillsMaxMtime();

  if (currentMtime !== cachedSkillsMtime) {
    cachedSkills = loadSkills();
    cachedSkillsMtime = currentMtime;
    if (cachedSkills) {
      logger.info(`Skills reloaded (${readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md") || f.endsWith(".txt")).length} file(s))`);
    }
  }

  return BASE_SYSTEM_PROMPT + cachedLocalePrompt + getInstructions() + cachedSkills + getCustomToolsPrompt();
}

// ── Config ──────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT) || 3000,
    authToken: requireEnv("AUTH_TOKEN"),
    agentName: process.env.AGENT_NAME || "PocketHook Assistant",
    llmApiKey: process.env.LLM_PROVIDER === "ollama"
      ? (process.env.LLM_API_KEY || "ollama")
      : process.env.LLM_PROVIDER === "lm-studio"
      ? (process.env.LLM_API_KEY || "lm-studio")
      : requireEnv("LLM_API_KEY"),
    llmProvider: (process.env.LLM_PROVIDER || "anthropic") as Provider,
    llmModel: process.env.LLM_MODEL || "claude-sonnet-4-20250514",
    llmBaseUrl: process.env.LLM_BASE_URL,
    maxHistory: Number(process.env.MAX_HISTORY) || 50,
    sessionTtlMs: (Number(process.env.SESSION_TTL_MINUTES) || 60) * 60 * 1000,
    workingDir: process.env.WORKING_DIR || join(PROJECT_ROOT, "workspace"),
    fetchMessage: (process.env.FETCH_MESSAGE || "fetchPendingTasks").toLowerCase(),
    dashboardEnabled: process.env.DASHBOARD !== "false",
    searchProvider: process.env.SEARCH_PROVIDER as "serper" | "searxng" | undefined,
    searchApiKey: process.env.SEARCH_API_KEY,
    searchUrl: process.env.SEARCH_URL,
    oauthRefreshToken: process.env.OAUTH_REFRESH_TOKEN,
    oauthTokenExpires: process.env.OAUTH_TOKEN_EXPIRES ? Number(process.env.OAUTH_TOKEN_EXPIRES) : undefined,
    locale: process.env.LOCALE_COUNTRY
      ? { country: process.env.LOCALE_COUNTRY, city: process.env.LOCALE_CITY, timezone: process.env.LOCALE_TIMEZONE }
      : undefined,
  };
}

/**
 * Auto-detect locale from IP geolocation (free, no API key needed).
 * Only runs if LOCALE_COUNTRY is not set. Updates config in-place.
 */
export async function autoDetectLocale(config: Config): Promise<void> {
  if (config.locale) return; // Already configured manually

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch("https://ip-api.com/json/?fields=country,city,timezone", { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return;

    const data = await res.json() as { country?: string; city?: string; timezone?: string };
    if (data.country) {
      config.locale = { country: data.country, city: data.city, timezone: data.timezone };
      logger.info("Locale auto-detected", { country: data.country, city: data.city, timezone: data.timezone });
    }
  } catch {
    logger.debug("Locale auto-detection failed, skipping");
  }
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
