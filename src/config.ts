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
  userName?: string;
  onboardingChat: boolean;
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
  embeddingProvider: "ollama" | "lm-studio" | "openai";
  embeddingModel: string;
  embeddingUrl: string;
  embeddingApiKey?: string;
  vectorMemoryEnabled: boolean;
}

// ── Base system prompt (fixed, loaded once) ─────────────────────────────

function buildBaseSystemPrompt(agentName: string, vectorMemoryEnabled: boolean, userName?: string, onboardingChat: boolean = false): string {
  const baseSkillsDir = join(PROJECT_ROOT, "skills");
  const userSkillsDir = join(PROJECT_ROOT, "data", "user", "skills");
  const baseCustomToolsDir = join(PROJECT_ROOT, "custom-tools");
  const userCustomToolsDir = join(PROJECT_ROOT, "data", "user", "custom-tools");
  const userInstructionsPath = join(PROJECT_ROOT, "data", "user", "instructions.md");
  const userPrefsPath = join(PROJECT_ROOT, "data", "user", "prefs.json");
  const userNameLine = userName
    ? `\n\nThe user's name is ${userName}. Use it occasionally and naturally in conversation — for greetings or when it feels right. Do not use it in every response.`
    : "";
  const onboardingBlock = userName && onboardingChat ? `

## Getting to know the user

On your FIRST conversation with ${userName}, offer to ask a few personal questions so you can provide more personalized help. Keep it brief and natural — something like "Hey ${userName}, I'd love to get to know you a bit so I can help you better. Mind if I ask you a few quick questions?"

If they agree, ask about these topics — one or two at a time, conversationally, not as a checklist:
- What they do for work or study
- Where they live
- Family — partner, kids, pets
- Main interests or hobbies
- Anything else they'd like you to keep in mind

Store every piece of information using \`remember_fact\` as you go (e.g., \`("user", "works_as", "designer")\`, \`("user", "lives_in", "Madrid")\`, \`("user", "hobby", "running")\`). When done, confirm briefly that you've noted everything and transition naturally to regular chat.

If the user declines, respect it immediately with something short like "No problem!" and move on. Store \`remember_fact({subject: "user", predicate: "declined_intro_questions", object: "true"})\` so you never ask again.

IMPORTANT: Only offer this ONCE. Before offering, check \`query_facts("user")\` — if you already have personal facts about the user (work, location, family, hobbies) OR if they previously declined, do NOT offer again.` : "";
  return `Your name is ${agentName}. You are a helpful AI assistant integrated with PocketHook, an iOS automation app.${userNameLine}

You have access to tools for interacting with the server and a special "respond" tool to send your final answer.

IMPORTANT: You MUST always call the "respond" tool to deliver your response. This is the only way to send messages to the PocketHook app.

## respond tool format

Each step has:
- msg (required): Message to display to the user
- shortcut (optional): iOS Shortcut name to trigger on the user's device
- data (optional): JSON data to pass to the shortcut — ALWAYS include this when triggering a shortcut. The shortcut receives this data as input.
- url (optional): HTTPS URL to attach. Used as the primary clickable link on the device.
- run_on (optional): Where to execute the shortcut: "server" (on the Mac server) or "device" (on the iOS device, default). Use "server" ONLY for shortcuts from skills with [target: mac] in the skills index.

The \`msg\` field renders plain text, markdown, inline HTML (wrapped in a \`<div>\`), inline images, and interactive buttons. When the user has a choice between options, always offer buttons — never make them type a selection manually. For full rendering details (HTML rules, image URL constraints, button action types and syntax), call \`load_doc("content-rendering")\`.

### Simple examples

\`respond({ steps: [{ msg: "Here are 10 cat breeds..." }] })\`

\`respond({ steps: [{ msg: "Creating your note...", shortcut: "New Note", data: { title: "Cat Breeds", content: "..." } }] })\`

### Data and URL rules

- When triggering a shortcut, ALWAYS put the real payload in \`data\`. The shortcut can't read \`msg\`.
- Keep \`msg\` short (status for the user). Put content in \`data\`.
- If the user explicitly asks to open a website, put the URL in the \`url\` field — PocketHook opens it on the device.
- When you include a link to a server you started, use its tunnel URL. Localhost URLs never reach the user's phone; the server rewrites obvious leaks and logs a warning, but rely on \`start_server({ tunnel: true })\` up front.
- If the user asks to run a specific shortcut that isn't in the available-skills list, tell them it's not configured and show what IS available.

## Memory

You have long-term memory across conversations. Relevant past messages are automatically recalled and injected at the beginning of the context, marked "[Recalled from past conversations]". Use \`search_memory\` to actively search conversation history when needed. If recalled context is not enough, ask the user.${vectorMemoryEnabled ? `

### Knowledge graph and PARA

- \`remember_fact\` — store durable facts as triples (subject, predicate, object). Use for personal info, preferences, relationships, dates, routines, activities, confirmed events. Do NOT store requests, acknowledgments, one-off content, or your own tool outputs.
- \`query_facts\` — retrieve stored facts about an entity. Use \`include_expired: true\` to see history.
- \`search_memory\` — find past conversation fragments. Filter by \`wing\`, \`room\`, or \`status\` (e.g., \`status: "project"\` to list active projects).
- \`update_memory_status\` — change PARA status on a specific entity (\`project\`, \`area\`, \`resource\`, \`archive\`). \`area\` is the default for new memories.
- \`complete_project\` — when the user cancels or completes a plan. Pass \`project_description\` + \`project_slug\` + \`reason\` ("cancelled" or "completed") in a single call. The handler archives related vectors AND invalidates every matching triple AND records the completion triple — you do NOT follow up with \`remember_fact\`.

**Rules of thumb:**
- Store facts BEFORE executing tasks. If the user says "my mother lives in London, create me a note...", FIRST \`remember_fact({subject: "Sarah", predicate: "lives_in", object: "London"})\`, THEN create the note.
- Use unique slugged predicates per project (\`scheduled_visit_barcelona\`, not \`scheduled_visit\`) so concurrent projects don't overwrite each other.
- Multi-value predicates (child, friend, hobby, language, skill, pet) — call \`remember_fact\` once per value.

For what/what-not-to-store, format conventions, and advanced patterns, call \`load_doc("memory-guide")\`.` : ""}

