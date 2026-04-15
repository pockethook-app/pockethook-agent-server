# pockethook-agent-server

AI agent server for [PocketHook](https://pockethook.app) — connects any LLM provider to iOS Shortcuts via the PocketHook protocol.

The server receives messages from PocketHook, processes them through an LLM with tool-calling capabilities, and returns structured responses that PocketHook executes as iOS Shortcuts on the user's device.

> **This is a starting point, not a finished product.** The server ships with a core set of tools (shell, files, web search, background jobs) and is designed to be extended by you. Add your own integrations — email, calendars, documents, APIs, databases, whatever fits your workflow. Write new skills, adjust the agent instructions, wire up new tools. The goal is for you to make it yours.

Built on [pi-mono](https://github.com/badlogic/pi-mono) (agent framework and multi-provider LLM abstraction) and inspired by [OpenClaw](https://github.com/nickytonline/OpenClaw)'s self-hosted, local-first approach to personal AI assistants.

## Features

- **Multi-provider LLM** — Anthropic, OpenAI, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter, Ollama, LM Studio
- **OAuth authentication** — GitHub Copilot and OpenAI Codex via device code / browser flow
- **Agent tools** — Shell, file read/write, directory listing, background jobs, web search, web scraping, dev server management
- **`run_code_job` meta-tool** — One call creates a Claude Code background job AND sends the user an immediate ack. Replaces the error-prone respond-then-create_job pattern for programming tasks
- **Background jobs** — Schedule one-time or recurring tasks with cron expressions
- **Dev server management** — Start, stop, and list dev servers for workspace projects with optional HTTPS tunnel exposure. `tunnel: true` is enforced: if no tunnel tool is installed or setup fails, the server refuses to start an unreachable localhost process
- **Dynamic skills** — Define shortcuts and behavior rules as `.md` files with YAML frontmatter. Only a compact index is loaded into the prompt; full content is fetched on demand via the `load_skill` tool
- **Server-side shortcuts** — Execute shortcuts on the Mac server instead of the iOS device via `shortcuts run` CLI. Ideal for iCloud-synced actions (notes, calendar, reminders). Configure per-skill with `target: mac` and optional `sync_app` for automatic iCloud sync
- **User customization overlay** — Framework files (`skills/`, `custom-tools/`, `agent-instructions.md`) are read-only. Per-deployment customization lives under `data/user/` (skills, custom tools, instructions, typed prefs). Framework updates land cleanly without clobbering user data
- **Typed user prefs with `{{prefs.*}}` interpolation** — Store values in `data/user/prefs.json`; reference them in skills as `{{prefs.routeOrigin}}` and the server substitutes on load
- **Self-managing skills** — The agent can create, edit, and delete skill definitions (writes always go to the user layer)
- **Agent instructions** — Editable `agent-instructions.md` (framework defaults) + `data/user/instructions.md` (user additions), both hot-reloaded
- **Automatic URL sanitization** — The `respond` tool rewrites `localhost`/`127.0.0.1` URLs to the corresponding tunnel URL when a managed server has one, and logs a warning when it can't — so the iOS device never receives an unreachable link
- **Loadable doc system** — Long procedural details (content rendering, skills format, custom tools format, dashboard, serving projects, memory guide) live in `docs/` and are fetched on demand via `load_doc`, keeping the base prompt compact
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
| `PORT` | `3000` | Server port |
| `AGENT_NAME` | `PocketHook Assistant` | How the agent introduces itself |
| `MAX_HISTORY` | `50` | Messages kept in short-term memory per session |
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
| macOS | launchd | `~/Library/LaunchAgents/com.pockethook.agent-server.plist` |
| Linux | systemd (user) | `~/.config/systemd/user/pockethook-agent-server.service` |
| Windows | NSSM | Windows Service Manager |

The service auto-restarts on failure. Logs on macOS go to `~/Library/Logs/pockethook-agent-server/`.

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
├── skills/                 # framework-shipped skills (read-only)
├── custom-tools/           # framework-shipped custom tool templates (read-only)
├── agent-instructions.md   # framework agent instructions (read-only)
└── data/
    └── user/               # git-ignored, per deployment
        ├── skills/         # user-authored skills (override base on filename)
        ├── custom-tools/   # user-installed custom tools
        ├── instructions.md # user additions to agent instructions
        └── prefs.json      # typed user values, referenced as {{prefs.key}}
```

The agent is told to write all new or edited content to `data/user/*`. The `write` tool enforces this at the code level: any attempt to write into `skills/`, `custom-tools/`, or `agent-instructions.md` is rejected with an error pointing at the correct user-layer path.

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

### Migrating personal content out of the base

Don't edit `skills/route-planner.md`, `skills/calendar-actions.md`, etc. in place. Copy into `data/user/skills/` first and edit the copy — the overlay wins on reload.

## Skills

Skills are `.md` files that define iOS Shortcuts the agent can trigger and/or behavior rules for the agent to follow. They use **dynamic loading**: only a compact index (title, description, shortcut list) is injected into the system prompt. The agent loads the full content on demand via the `load_skill` tool, keeping token usage low as you add more skills.

The runtime scans both `skills/` and `data/user/skills/`; user-authored skills override base on filename collision. See [docs/skills-format.md](docs/skills-format.md) for the full authoring reference.

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

Configure the agent's tone and emoji usage via `bun run personality` or by editing `personality.md` directly (hot-reloaded on next request).

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

- `agent-instructions.md` (project root) — framework defaults. Read-only for the agent; edit directly if you're customizing your own deployment but note that framework updates may overwrite it.
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

The agent has three job management tools: `create_job`, `list_jobs`, `delete_job`.

### `run_code_job` (programming tasks)

For any programming task (create project, audit code, debug, build, test, refactor), the agent uses `run_code_job` instead of `create_job` directly. The meta-tool:

1. Composes the `claude --print --dangerously-skip-permissions` invocation with the right working directory and escaping.
2. Creates a shell `once` job with a sensible default timeout (`30m`).
3. Emits the user-facing ack immediately through the same `respond` channel — the user doesn't wait for the LLM to orchestrate two calls.

Parameters: `task` (required), `project_dir` (optional, relative to `workspace/` or absolute), `timeout` (optional, default `30m`), `ack_message` (optional). See [docs/memory-guide.md](docs/memory-guide.md) and [skills/claude-code.md](skills/claude-code.md) for context on how the job runs.

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

When a user says *"install Playwright and take screenshots for me"*, the agent:
1. Installs the dependency (`bun add playwright`)
2. Creates a tool definition in `custom-tools/` (e.g., `web-screenshot.md`)
3. The tool is available on the next request (hot-reloaded)

Tool definitions are `.md` files with a simple format:

```markdown
### Web Screenshot

Tool name: `web_screenshot`

Take a screenshot of a web page using Playwright.

Install: `bun add playwright && bunx playwright install chromium`

Command: `bunx playwright screenshot $url $output`

Parameters:
- url (string, required): URL to screenshot
- output (string, optional): Output file path. Default: workspace/screenshot.png
```

Custom tools follow the same hot-reload pattern as skills. The agent can create, edit, and delete them. Dependencies are installed automatically on first use.

## Permissions

Granular tool permissions are stored in `permissions.json` (configure via `bun run permissions` or `bun run setup`):

- **Enabled tools** — `shell`, `read`, `write`, `ls`, `create_job`, `list_jobs`, `delete_job`, `web_search`, `web_fetch`, `start_server`, `stop_server`, `list_servers`, `search_memory`, `remember_fact`, `query_facts`, `load_skill`, `load_doc`, `update_memory_status`, `complete_project`
- **Always-on tools** (not gated by `permissions.json`): `respond`, `run_code_job` — both wired to the same response channel so they cannot be missing
- **Working directory boundary** — Prevents the agent from escaping `WORKING_DIR`
- **Base-path write guard** — The `write` tool rejects any path under `skills/`, `custom-tools/`, or `agent-instructions.md` and redirects the agent to `data/user/*`
- **Blocked shell commands** — e.g., `sudo`, `rm -rf /`, `shutdown`
- **Blocked shell patterns** — Regex patterns like `curl.*\|.*sh`
- **Blocked filesystem paths** — e.g., `.env`, `.git`
- **Blocked file patterns** — Globs like `*.key`, `*.pem`

## Versioning

All user data is versioned automatically for safety — no changes are ever lost:

- **Workspace files** — Tracked with a local git repo inside `workspace/`. Every write by the agent creates an auto-commit. Users can undo changes by asking the agent ("undo the last change") or manually with `git revert HEAD` in `workspace/`.
- **Config files** — `agent-instructions.md`, `skills/`, and `permissions.json` are backed up to `data/backups/` before each modification. Up to 20 versions per file are retained.

Git is optional — if not installed, workspace changes are simply unversioned. Config backups always work regardless.

The versioning system is invisible to the user. The agent knows how to undo and restore when asked.

## Memory

The memory system has three layers, each stored in its own database:

### Conversation memory (`data/memory.db`)

SQLite with FTS5 full-text search. All messages are stored with timestamps and session IDs. FTS5 provides keyword-based recall across sessions.

- **Short-term** — Last N messages kept in memory per session
- **Long-term** — All messages persisted in SQLite, searched via FTS5
- Sessions expire after `SESSION_TTL_MINUTES`, but long-term memory persists

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
├── skills/               # Framework-shipped skill definitions (read-only)
├── custom-tools/         # Framework-shipped custom tool templates (read-only)
├── docs/                 # Loadable reference docs (fetched via load_doc on demand)
├── data/                 # Runtime data (memory.db, knowledge.db, backups, and user/ overlay)
│   └── user/             # Per-deployment customization (git-ignored)
│       ├── skills/       # User-authored skills (override base)
│       ├── custom-tools/ # User-installed custom tools
│       ├── instructions.md # User additions to agent instructions
│       └── prefs.json    # Typed user values (referenced as {{prefs.key}} in skills)
├── workspace/            # Agent's working directory
│   └── dashboard/        # Custom dashboard files (hot-reloaded)
├── agent-instructions.md # Base agent instructions (hot-reloaded)
├── personality.md        # Agent personality and emoji config (hot-reloaded)
├── permissions.json      # Tool permissions config
└── .env                  # Runtime configuration
```

### Loadable docs (`docs/`)

Long procedural references that don't need to live in the base prompt. Fetched on demand via the `load_doc` tool when the agent needs them.

| Doc | Load when |
|-----|-----------|
| `content-rendering.md` | Composing rich messages (markdown, HTML, images, buttons) |
| `skills-format.md` | Creating or editing a skill file |
| `custom-tools-format.md` | Installing a new CLI library and wiring it as a tool |
| `dashboard.md` | Customizing the `/dashboard` web page |
| `serving-projects.md` | Starting a dev server, choosing tunnel mode, framework commands |
| `memory-guide.md` | What to store, format conventions, PARA, evolving events |

## Testing

```bash
# Run all tests
bun test

# Type check
bun tsc --noEmit
```

Tests cover permissions enforcement, job scheduling/recovery, rate limiting, and configuration loading. CI runs both on every push and pull request to `main` via GitHub Actions.

## License

MIT
