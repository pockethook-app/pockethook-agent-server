# flowmate-agent-server

AI agent server for [FlowMate](https://github.com/appflowmate/FlowMate) — connects any LLM provider to iOS Shortcuts via the FlowMate protocol.

The server receives messages from FlowMate, processes them through an LLM with tool-calling capabilities, and returns structured responses that FlowMate executes as iOS Shortcuts on the user's device.

## Features

- **Multi-provider LLM** — Anthropic, OpenAI, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter
- **OAuth authentication** — GitHub Copilot and OpenAI Codex via device code / browser flow
- **Agent tools** — Shell, file read/write, directory listing, background jobs, web search, web scraping
- **Background jobs** — Schedule one-time or recurring tasks with cron expressions
- **Hot-reloadable skills** — Define shortcuts as `.md` files in `skills/`, no restart needed
- **Self-managing skills** — The agent can create, edit, and delete skill definitions
- **Agent instructions** — Editable `agent-instructions.md` to customize agent behavior, hot-reloaded
- **Long-term memory** — SQLite + FTS5 full-text search for context recall across sessions
- **HTTPS tunneling** — Built-in support for Tailscale, ngrok, and Cloudflare Tunnel
- **System service** — Install as a persistent service on macOS, Linux, or Windows
- **FlowMate protocol** — Standard `msg`/`shortcut`/`data`/`url` response format via `@flow-mate/sdk`

## Requirements

- [Bun](https://bun.sh) runtime
- A FlowMate app instance configured to point to this server
- An API key or OAuth credentials for your chosen LLM provider
- (Optional) [Tailscale](https://tailscale.com), [ngrok](https://ngrok.com), or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for HTTPS tunneling

## Quick start

```bash
# Install dependencies
bun install

# Interactive setup (provider, model, auth, port, fetch message, permissions)
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

## Configuration

All configuration is stored in `.env` (created by `bun run setup`):

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | (required) | Shared secret with FlowMate app |
| `LLM_API_KEY` | (required) | LLM provider API key or OAuth token |
| `LLM_PROVIDER` | `anthropic` | LLM provider name |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | Model ID |
| `PORT` | `3000` | Server port |
| `AGENT_NAME` | `FlowMate Assistant` | How the agent introduces itself |
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

Fully customizable: place a `dashboard.html` in `workspace/dashboard/` to override the built-in default. The file is hot-reloaded on change. The agent can also edit it when asked by the user — each user gets a unique, personalized dashboard.

All responses include an `X-API-Version` header with the current server version.

### Rate limiting

All `POST` requests are rate-limited per auth token. Default: 30 requests per 60 seconds. Returns `429 Too Many Requests` with a `Retry-After` header when exceeded. Configure via `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.

Request body size is limited to 1 MB. Message length is limited to 10,000 characters.

### `GET /health` — Health check

Returns plain text `true` with status 200. Configure in FlowMate as the Health Check URL.

### `GET /jobs` — Jobs polling

Returns `true` if there are completed job results pending delivery, `false` otherwise. Configure in FlowMate as the Polling URL. When FlowMate receives `true`, it sends the configured fetch message to trigger result delivery.

## HTTPS Tunnel

FlowMate requires HTTPS. The built-in tunnel tool auto-detects available tools and creates the tunnel:

```bash
bun run tunnel
```

Supports:
- **Tailscale** — Persistent (no process needed), auto-detects hostname, avoids port conflicts
- **ngrok** — Generates a public URL, fetches it from the ngrok API
- **Cloudflare Tunnel** — Quick tunnel with random URL

The tunnel shows all URLs ready to copy into FlowMate Settings:

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
| macOS | launchd | `~/Library/LaunchAgents/dev.alfonsomenkel.flowmate-agent-server.plist` |
| Linux | systemd (user) | `~/.config/systemd/user/flowmate-agent-server.service` |
| Windows | NSSM | Windows Service Manager |

The service auto-restarts on failure. Logs on macOS go to `~/Library/Logs/flowmate-agent-server/`.

Manage the service:
```bash
bun run service status     # Check if running
bun run service restart    # Apply changes to .env or permissions
bun run service stop       # Temporarily stop
bun run service uninstall  # Remove service and tunnel config
```

## Skills

Skills are `.md` files in `skills/` that describe iOS Shortcuts the agent can trigger. They are hot-reloaded on each request when modified.

```markdown
### New Note

Shortcut name: `New Note`

Creates a new note on the user's device.

Data fields:
- title (string, required): Note title
- content (string, required): Note body

Example:
{ "msg": "Creating your note...", "shortcut": "New Note", "data": { "title": "Shopping List", "content": "1. Milk\n2. Eggs" } }
```

The agent can also create and manage skills when asked by the user. See `skills/_example.md` for the template.

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
- **prompt** — Processed by the AI agent with full tool access, stores the complete FlowMate response (msg + shortcut + data + url)

### Delivery

Shell jobs can optionally trigger an iOS Shortcut on completion via `on_complete_shortcut` and `on_complete_data`. The job output is injected into `data.output`.

Completed results are delivered **instantly without LLM processing** — stored results go directly to the device when it polls.

### Agent tools

The agent has three job management tools: `create_job`, `list_jobs`, `delete_job`.

### Web tools

- **`web_search`** — Search the web via Serper.dev or SearXNG. Returns titles, snippets, and URLs.
- **`web_fetch`** — Fetch any URL and extract clean readable content (via [Jina Reader](https://jina.ai/reader/)). Used to read full articles, product pages, reviews, etc.

## Permissions

Granular tool permissions are stored in `permissions.json` (configure via `bun run permissions` or `bun run setup`):

- **Enabled tools** — `shell`, `read`, `write`, `ls`, `create_job`, `list_jobs`, `delete_job`, `web_search`, `web_fetch`
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

SQLite with FTS5 full-text search for long-term memory (`data/memory.db`):

- **Short-term** — Last N messages kept in memory per session
- **Long-term** — All messages stored in SQLite, searched via FTS5
- Recalled memories are injected into context with timestamps
- Sessions expire after `SESSION_TTL_MINUTES`, but long-term memory persists

## Project structure

```
flowmate-agent-server/
├── src/
│   ├── index.ts          # HTTP server, routing, job delivery
│   ├── config.ts         # Config loading, system prompt, hot-reload
│   ├── dashboard.ts      # Web dashboard HTML and jobs API
│   ├── llm.ts            # Agent execution, LLM communication
│   ├── tools.ts          # Tool implementations (shell, read, write, ls, jobs)
│   ├── versioning.ts     # Workspace git + config backups
│   ├── jobs.ts           # Background job system, cron scheduler
│   ├── logger.ts         # Structured logging with level filtering
│   ├── rate-limit.ts     # Per-token rate limiting
│   ├── permissions.ts    # Permission enforcement
│   ├── sessions.ts       # Session management, memory context
│   ├── memory.ts         # SQLite + FTS5 long-term memory
│   ├── setup.ts          # Interactive CLI setup
│   ├── service.ts        # System service management
│   ├── tunnel.ts         # HTTPS tunnel setup
│   └── dev-tunnel.ts     # Combined dev server + tunnel
├── skills/               # Hot-reloadable shortcut definitions
├── data/                 # Runtime data (SQLite, service metadata, backups)
├── workspace/            # Agent's working directory
│   └── dashboard/        # Custom dashboard files (hot-reloaded)
├── agent-instructions.md # Editable agent behavior (hot-reloaded)
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

## Acknowledgments

- **[pi-mono](https://github.com/badlogic/pi-mono)** — The agent framework and multi-provider LLM abstraction (`pi-agent-core` and `pi-ai`) that power this server. Without their work, this project wouldn't be possible.
- **[OpenClaw](https://github.com/openclaw/openclaw)** — The inspiration behind creating this server. OpenClaw pioneered the concept of connecting LLMs with iOS Shortcuts, and this project builds on that vision with a different architecture.

## License

MIT