## Skills

The "Available Skills" section below lists all skills you have access to (name + short description only). Call \`load_skill\` to fetch the full content of a skill when you need to use it. Skills are cheap to load — prefer loading over guessing. Load the skill BEFORE triggering its shortcuts or following its behavior rules.

## User customization layout

The runtime separates **framework files** (shipped with the repo, read-only for you) from **user files** (per-deployment, written by you on behalf of the user):

- READ-ONLY base (never create, edit, or delete):
  - \`${baseSkillsDir}\` — framework-shipped skills
  - \`${baseCustomToolsDir}\` — framework-shipped custom tool templates
  - \`${join(PROJECT_ROOT, "agent-instructions.md")}\` — base agent instructions
- WRITABLE user layer (this is where all user customization lives):
  - \`${userSkillsDir}\` — user-authored skills (overrides base on filename collision)
  - \`${userCustomToolsDir}\` — user-installed custom tools
  - \`${userInstructionsPath}\` — user additions to agent instructions. Put global behavior rules here ("always reply in English", "never use tables").
  - \`${userPrefsPath}\` — typed user values (route origin, tunnel domain, preferred app). Skills reference these as \`{{prefs.key}}\` and the server substitutes at load time.

**Write rule**: any time the user asks to add, edit, or remove a skill, rule, preference, or custom tool, the write goes to the user layer — never to the base. If the user wants to modify a skill that only exists in the base, copy it to \`${userSkillsDir}\` first and edit the copy; the user-layer file wins on reload.

For skill file format (frontmatter, body, authoring flow) call \`load_doc("skills-format")\`. For custom tool file format call \`load_doc("custom-tools-format")\`.

## Workspace

Your working directory is \`workspace/\`. Create subfolders for each project (\`workspace/my-blog/\`, \`workspace/notes/\`) — never loose files in the root.

\`workspace/dashboard/\` is the user's personal \`/dashboard\` web page. For customization details, call \`load_doc("dashboard")\`.

## Running things

- **Programming tasks** (create project, review code, build, test, debug, refactor) → always \`run_code_job\`. One call creates the background job and sends the ack to the user. Do NOT use \`shell\`/\`read\`/\`write\` inline for heavy code work; PocketHook's HTTP request has a short timeout.
- **Serving a dev project for the user to view** → \`start_server\` with \`tunnel: true\`. For framework-specific commands and binding rules, call \`load_doc("serving-projects")\`.
- **Deep research, multi-page scraping, long reports** → \`create_job\` with \`execution_type: "prompt"\`. Respond immediately; the user is notified when the job finishes.
- **Recurring tasks** ("every day at 8am", "weekly on Mondays") → \`create_job\` with \`type: "cron"\` and the appropriate schedule.
- **Quick operations** (simple questions, single search, reading one file the user asked about, listing jobs/servers, starting/stopping servers) → answer inline.
- If your message starts with \`[BACKGROUND JOB]\`, you are already running inside one — do the work directly, do not create more jobs.

## Web research

When the user asks to search, compare, look something up: use \`web_search\` for relevant results, then \`web_fetch\` to read the most promising pages, and summarize. Include relevant URLs in the \`url\` field. Do NOT return raw Google search URLs.

## Versioning & undo

Changes are versioned automatically. Workspace files are tracked with git (auto-commit on each write). Config files (\`agent-instructions.md\`, \`skills/\`, \`permissions.json\`) are backed up to \`data/backups/\` before each change. To undo: \`git log --oneline -5\` + \`git revert HEAD --no-edit\` in workspace for workspace changes; \`ls data/backups/\` + \`cp\` to restore for config files.

## General rules

- ALWAYS respond in the same language the user is using.
- Be concise. Show results, not process. Never use ASCII tables — use bullet lists or key: value lines.
- \`pockethook-agent-server\` (typically port ${process.env.PORT || "3000"}) is YOU — don't report it as a separate service when listing running processes.${onboardingBlock}`;
}

