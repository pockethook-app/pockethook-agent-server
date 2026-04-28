# pockethook-agent-server

AI agent server for [PocketHook](https://pockethook.app) — connects any LLM provider to iOS Shortcuts via the PocketHook protocol.

The server receives messages from PocketHook, processes them through an LLM with tool-calling capabilities, and returns structured responses that PocketHook executes as iOS Shortcuts on the user's device.

> **This is a starting point, not a finished product.** The server ships with a core set of tools (shell, files, web search, background jobs) and is designed to be extended by you. Add your own integrations — email, calendars, documents, APIs, databases, whatever fits your workflow. Write new skills, adjust the agent instructions, wire up new tools. The goal is for you to make it yours.

Built on [pi-mono](https://github.com/badlogic/pi-mono) (agent framework and multi-provider LLM abstraction) and inspired by [OpenClaw](https://github.com/nickytonline/OpenClaw)'s self-hosted, local-first approach to personal AI assistants.

## Features

- **Multi-provider LLM** — Anthropic, OpenAI, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter, Ollama, LM Studio
- **OAuth authentication** — GitHub Copilot and OpenAI Codex via device code / browser flow
- **Agent tools** — Shell, file read/write, directory listing, background jobs, web search, web scraping, dev server management
- **`run_code_job` meta-tool** — One call creates a Claude Code background job AND sends the user an immediate ack. Replaces the error-prone respond-then-create-job pattern for programming tasks
- **Typed respond_* tools** — Six dedicated tools (`respond_text`, `respond_image`, `respond_buttons`, `respond_shortcut`, `respond_html`, `respond_sequence`) build the PocketHook protocol correctly by construction. Schemas reject URLs without image extensions, malformed button syntax, and other common mistakes before they reach the device
- **Typed job tools** — `create_once_job` (one-off) and `create_cron_job` (recurring) with discriminated-union schemas for schedule and body; impossible to pass an invalid `type`/`schedule` combination
- **Typed workspace tools** — `create_project`, `list_projects`, `delete_project`, plus name-only `project_name` parameters on `run_code_job` and `start_server`. The agent never constructs paths, so bugs like `workspace/workspace/foo` are structurally impossible
- **Dev server management** — Start, stop, and list dev servers with optional HTTPS tunnel. `tunnel: true` is pre-flight checked: if no tunnel tool is installed or setup fails, the server refuses to start an unreachable localhost process
- **Dynamic skills** — Define shortcuts and behavior rules as `.md` files with YAML frontmatter. Only a compact index is loaded into the prompt; full content is fetched on demand via `load_skill`
- **Server-side shortcuts** — Execute shortcuts on the Mac server instead of the iOS device via `shortcuts run` CLI. Configure per-skill with `target: mac` and optional `sync_app` for automatic iCloud sync
- **User customization overlay** — Framework files (`skills/`, `custom-tools/`, `config/`) are read-only. Per-deployment customization lives under `data/user/` (skills, custom tools, instructions, typed prefs). Framework updates land cleanly without clobbering user data
- **Typed writer tools** — `create_user_skill` and `create_custom_tool` build the user-layer markdown with correct frontmatter/format, so the loader always parses them; the agent never hand-writes these files
- **Typed user prefs with `{{prefs.*}}` interpolation** — Store values in `data/user/prefs.json`; reference them in skills as `{{prefs.routeOrigin}}` and the server substitutes on load
- **Agent instructions** — Editable `config/agent-instructions.md` (framework defaults) + `data/user/instructions.md` (user additions), both hot-reloaded
- **Automatic URL sanitization** — Every respond_* tool rewrites `localhost`/`127.0.0.1` URLs to the corresponding tunnel URL when a managed server has one, and logs a warning when it can't — the iOS device never receives an unreachable link
- **Semantic memory** — Vector-based search with embeddings (Ollama, LM Studio, or OpenAI) stored in a separate `knowledge.db`. Memories are auto-classified into wing/room/hall/status dimensions by the LLM
- **Knowledge graph** — Temporal triple store for durable facts with auto-invalidation. Multi-value relationships (children, friends) coexist; single-value facts (lives_in, partner) auto-replace
- **PARA method** — Every memory is tagged with a status (Project, Area, Resource, Archive). Projects are closed with semantic similarity matching; reference material survives project closures
- **Hybrid recall** — Combines FTS5 keyword search with vector semantic search using reciprocal rank fusion
- **Long-term memory** — SQLite + FTS5 full-text search for context recall across sessions (fallback when semantic memory is disabled)
- **HTTPS tunneling** — Built-in support for Tailscale, ngrok, and Cloudflare Tunnel
- **System service** — Install as a persistent service on macOS, Linux, or Windows
- **PocketHook protocol** — Standard `msg`/`shortcut`/`data`/`url` response format via `@pockethook/sdk`

## Requirements

- [Bun](https://bun.sh) runtime
- A PocketHook app instance configured to point to this server
- An API key or OAuth credentials for your chosen LLM provider
- (Optional) [Tailscale](https://tailscale.com), [ngrok](https://ngrok.com), or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for HTTPS tunneling

## Quick start

```bash
# Install dependencies
bun install

# Interactive setup (provider, model, auth, locale, personality, permissions)
bun run setup

# Start the server with HTTPS tunnel
bun run dev:tunnel

# Or start them separately
bun run dev       # Server with hot-reload
bun run tunnel    # HTTPS tunnel in another terminal
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run setup` | Full interactive setup |
| `bun run switch` | Change LLM provider/model |
| `bun run personality` | Configure agent personality and emoji usage |
| `bun run permissions` | Configure tool permissions |
| `bun run memory` | Configure short-term window (`MAX_HISTORY`) and semantic recall (`MAX_RECALL`) |
| `bun run refresh` | Refresh OAuth token (Codex / Copilot) |
| `bun run start` | Start the server |
| `bun run dev` | Start with hot-reload |
| `bun run tunnel` | Start HTTPS tunnel |
| `bun run dev:tunnel` | Start server + tunnel together |
| `bun run service install` | Install as system service |
| `bun run service stop` | Stop the service |
| `bun run service restart` | Restart the service |
| `bun run service uninstall` | Remove the service |
| `bun run service status` | Show service status |
| `bun run logs` | Stream service logs (cross-platform) |

## Configuration

All configuration is stored in `.env` (created by `bun run setup`):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | (required) | Shared secret with PocketHook app |
| `LLM_API_KEY` | (required) | LLM provider API key or OAuth token |
| `LLM_PROVIDER` | `anthropic` | LLM provider name |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | Model ID |
| `LLM_REASONING` | `off` | Reasoning effort: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Higher levels add hidden thinking tokens (slower + more expensive). Ignored or rejected by models that don't support it. |
| `PORT` | `3000` | Server port |
| `AGENT_NAME` | `PocketHook Assistant` | How the agent introduces itself |
| `MAX_HISTORY` | `50` | Messages kept in short-term memory per session |
| `MAX_RECALL` | `5` | Memories returned per turn by semantic recall (only when `VECTOR_MEMORY=true`) |
| `SESSION_TTL_MINUTES` | `60` | Session expiration time |
| `WORKING_DIR` | `workspace/` | Agent's restricted working directory |
| `FETCH_MESSAGE` | `fetchPendingTasks` | Message that triggers job result delivery |
| `DASHBOARD` | `true` | Enable web dashboard (`/dashboard` route) |
| `SEARCH_PROVIDER` | — | Search provider: `serper` or `searxng` |
| `SEARCH_API_KEY` | — | Serper.dev API key (when using `serper`) |
| `SEARCH_URL` | — | SearXNG instance URL (when using `searxng`) |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`. JSON output in production |
| `RATE_LIMIT_MAX` | `30` | Max requests per rate limit window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window in milliseconds |
| `LOCALE_COUNTRY` | (auto-detected) | User country for location-aware searches |
| `LOCALE_CITY` | (auto-detected) | User city for regional context |
| `LOCALE_TIMEZONE` | (auto-detected) | User timezone |
| `LLM_BASE_URL` | — | Custom LLM API base URL (required for Ollama/LM Studio, optional for others) |
| `VECTOR_MEMORY` | `false` | Enable semantic memory (requires an embedding provider) |
| `EMBEDDING_PROVIDER` | `ollama` | Embedding provider: `ollama`, `lm-studio`, or `openai` |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model name |
| `EMBEDDING_URL` | (auto) | Embedding API URL. Defaults: Ollama `http://localhost:11434`, LM Studio `http://localhost:1234`, OpenAI `https://api.openai.com` |
| `EMBEDDING_API_KEY` | — | API key for OpenAI embeddings (not needed for Ollama/LM Studio) |
| `TOOLS` | `all` | Enabled tools (see Permissions) |
| `INSTANCE_NAME` | (project dir basename, with `pockethook-` prefix stripped) | Suffix used for the system service label, log directory, and process matching. Set explicitly when running multiple checkouts on the same machine. |

### Supported providers

| Provider | Auth | Default model |
|----------|------|---------------|
| Anthropic | API key | `claude-sonnet-4-20250514` |
| OpenAI | API key | `gpt-4.1-mini` |
| OpenAI Codex | OAuth | `gpt-5.1-codex-mini` |
| GitHub Copilot | OAuth | `claude-sonnet-4` |
| Google (Gemini) | API key | `gemini-2.5-flash` |
| Mistral | API key | `mistral-medium-latest` |
| Groq | API key | `llama-3.3-70b-versatile` |
| xAI (Grok) | API key | `grok-3-mini-fast` |
| OpenRouter | API key | `anthropic/claude-sonnet-4` |
| Ollama (local) | None | `llama3.2` |
| LM Studio (local) | None | `qwen3.5-4b-mlx` |

## API Endpoints

### `POST /` — Chat

Send a message to the agent. Requires `Authorization: Bearer <token>`.

```json
[{"sessionId": "uuid", "action": "sendMessage", "chatInput": "your message"}]
```

Response:
```json
[{"msg": "response text", "shortcut": "ShortcutName", "data": {"key": "value"}, "url": "https://..."}]
```

### `GET /dashboard` — Web dashboard

Shows a live overview of background jobs with status, schedule, and output. Auto-refreshes every 30 seconds. Disabled when `DASHBOARD=false`.

> **Unauthenticated by design.** Both `/dashboard` and `/api/jobs` are open `GET` endpoints — anyone who can reach the host can list jobs. Restrict access at the network layer (Tailscale ACL, firewall, reverse proxy with basic auth) or set `DASHBOARD=false` if you don't need it. The PocketHook iOS app does not use these endpoints.

Fully customizable with two approaches:

- **Single HTML file** — Place a `dashboard.html` in `workspace/dashboard/` for quick customizations. Hot-reloaded on change.
- **Full project** — Create a framework project (Svelte, React, Vue, etc.) in `workspace/dashboard/` with build output to `dist/`. The server serves all static assets from `dist/` under `/dashboard/` (JS, CSS, images, fonts).

Priority: `dist/index.html` > `dashboard.html` > built-in default.

The agent can create and edit dashboards when asked by the user — each user gets a unique, personalized dashboard.

All responses include an `X-API-Version` header with the current server version.

### Rate limiting

All `POST` requests are rate-limited per auth token. Default: 30 requests per 60 seconds. Returns `429 Too Many Requests` with a `Retry-After` header when exceeded. Configure via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.

Request body size is limited to 1 MB. Message length is limited to 10,000 characters.

### `GET /health` — Health check

Returns plain text `true` with status 200. Configure in PocketHook as the Health Check URL.

### `GET /jobs` — Jobs polling

Returns `true` if there are completed job results pending delivery, `false` otherwise. Configure in PocketHook as the Polling URL. When PocketHook receives `true`, it sends the configured fetch message to trigger result delivery.

## HTTPS Tunnel

PocketHook requires HTTPS. The built-in tunnel tool auto-detects available tools and creates the tunnel:

```bash
bun run tunnel
```

Supports:
- **Tailscale** — Persistent (no process needed), auto-detects hostname, avoids port conflicts
- **ngrok** — Generates a public URL, fetches it from the ngrok API
- **Cloudflare Tunnel** — Quick tunnel with random URL

The tunnel shows all URLs ready to copy into PocketHook Settings:

```
  Server URL:    https://your-host.ts.net:8443
  Health check:  https://your-host.ts.net:8443/health
  Jobs polling:  https://your-host.ts.net:8443/jobs
```

Use `bun run dev:tunnel` to start the server and tunnel together in a single command.

## System Service

Install as a persistent system service that starts automatically:

```bash
bun run service install
```

During install, you can optionally configure the HTTPS tunnel (Tailscale recommended — it persists without a running process).

| Platform | Backend | Service location |
|----------|---------|-----------------|
| macOS | launchd | `~/Library/LaunchAgents/com.pockethook.${INSTANCE_NAME}.plist` |
| Linux | systemd (user) | `~/.config/systemd/user/pockethook-${INSTANCE_NAME}.service` |
| Windows | NSSM | Windows Service Manager (`PocketHook-${PascalCase(INSTANCE_NAME)}`) |

The service auto-restarts on failure. Logs on macOS go to `~/Library/Logs/pockethook-${INSTANCE_NAME}/`.

`INSTANCE_NAME` defaults to the project directory basename (with the `pockethook-` prefix stripped) — e.g., a checkout in `pockethook-agent-server/` becomes `agent-server`. Set it explicitly to run several checkouts on the same machine without collisions (e.g., a personal install plus a demo install). Each instance keeps its own `data/` and logs.

Manage the service:
```bash
bun run service status     # Check if running
bun run service restart    # Apply changes to .env or permissions
bun run service stop       # Temporarily stop
bun run service uninstall  # Remove service and tunnel config
```

## User customization layout

The runtime separates **framework files** (shipped with the repo, read-only for the agent) from **user files** (per-deployment, written by the agent on the user's behalf). This split keeps framework updates clean from user data.

```
pockethook-agent-server/
├── skills/                      # framework-shipped skills (read-only)
├── custom-tools/                # framework-shipped custom tool templates (read-only)
├── config/
│   ├── agent-instructions.md    # framework agent instructions (read-only)
│   └── personality.md           # framework personality (read-only)
└── data/
    └── user/                    # git-ignored, per deployment
        ├── skills/              # user-authored skills (override base on filename)
        ├── custom-tools/        # user-installed custom tools
        ├── instructions.md      # user additions to agent instructions
        └── prefs.json           # typed user values, referenced as {{prefs.key}}
```

User customization is written via dedicated typed tools (`create_user_skill`, `create_custom_tool`) so the resulting files always match the loader's format. Additionally, the `write` tool rejects any path under `skills/`, `custom-tools/`, or `config/` and redirects the agent to `data/user/*` — so even direct file edits end up in the user layer.

### Typed preferences

`data/user/prefs.json` holds arbitrary JSON — scalar values, nested objects, whatever. Skills reference values as `{{prefs.routeOrigin}}` or `{{prefs.tunnel.domain}}` and the server substitutes them when the skill is loaded (via `load_skill`). Unknown keys are left as-is so typos are visible.

Example:

```json
{
  "routeOrigin": "Madrid, Spain",
  "preferredMapsApp": "apple",
  "tunnel": { "domain": "my-host.ts.net" }
}
```

#### `integrationDefaults` — stack the agent uses when scaffolding a new integration

When you ask the agent to "add a tool / integration for X", it scaffolds a project under `workspace/` and registers a custom-tool. The `integrationDefaults` block in `prefs.json` tells it *what stack to use*:

```json
{
  "integrationDefaults": {
    "language": "typescript",
    "runtime": "bun",
    "compileToBinary": false,
    "notes": ""
  }
}
```

Recommended default: Bun + TypeScript + **run-from-source** (no compile step — the server already has Bun, so the smaller/faster path wins for local integrations). To change it, just ask the agent: *"de ahora en adelante usa Go para las integraciones"* or *"compila las integraciones a binario"* — it updates `prefs.json` for you. `notes` is a free-form escape hatch for hints that don't fit the other three fields (preferred CLI library, dep manager, testing framework, etc.). See `custom-tools/_example-integration.md` for the canonical shape the agent follows.

### Migrating personal content out of the base

Don't edit `skills/route-planner.md`, `skills/calendar-actions.md`, etc. in place. Copy into `data/user/skills/` first and edit the copy — the overlay wins on reload.

## Skills

Skills are `.md` files that define iOS Shortcuts the agent can trigger and/or behavior rules for the agent to follow. They use **dynamic loading**: only a compact index (title, description, shortcut list) is injected into the system prompt. The agent loads the full content on demand via the `load_skill` tool, keeping token usage low as you add more skills.

The runtime scans both `skills/` and `data/user/skills/`; user-authored skills override base on filename collision. Use the `create_user_skill` tool to add new skills — it builds the frontmatter correctly. If you want to edit a user-layer skill by hand, the format is: YAML frontmatter (`title`, `description`, `shortcuts: []`, optional `target`/`sync_app`) + Markdown body.

Each skill file should start with YAML frontmatter:

```markdown
---
title: Notes
description: Create notes on the user's device with a title and body
shortcuts: [newNote]
target: mac
sync_app: Notes
---

### New Note

Shortcut name: `newNote`

Creates a new note on the user's device.

Data fields:
- title (string, required): Note title
- content (string, required): Note body

Example:
{ "msg": "Creating your note...", "shortcut": "newNote", "data": { "title": "Shopping List", "content": "1. Milk\n2. Eggs" } }
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable name |
| `description` | Yes | One sentence for the skills index |
| `shortcuts` | Yes | Array of shortcut names. Use `[]` for behavior-only skills |
| `target` | No | `device` (default) sends to iOS, `mac` executes on the server |
| `sync_app` | No | App to open in background after server execution to nudge iCloud sync (e.g., `Notes`, `Calendar`). Set to `none` or omit to skip |

### Server-side execution

When a skill has `target: mac`, shortcuts run silently on the Mac server via `shortcuts run` CLI instead of being sent to the iOS device. This is ideal for actions that create iCloud-synced content (notes, reminders, calendar events) — the result syncs to all devices automatically.

If `sync_app` is set, the server briefly opens the app in the background after execution to trigger iCloud sync, then closes it after 5 seconds. The server falls back to device execution if not running on macOS.

Skills can also be **behavior rules** without shortcuts (e.g., "how to plan a family trip"). Use `shortcuts: []` in the frontmatter for these.

The agent can create and manage skills when asked by the user. See `skills/_example.md` for the full template.

## Personality

Configure the agent's tone and emoji usage via `bun run personality` or by editing `config/personality.md` directly (hot-reloaded on next request).

Four built-in presets:

| Preset | Description |
|--------|-------------|
| **Warm** | Personally invested, empathetic, celebrates wins, asks follow-ups |
| **Friendly** | Casual, relaxed, light humor, like a helpful colleague |
| **Professional** | Direct, structured, precise, respects the user's time |
| **Minimal** | Maximum brevity, no filler, no pleasantries |

You can also choose **Custom** to write your own personality description. Emoji usage is a separate yes/no option independent of the personality preset.

## Agent Instructions

Two layers, both hot-reloaded:

- `config/agent-instructions.md` — framework defaults. Read-only for the agent; edit directly if you're customizing your own deployment but note that framework updates may overwrite it.
- `data/user/instructions.md` — user-specific additions. Anything the user asks the agent to apply globally ("always answer in English", "never use tables", "prefer concise responses") is appended here by the agent. Survives framework updates.

Both files are concatenated into the system prompt. No restart needed.

## Background Jobs

The agent can schedule background jobs that run even when the user isn't chatting.

### Job types

- **Once** — Run a single time, then deliver the result
- **Cron** — Repeat on a schedule, deliver results after each run

### Scheduling

Two formats supported:

| Format | Examples |
|--------|---------|
| Simple intervals | `30s`, `5m`, `1h`, `1d`, `2w` |
| Cron expressions | `0 9 * * MON-FRI`, `*/30 * * * *`, `0 0 1 * *` |

Cron format: `minute hour day-of-month month day-of-week`

### Execution types

- **shell** — Runs a bash command, captures stdout/stderr
- **prompt** — Processed by the AI agent with full tool access, stores the complete PocketHook response (msg + shortcut + data + url)

### Delivery

Shell jobs can optionally trigger an iOS Shortcut on completion via `on_complete_shortcut` and `on_complete_data`. The job output is injected into `data.output`.

Completed results are delivered **instantly without LLM processing** — stored results go directly to the device when it polls.

### Agent tools

The agent has four job management tools: `create_once_job`, `create_cron_job`, `list_jobs`, `delete_job`.

- `create_once_job({ name, body: { kind: "shell" | "prompt", ... }, delay?, timeout?, silent?, on_complete_shortcut?, on_complete_data? })` — run once.
- `create_cron_job({ name, schedule: { kind: "interval", value } | { kind: "cron", expression }, body, timeout?, silent? })` — run on a schedule.

The `body` is a discriminated union (`{ kind: "shell", command }` or `{ kind: "prompt", prompt }`) so it's impossible to mix the two by accident.

### `run_code_job` (programming tasks)

For any programming task (create project, audit code, debug, build, test, refactor), the agent uses `run_code_job` instead of `create_once_job` directly. The meta-tool:

1. Creates a `prompt`-type job with the configured model as the runner.
2. Emits the user-facing ack immediately through the same respond channel — the user doesn't wait for the LLM to orchestrate two calls.

Parameters: `task` (required), `project_name` (optional; just a name, the tool resolves the path — **never pass a path**), `timeout` (optional, default `30m`), `ack_message` (optional).

### Web tools

- **`web_search`** — Search the web via Serper.dev or SearXNG. Returns titles, snippets, and URLs.
- **`web_fetch`** — Fetch any URL and extract clean readable content (via [Jina Reader](https://jina.ai/reader/)). Used to read full articles, product pages, reviews, etc.

## Dev Servers

The agent can start and manage dev servers for workspace projects. When the agent creates a web project (Hugo, Astro, Next.js, Flask, etc.), it proactively offers to serve it.

Two modes:

- **Preview** — Starts a local dev server on an auto-assigned port (starting from 4000).
- **Public** — Starts the server and exposes it via HTTPS tunnel (Tailscale).

The agent uses `$PORT` as a placeholder in commands, which gets replaced with the assigned port.

Server tools: `start_server`, `stop_server`, `list_servers`. State is persisted in `data/servers.json`. Running servers are cleaned up when the main server stops.

## Custom Tools

The agent can install CLI tools and register them as new agent tools — extending its own capabilities without modifying the server code.

When a user says *"install Playwright and take screenshots for me"*, the agent calls `create_custom_tool` with typed arguments:

```js
create_custom_tool({
  name: "web_screenshot",
  display_name: "Web Screenshot",
  description: "Take a screenshot of a web page using Playwright.",
  install: "bun add playwright && bunx playwright install chromium",
  command: "bunx playwright screenshot $url $output",
  parameters: [
    { name: "url",    type: "string", required: true,  description: "URL to screenshot" },
    { name: "output", type: "string", required: false, description: "Output file path", default: "workspace/screenshot.png" }
  ]
})
```

The tool is written to `data/user/custom-tools/web_screenshot.md` in the exact markdown format the loader expects, and is available on the next request (hot-reloaded). The agent never hand-writes these files — the typed schema plus the writer tool make it impossible to get the format wrong.

You can also author custom tools by hand by placing markdown files in `data/user/custom-tools/` following the same `### Display Name` / `Tool name:` / `Command:` / `Parameters:` structure used by `custom-tools/_example.md`.

## Permissions

Granular tool permissions are stored in `permissions.json` (configure via `bun run permissions` or `bun run setup`):

- **Enabled tools** — `shell`, `read`, `write`, `ls`, `create_project`, `list_projects`, `delete_project`, `create_once_job`, `create_cron_job`, `list_jobs`, `delete_job`, `web_search`, `web_fetch`, `start_server`, `stop_server`, `list_servers`, `search_memory`, `remember_fact`, `query_facts`, `load_skill`, `update_memory_status`, `complete_project`, `create_custom_tool`, `create_user_skill`
- **Always-on tools** (not gated by `permissions.json`): `respond_text`, `respond_image`, `respond_buttons`, `respond_shortcut`, `respond_html`, `respond_sequence`, `run_code_job` — all wired to the same response channel so they cannot be missing
- **Working directory boundary** — Prevents the agent from escaping `WORKING_DIR`
- **Base-path write guard** — The `write` tool rejects any path under `skills/`, `custom-tools/`, or `config/agent-instructions.md` and redirects the agent to `data/user/*`
- **Blocked shell commands** — e.g., `sudo`, `rm -rf /`, `shutdown`
- **Blocked shell patterns** — Regex patterns like `curl.*\|.*sh`
- **Blocked filesystem paths** — e.g., `.env`, `.git`
- **Blocked file patterns** — Globs like `*.key`, `*.pem`

## Versioning

All user data is versioned automatically for safety — no changes are ever lost:

- **Workspace files** — Tracked with a local git repo inside `workspace/`. Every write by the agent creates an auto-commit. Users can undo changes by asking the agent ("undo the last change") or manually with `git revert HEAD` in `workspace/`.
- **Config files** — `config/agent-instructions.md`, `config/personality.md`, `skills/`, and `permissions.json` are backed up to `data/backups/` before each modification. Up to 20 versions per file are retained.

Git is optional — if not installed, workspace changes are simply unversioned. Config backups always work regardless.

The versioning system is invisible to the user. The agent knows how to undo and restore when asked.

## Memory

The memory system has three layers, each stored in its own database:

### Conversation memory (`data/memory.db`)

SQLite with FTS5 full-text search. All messages are stored with timestamps and session IDs. FTS5 provides keyword-based recall across sessions.

- **Short-term** — Last `MAX_HISTORY` messages kept in memory per session
- **Long-term** — All messages persisted in SQLite, searched via FTS5
- **Recall per turn** — When semantic memory is on, `MAX_RECALL` controls how many relevant memories are injected into the prompt each turn
- Sessions expire after `SESSION_TTL_MINUTES`, but long-term memory persists

Tune these interactively with `bun run memory`.

### Semantic memory (`data/knowledge.db`) — optional

Requires `VECTOR_MEMORY=true` and an embedding provider (Ollama, LM Studio, or OpenAI).

**Vector store** — Each message is embedded and stored with palace-style metadata, auto-classified by the LLM:
- **Wing** — The entity the message is about (`user`, `person:john`, `project:blog`, `place:london`, etc.)
- **Room** — The type of memory (`facts`, `preferences`, `events`, `decisions`, `requests`, `context`, etc.)
- **Hall** — The topic (`personal`, `tech`, `health`, `travel`, `food`, `work`, etc.)
- **Status** — PARA classification (`project`, `area`, `resource`, `archive`)

**Knowledge graph** — Temporal triple store for structured facts:
- Triples: `(subject, predicate, object)` with `valid_from` / `valid_until`
- Single-value predicates (`lives_in`, `partner`) auto-invalidate the old value on update
- Multi-value predicates (`child`, `friend`, `sibling`, `hobby`) coexist without invalidation
- Project-specific predicates use slugs (`scheduled_visit_london`, `scheduled_visit_tokyo`) so concurrent projects don't overwrite each other

**Hybrid recall** — `buildContext()` merges FTS5 keyword results with vector semantic results using reciprocal rank fusion. Entity extraction from the user's query focuses the vector search on relevant wings. Knowledge graph facts are injected alongside recalled memories.

**PARA lifecycle** — When a project completes or is cancelled, `complete_project` uses semantic similarity to archive only the relevant project's vectors while preserving reference material (lists, recommendations) as `resource` for future use.

**Project-end cascade** — `complete_project` accepts an optional `project_slug` and `reason` (`"cancelled"` or `"completed"`). When provided, the handler:

1. Archives the project's vectors (events, decisions, requests).
2. Invalidates every active triple whose predicate is the slug exactly or ends in `_<slug>` (so `scheduled_visit_barcelona`, `planning_visit_barcelona`, and `confirmed_visit_barcelona` all close, while `scheduled_revisit_barcelona` is left alone).
3. Records a single completion triple, e.g., `(user, "cancelled_visit_barcelona", "2026-04-15")`.

This replaces the error-prone three-call pattern (`complete_project` → `remember_fact` → `respond`) with a single call. The prompt no longer carries the orchestration rule.

If `VECTOR_MEMORY` is disabled or the embedding provider is unreachable, the system falls back to FTS5-only with no errors.

## Project structure

```
pockethook-agent-server/
├── src/
│   ├── index.ts          # HTTP server, routing, job delivery
│   ├── config.ts         # Config loading, system prompt, hot-reload, user overlay + prefs
│   ├── dashboard.ts      # Web dashboard HTML and jobs API
│   ├── llm.ts            # Agent execution, LLM communication, respond/run_code_job wiring
│   ├── tools.ts          # Tool implementations (shell, files, jobs, memory, skills, run_code_job)
│   ├── embeddings.ts     # Multi-provider embedding client (Ollama, LM Studio, OpenAI)
│   ├── vector-memory.ts  # Palace-style vector store with LLM classification
│   ├── knowledge-graph.ts # Temporal triple store + slug-based cascade invalidation
│   ├── custom-tools.ts   # Custom tool loader with base + data/user/custom-tools overlay
│   ├── servers.ts        # Dev server process manager (start/stop/list, tunnel)
│   ├── versioning.ts     # Workspace git + config backups
│   ├── jobs.ts           # Background job system, cron scheduler
│   ├── logger.ts         # Structured logging with level filtering
│   ├── logs.ts           # Cross-platform service log viewer
│   ├── rate-limit.ts     # Per-token rate limiting
│   ├── permissions.ts    # Permission enforcement
│   ├── sessions.ts       # Session management, hybrid recall, knowledge graph injection
│   ├── memory.ts         # SQLite + FTS5 + hybrid recall (vector + keyword fusion)
│   ├── setup.ts          # Interactive CLI setup
│   ├── service.ts        # System service management
│   ├── tunnel.ts         # HTTPS tunnel setup
│   └── dev-tunnel.ts     # Combined dev server + tunnel
├── skills/                    # Framework-shipped skill definitions (read-only)
├── custom-tools/              # Framework-shipped custom tool templates (read-only)
├── config/
│   ├── agent-instructions.md  # Base agent instructions (hot-reloaded)
│   └── personality.md         # Agent personality and emoji config (hot-reloaded)
├── data/                      # Runtime data (memory.db, knowledge.db, backups, and user/ overlay)
│   └── user/                  # Per-deployment customization (git-ignored)
│       ├── skills/            # User-authored skills (override base)
│       ├── custom-tools/      # User-installed custom tools
│       ├── instructions.md    # User additions to agent instructions
│       └── prefs.json         # Typed user values (referenced as {{prefs.key}} in skills)
├── workspace/                 # Agent's working directory
│   └── dashboard/             # Custom dashboard files (hot-reloaded)
├── permissions.json           # Tool permissions config
└── .env                       # Runtime configuration
```

## Testing

```bash
# Run all tests
bun test

# Type check
bun tsc --noEmit
```

Tests cover permissions enforcement, job scheduling/recovery, rate limiting, and configuration loading. CI runs both on every push and pull request to `main` via GitHub Actions.

## Contributing

Issues welcome, pull requests not currently accepted. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
