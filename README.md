# pockethook-agent-server

AI agent server for [PocketHook](https://pockethook.app) — connects any LLM provider to iOS Shortcuts via the PocketHook protocol.

The server receives messages from PocketHook, processes them through an LLM with tool-calling capabilities, and returns structured responses that PocketHook executes as iOS Shortcuts on the user's device.

> **This is a starting point, not a finished product.** The server ships with a core set of tools (shell, files, web search, background jobs) and is designed to be extended by you. Add your own integrations — email, calendars, documents, APIs, databases, whatever fits your workflow. Write new skills, adjust the agent instructions, wire up new tools. The goal is for you to make it yours.

Built on [pi-mono](https://github.com/badlogic/pi-mono) (agent framework and multi-provider LLM abstraction) and inspired by [OpenClaw](https://github.com/nickytonline/OpenClaw)'s self-hosted, local-first approach to personal AI assistants.

## Features

- **Multi-provider LLM** — Anthropic, OpenAI, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter, Ollama, LM Studio
- **OAuth authentication** — GitHub Copilot and OpenAI Codex via device code / browser flow
- **Agent tools** — Shell, file read/write, directory listing, background jobs, web search, web scraping, dev server management
- **Background jobs** — Schedule one-time or recurring tasks with cron expressions
- **Dev server management** — Start, stop, and list dev servers for workspace projects with optional HTTPS tunnel exposure
- **Dynamic skills** — Define shortcuts and behavior rules as `.md` files in `skills/` with YAML frontmatter. Only a compact index is loaded into the prompt; full content is fetched on demand via the `load_skill` tool
- **Self-managing skills** — The agent can create, edit, and delete skill definitions
- **Agent instructions** — Editable `agent-instructions.md` to customize agent behavior, hot-reloaded
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

## Skills

Skills are `.md` files in `skills/` that define iOS Shortcuts the agent can trigger and/or behavior rules for the agent to follow. They use **dynamic loading**: only a compact index (title, description, shortcut list) is injected into the system prompt. The agent loads the full content on demand via the `load_skill` tool, keeping token usage low as you add more skills.

Each skill file should start with YAML frontmatter:

```markdown
---
title: Notes
description: Create notes on the user's device with a title and body
shortcuts: [newNote]
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

Edit `agent-instructions.md` in the project root to customize how the agent works — its methodology, coding style, communication preferences, etc. Changes are picked up automatically without restarting.

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

- **Enabled tools** — `shell`, `read`, `write`, `ls`, `create_job`, `list_jobs`, `delete_job`, `web_search`, `web_fetch`, `start_server`, `stop_server`, `list_servers`, `search_memory`, `remember_fact`, `query_facts`, `load_skill`, `update_memory_status`, `complete_project`
- **Working directory boundary** — Prevents the agent from escaping `WORKING_DIR`
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

If `VECTOR_MEMORY` is disabled or the embedding provider is unreachable, the system falls back to FTS5-only with no errors.

## Project structure

```
pockethook-agent-server/
├── src/
│   ├── index.ts          # HTTP server, routing, job delivery
│   ├── config.ts         # Config loading, system prompt, hot-reload
│   ├── dashboard.ts      # Web dashboard HTML and jobs API
│   ├── llm.ts            # Agent execution, LLM communication, quickPrompt
│   ├── tools.ts          # Tool implementations (shell, files, jobs, memory, skills)
│   ├── embeddings.ts     # Multi-provider embedding client (Ollama, LM Studio, OpenAI)
│   ├── vector-memory.ts  # Palace-style vector store with LLM classification
│   ├── knowledge-graph.ts # Temporal triple store with auto-invalidation
│   ├── custom-tools.ts   # Custom tool loader (hot-reload from custom-tools/*.md)
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
├── skills/               # Hot-reloadable shortcut definitions
├── custom-tools/         # Hot-reloadable custom tool definitions
├── data/                 # Runtime data (memory.db, knowledge.db, service metadata, backups)
├── workspace/            # Agent's working directory
│   └── dashboard/        # Custom dashboard files (hot-reloaded)
├── agent-instructions.md # Editable agent behavior (hot-reloaded)
├── personality.md        # Agent personality and emoji config (hot-reloaded)
├── permissions.json      # Tool permissions config
└── .env                  # Runtime configuration
```

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