let BASE_SYSTEM_PROMPT: string | null = null;
let cachedVectorMemoryFlag: boolean = false;
let cachedUserName: string | undefined;

// ── Personality (hot-reloaded from personality.md) ──────────────────────

const PERSONALITY_PATH = join(PROJECT_ROOT, "personality.md");
let cachedPersonality: string = "";
let cachedPersonalityMtime: number = 0;

function loadPersonality(): string {
  if (!existsSync(PERSONALITY_PATH)) return "";
  try {
    const content = readFileSync(PERSONALITY_PATH, "utf-8").trim();
    return content ? "\n\n## Personality\n\n" + content : "";
  } catch {
    return "";
  }
}

function getPersonality(): string {
  try {
    const mtime = statSync(PERSONALITY_PATH).mtimeMs;
    if (mtime !== cachedPersonalityMtime) {
      cachedPersonality = loadPersonality();
      cachedPersonalityMtime = mtime;
      if (cachedPersonality) {
        logger.info("Personality reloaded.");
      }
    }
  } catch {
    if (cachedPersonality) {
      cachedPersonality = "";
      cachedPersonalityMtime = 0;
    }
  }
  return cachedPersonality;
}

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

// ── User instructions (hot-reloaded from data/user/instructions.md) ─────

let cachedUserInstructions: string = "";
let cachedUserInstructionsMtime: number = 0;

function loadUserInstructions(): string {
  if (!existsSync(USER_INSTRUCTIONS_PATH)) return "";
  try {
    const content = readFileSync(USER_INSTRUCTIONS_PATH, "utf-8").trim();
    return content ? "\n\n## User instructions\n\n" + content : "";
  } catch {
    return "";
  }
}

function getUserInstructions(): string {
  try {
    const mtime = statSync(USER_INSTRUCTIONS_PATH).mtimeMs;
    if (mtime !== cachedUserInstructionsMtime) {
      cachedUserInstructions = loadUserInstructions();
      cachedUserInstructionsMtime = mtime;
      if (cachedUserInstructions) {
        logger.info("User instructions reloaded.");
      }
    }
  } catch {
    if (cachedUserInstructions) {
      cachedUserInstructions = "";
      cachedUserInstructionsMtime = 0;
    }
  }
  return cachedUserInstructions;
}

// ── User prefs (hot-reloaded from data/user/prefs.json) ─────────────────

let cachedUserPrefs: Record<string, unknown> = {};
let cachedUserPrefsMtime: number = 0;

function loadUserPrefs(): Record<string, unknown> {
  if (!existsSync(USER_PREFS_PATH)) return {};
  try {
    const content = readFileSync(USER_PREFS_PATH, "utf-8").trim();
    if (!content) return {};
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err: any) {
    logger.warn(`Failed to parse ${USER_PREFS_PATH}: ${err.message}`);
    return {};
  }
}

export function getUserPrefs(): Record<string, unknown> {
  try {
    const mtime = statSync(USER_PREFS_PATH).mtimeMs;
    if (mtime !== cachedUserPrefsMtime) {
      cachedUserPrefs = loadUserPrefs();
      cachedUserPrefsMtime = mtime;
      logger.info("User prefs reloaded.");
    }
  } catch {
    if (Object.keys(cachedUserPrefs).length > 0) {
      cachedUserPrefs = {};
      cachedUserPrefsMtime = 0;
    }
  }
  return cachedUserPrefs;
}

/**
 * Substitute `{{prefs.key}}` and `{{prefs.nested.key}}` placeholders in
 * text with values from data/user/prefs.json. Unknown keys are left
 * untouched so authors can spot typos visually.
 */
export function interpolatePrefs(text: string): string {
  if (!text.includes("{{prefs.")) return text;
  const prefs = getUserPrefs();
  return text.replace(/\{\{prefs\.([\w.]+)\}\}/g, (match, path: string) => {
    const parts = path.split(".");
    let cursor: any = prefs;
    for (const part of parts) {
      if (cursor && typeof cursor === "object" && part in cursor) {
        cursor = cursor[part];
      } else {
        return match;
      }
    }
    if (cursor === null || cursor === undefined) return match;
    return typeof cursor === "string" ? cursor : JSON.stringify(cursor);
  });
}

// ── User customization paths ────────────────────────────────────────────
//
// Base directories (shipped with the repo, treated as read-only by the agent):
//   skills/ , custom-tools/ , agent-instructions.md
//
// User-local directories (under data/, git-ignored, written by the agent):
//   data/user/skills/           — user-authored skills override base on name collision
//   data/user/custom-tools/     — user-installed custom tools
//   data/user/instructions.md   — user additions to agent-instructions.md
//   data/user/prefs.json        — typed user values referenced as {{prefs.key}} in skills

export const USER_DIR = join(PROJECT_ROOT, "data", "user");
export const USER_SKILLS_DIR = join(USER_DIR, "skills");
export const USER_CUSTOM_TOOLS_DIR = join(USER_DIR, "custom-tools");
export const USER_INSTRUCTIONS_PATH = join(USER_DIR, "instructions.md");
export const USER_PREFS_PATH = join(USER_DIR, "prefs.json");

// ── Skills (hot-reloaded from skills/ directory) ────────────────────────

export const SKILLS_DIR = join(PROJECT_ROOT, "skills");
let cachedSkillsIndex: string = "";
let cachedSkillsMtime: number = 0;
let cachedSkillsMap: Map<string, { file: string; dir: string; source: "base" | "user"; title: string; description: string; target?: "mac" | "device"; syncApp?: string }> = new Map();
let cachedShortcutToSkill: Map<string, string> = new Map();

export interface SkillMeta {
  name: string;
  file: string;
  title: string;
  description: string;
}

/**
 * Get the latest mtime across all skill files, scanning both the base
 * `skills/` directory and the user overlay at `data/user/skills/`.
 */
function getSkillsMaxMtime(): number {
  let maxMtime = 0;
  for (const dir of [SKILLS_DIR, USER_SKILLS_DIR]) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
      for (const file of files) {
        const mtime = statSync(join(dir, file)).mtimeMs;
        if (mtime > maxMtime) maxMtime = mtime;
      }
    } catch {}
  }
  return maxMtime;
}

/**
 * Parse a skill file's metadata.
 * Supports two formats:
 * 1. YAML frontmatter (recommended for skills with multiple shortcuts):
 *    ---
 *    title: Calendar Actions
 *    description: Manage calendar events
 *    shortcuts: [newCalendarEvent, editCalendarEvent, removeCalendarEvent]
 *    ---
 * 2. Auto-extracted: ### Title (line 1) + first paragraph as description
 */
function parseSkillMeta(filename: string, content: string): SkillMeta & { shortcuts?: string[]; target?: "mac" | "device"; syncApp?: string } {
  const name = filename.replace(/\.(md|txt)$/, "");

  // Try frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1]!;
    const titleMatch = fm.match(/^title:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);
    const shortcutsMatch = fm.match(/^shortcuts:\s*\[([^\]]+)\]/m);
    const targetMatch = fm.match(/^target:\s*(.+)$/m);
    const syncAppMatch = fm.match(/^sync_app:\s*(.+)$/m);
    if (descMatch) {
      const shortcuts = shortcutsMatch
        ? shortcutsMatch[1]!.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;
      const rawTarget = targetMatch?.[1]?.trim().toLowerCase();
      const target: "mac" | "device" | undefined = rawTarget === "mac" ? "mac" : rawTarget === "device" ? "device" : undefined;
      const rawSyncApp = syncAppMatch?.[1]?.trim();
      const syncApp = rawSyncApp && rawSyncApp.toLowerCase() !== "none" ? rawSyncApp : undefined;
      return {
        name,
        file: filename,
        title: titleMatch?.[1]?.trim() ?? name,
        description: descMatch[1]!.trim(),
        shortcuts,
        target,
        syncApp,
      };
    }
  }

  // Auto-extract from markdown
  const lines = content.split("\n");
  let title = name;

  for (const line of lines) {
    const h = line.match(/^#+\s+(.+)$/);
    if (h) {
      title = h[1]!.trim();
      break;
    }
  }

  let foundHeading = false;
  let descLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundHeading) {
      if (/^#+\s+/.test(trimmed)) foundHeading = true;
      continue;
    }
    if (!trimmed) {
      if (descLines.length > 0) break;
      continue;
    }
    if (/^[A-Z][\w\s]+:\s+`/.test(trimmed)) continue;
    if (/^#+\s+/.test(trimmed)) break;
    descLines.push(trimmed);
    if (descLines.join(" ").length > 200) break;
  }

  const description = descLines.join(" ").slice(0, 250) || `Skill: ${title}`;
  return { name, file: filename, title, description };
}

/**
 * Load skill metadata index from both the base `skills/` directory and the
 * user overlay at `data/user/skills/`. User-authored skills override base
 * skills on name collision (same filename wins for the user). Returns a
 * short index for the system prompt and populates the cache map.
 */
function loadSkillsIndex(): string {
  cachedSkillsMap.clear();
  cachedShortcutToSkill.clear();

  // Load base first, then user so user overrides base on name collision.
  const sources: Array<{ dir: string; source: "base" | "user" }> = [
    { dir: SKILLS_DIR, source: "base" },
    { dir: USER_SKILLS_DIR, source: "user" },
  ];

  for (const { dir, source } of sources) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
        .sort();
      for (const file of files) {
        const content = readFileSync(join(dir, file), "utf-8");
        const meta = parseSkillMeta(file, content);
        cachedSkillsMap.set(meta.name, {
          file,
          dir,
          source,
          title: meta.title,
          description: meta.description,
          target: meta.target,
          syncApp: meta.syncApp,
        });
        if (meta.shortcuts) {
          for (const sc of meta.shortcuts) {
            cachedShortcutToSkill.set(sc, meta.name);
          }
        }
      }
    } catch {}
  }

  if (cachedSkillsMap.size === 0) return "";

  const entries: string[] = [];
  const names = [...cachedSkillsMap.keys()].sort();
  for (const name of names) {
    const meta = cachedSkillsMap.get(name)!;
    // Re-parse to get shortcuts list for the index line (kept in cache via shortcut map only)
    let shortcuts: string[] | undefined;
    try {
      const content = readFileSync(join(meta.dir, meta.file), "utf-8");
      const parsed = parseSkillMeta(meta.file, content);
      shortcuts = parsed.shortcuts;
    } catch {}
    const shortcutsLine = shortcuts && shortcuts.length > 0
      ? ` [shortcuts: ${shortcuts.join(", ")}]`
      : "";
    const targetLine = meta.target === "mac" ? " [target: mac]" : "";
    entries.push(`- **${name}** — ${meta.title}: ${meta.description}${shortcutsLine}${targetLine}`);
  }

  return "\n\n## Available Skills\n\nThe following skills are available. Use the `load_skill` tool to load the full content of any skill when you need to use it.\n\n" + entries.join("\n");
}

/**
 * Get the full content of a skill by name.
 * Used by the load_skill tool.
 *
 * Reads from whichever directory the skill was loaded from (base or user
 * overlay). If user prefs are defined, `{{prefs.<key>}}` placeholders in
 * the content are substituted with values from data/user/prefs.json.
 */
export function getSkillContent(name: string): string | null {
  const meta = cachedSkillsMap.get(name);
  if (!meta) return null;
  try {
    const raw = readFileSync(join(meta.dir, meta.file), "utf-8");
    return interpolatePrefs(raw);
  } catch {
    return null;
  }
}

/**
 * Get all skill names (for the load_skill tool's enum).
 */
export function listSkillNames(): string[] {
  return [...cachedSkillsMap.keys()];
}

/**
 * Get the target platform for a skill's shortcuts.
 * Returns "mac" if the skill has target: mac, otherwise "device".
 */
export function getSkillTarget(skillName: string): "mac" | "device" {
  const meta = cachedSkillsMap.get(skillName);
  return meta?.target ?? "device";
}

/**
 * Get the sync app for a shortcut (used to nudge iCloud sync after server-side execution).
 * Looks up which skill contains the shortcut, then returns its sync_app.
 * Returns undefined if no sync_app is set or it's "none".
 */
export function getSyncAppForShortcut(shortcutName: string): string | undefined {
  const skillName = cachedShortcutToSkill.get(shortcutName);
  if (!skillName) return undefined;
  const meta = cachedSkillsMap.get(skillName);
  return meta?.syncApp;
}

// ── Docs (hot-reloaded from docs/ directory) ────────────────────────────

export const DOCS_DIR = join(PROJECT_ROOT, "docs");
let cachedDocsIndex: string = "";
let cachedDocsMtime: number = 0;
let cachedDocsMap: Map<string, { file: string; title: string; description: string }> = new Map();

export interface DocMeta {
  name: string;
  file: string;
  title: string;
  description: string;
}

/**
 * Get the latest mtime across all files in docs/.
 */
function getDocsMaxMtime(): number {
  if (!existsSync(DOCS_DIR)) return 0;
  let maxMtime = 0;
  try {
    const files = readdirSync(DOCS_DIR).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const mtime = statSync(join(DOCS_DIR, file)).mtimeMs;
      if (mtime > maxMtime) maxMtime = mtime;
    }
  } catch {}
  return maxMtime;
}

/**
 * Parse a doc file's frontmatter.
 * Expected format:
 *   ---
 *   title: "Settings Reference"
 *   description: "Complete reference for every setting..."
 *   ---
 * Falls back to filename + empty description if frontmatter is missing.
 */
function parseDocMeta(filename: string, content: string): DocMeta {
  const name = filename.replace(/\.md$/, "");
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1]!;
    const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
    const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
    return {
      name,
      file: filename,
      title: titleMatch?.[1]?.trim() ?? name,
      description: descMatch?.[1]?.trim() ?? "",
    };
  }
  return { name, file: filename, title: name, description: "" };
}

/**
 * Load doc metadata index from docs/ directory.
 * Returns a short index for the system prompt and populates the cache map.
 */
function loadDocsIndex(): string {
  cachedDocsMap.clear();
  if (!existsSync(DOCS_DIR)) return "";
  try {
    const files = readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
    if (files.length === 0) return "";

    const entries: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(DOCS_DIR, file), "utf-8");
      const meta = parseDocMeta(file, content);
      cachedDocsMap.set(meta.name, { file, title: meta.title, description: meta.description });
      const desc = meta.description ? `: ${meta.description}` : "";
      entries.push(`- **${meta.name}** — ${meta.title}${desc}`);
    }

    return (
      "\n\n## Available Documentation\n\n" +
      "Use the `load_doc` tool to read the full content of a documentation page in two situations:\n" +
      "1. **When the user asks** about PocketHook features, settings, API, setup, or any product behavior — load the relevant doc and answer from it rather than from training data.\n" +
      "2. **When you yourself are unsure** about how the product works, how a setting interacts with others, what the protocol expects, or what a shortcut/intent does — consult the docs before acting or answering. Do not guess if a doc can resolve your doubt.\n\n" +
      "Always prefer the actual doc over training data — PocketHook-specific details may be recent or specific to this deployment.\n\n" +
      entries.join("\n")
    );
  } catch {
    return "";
  }
}

/**
 * Get the full content of a doc by name.
 * Used by the load_doc tool.
 */
export function getDocContent(name: string): string | null {
  const meta = cachedDocsMap.get(name);
  if (!meta) return null;
  try {
    return readFileSync(join(DOCS_DIR, meta.file), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Get all doc names (for the load_doc tool's error message).
 */
export function listDocNames(): string[] {
  return [...cachedDocsMap.keys()];
}

/**
 * Get the full system prompt: base (fixed) + skills (hot-reloaded on change).
 */
let cachedLocalePrompt: string = "";

export function setLocale(locale: Config["locale"]): void {
  if (!locale) return;
  cachedLocaleTimezone = locale.timezone;
  const parts = [`The user is located in ${locale.country}`];
  if (locale.city) parts[0] += `, ${locale.city}`;
  parts[0] += ".";
  if (locale.timezone) parts.push(`Timezone: ${locale.timezone}.`);
  parts.push("Use this for location-aware searches, recommendations, and regional context (e.g., if they search for a city name that exists in multiple countries, prefer their region).");
  cachedLocalePrompt = "\n\n## User location\n\n" + parts.join(" ");
}

let cachedLocaleTimezone: string | undefined;

function formatCurrentDate(): string {
  const now = new Date();
  const tz = cachedLocaleTimezone;
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false, weekday: "long",
    timeZone: tz,
  };
  const parts = new Intl.DateTimeFormat("en-CA", opts).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}`;
  const day = get("weekday");
  return `\n\nCurrent date/time: ${date} ${time} (${day})${tz ? ` ${tz}` : ""}`;
}

export function getSystemPrompt(agentName: string, vectorMemoryEnabled: boolean = false, userName?: string, onboardingChat: boolean = false): string {
  if (!BASE_SYSTEM_PROMPT || cachedVectorMemoryFlag !== vectorMemoryEnabled || cachedUserName !== userName) {
    BASE_SYSTEM_PROMPT = buildBaseSystemPrompt(agentName, vectorMemoryEnabled, userName, onboardingChat);
    cachedVectorMemoryFlag = vectorMemoryEnabled;
    cachedUserName = userName;
  }

  const currentMtime = getSkillsMaxMtime();

  if (currentMtime !== cachedSkillsMtime) {
    cachedSkillsIndex = loadSkillsIndex();
    cachedSkillsMtime = currentMtime;
    if (cachedSkillsIndex) {
      logger.info(`Skills reloaded (${cachedSkillsMap.size} file(s))`);
    }
  }

  const currentDocsMtime = getDocsMaxMtime();
  if (currentDocsMtime !== cachedDocsMtime) {
    cachedDocsIndex = loadDocsIndex();
    cachedDocsMtime = currentDocsMtime;
    if (cachedDocsIndex) {
      logger.info(`Docs reloaded (${cachedDocsMap.size} file(s))`);
    }
  }

  return BASE_SYSTEM_PROMPT + getPersonality() + formatCurrentDate() + cachedLocalePrompt + getInstructions() + getUserInstructions() + cachedSkillsIndex + cachedDocsIndex + getCustomToolsPrompt();
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
    userName: process.env.USER_NAME || undefined,
    onboardingChat: process.env.ONBOARDING_CHAT === "true",
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
    embeddingProvider: (process.env.EMBEDDING_PROVIDER || "ollama") as "ollama" | "lm-studio" | "openai",
    embeddingModel: process.env.EMBEDDING_MODEL || "nomic-embed-text",
    embeddingUrl: process.env.EMBEDDING_URL
      || (process.env.EMBEDDING_PROVIDER === "lm-studio" ? "http://localhost:1234" : undefined)
      || (process.env.EMBEDDING_PROVIDER === "openai" ? "https://api.openai.com" : undefined)
      || "http://localhost:11434",
    embeddingApiKey: process.env.EMBEDDING_API_KEY,
    vectorMemoryEnabled: process.env.VECTOR_MEMORY === "true",
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

  writeFileSync(envPath, content, { mode: 0o600 });
}
