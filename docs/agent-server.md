---
title: "Agent Server"
description: "Self-hosted AI agent server for PocketHook — connect any LLM to iOS Shortcuts with tool-calling, semantic memory, knowledge graph, dynamic skills, and background jobs."
---
## What is PocketHook Agent Server?

The agent server turns PocketHook into a full AI assistant. Instead of writing response logic yourself, you connect an LLM (Claude, GPT, Gemini, etc.) that processes messages, calls tools, and returns structured PocketHook responses — including Shortcut triggers.

The server runs on your own machine. Your data stays with you.

> **This is a starting point.** The server ships with a core set of tools and is designed to be extended by you. Add your own integrations — email, calendars, documents, APIs — and make it yours.

## Features

- **Multi-provider LLM** — Anthropic, OpenAI, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter, Ollama (local), LM Studio (local)
- **OAuth authentication** — GitHub Copilot and OpenAI Codex via device code / browser flow
- **Agent tools** — Shell commands, file read/write, directory listing, web search, web scraping, dev server management
- **Background jobs** — One-time or recurring tasks with cron expressions or simple intervals
- **Dynamic skills** — Define shortcuts and behavior rules as `.md` files. Only a compact index is loaded into the prompt; full content is fetched on demand via the `load_skill` tool
- **Self-managing skills** — The agent can create, edit, and delete skill definitions
- **Semantic memory** — Vector-based search with embeddings (Ollama, LM Studio, or OpenAI). Memories are auto-classified into wing/room/hall/status dimensions by the LLM
- **Knowledge graph** — Temporal triple store for durable facts with auto-invalidation. Multi-value relationships coexist; single-value facts auto-replace
- **PARA method** — Every memory is tagged with a status (Project, Area, Resource, Archive). Projects are closed with semantic similarity matching; reference material survives project closures
- **Hybrid recall** — Combines FTS5 keyword search with vector semantic search using reciprocal rank fusion
- **Long-term memory** — SQLite + FTS5 full-text search as fallback when semantic memory is disabled
- **Dev server management** — Start, stop, and list dev servers with optional HTTPS tunnel exposure
- **Custom tools** — The agent can install CLI tools and register them as new capabilities
- **Versioning** — Automatic git versioning for workspace files; config backups for skills and permissions
- **Web dashboard** — Live overview of background jobs, customizable per user
- **HTTPS tunneling** — Built-in support for Tailscale, ngrok, and Cloudflare Tunnel
- **System service** — Install as a persistent service on macOS, Linux, or Windows
- **Rate limiting** — Per-token request limits with configurable thresholds

## Requirements

- [Bun](https://bun.sh) runtime
- An API key or OAuth credentials for your LLM provider
- (Optional) [Tailscale](https://tailscale.com), [ngrok](https://ngrok.com), or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for HTTPS tunneling

## Quick Start

```bash
git clone https://github.com/pockethook-app/pockethook-agent-server.git
cd pockethook-agent-server
bun install

# Interactive setup — choose provider, model, auth token, port
bun run setup

# Start server + HTTPS tunnel
bun run dev:tunnel
```

The setup wizard will guide you through choosing an LLM provider, configuring authentication, and setting up tool permissions.

Once running, copy the displayed URLs into PocketHook Settings:

| PocketHook Setting | URL |
|-------------------|-----|
| Server URL | `https://your-host` |
| Health Check URL | `https://your-host/health` |
| Polling URL | `https://your-host/jobs` |

## How It Works

1. You send a message in PocketHook
2. The server forwards it to your chosen LLM with conversation history, recalled memories, and available tools
3. The LLM processes the message — it can run shell commands, read/write files, search the web, schedule background jobs, remember facts, or start dev servers
4. The response is returned in PocketHook format (`msg` + `shortcut` + `data` + `url`)
5. PocketHook displays the message and executes any Shortcuts on your device

## Supported LLM Providers

| Provider | Auth | Default Model |
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

Switch providers anytime with `bun run switch`. Ollama and LM Studio run entirely on your machine — no API key needed, no data leaves your network.

## Memory

The memory system has three layers, each serving a different purpose.

> The semantic memory design combines ideas from [MemPalace](https://github.com/milla-jovovich/mempalace) (a memory palace architecture that organizes memories into wings, halls, and rooms) and Tiago Forte's [PARA method](https://fortelabs.com/blog/para/) (Projects, Areas, Resources, Archive) for knowledge lifecycle management.

### Conversation memory

SQLite with FTS5 full-text search. All messages are stored with timestamps and session IDs.

- **Short-term** — Last N messages kept in memory per session (configurable via `MAX_HISTORY`)
- **Long-term** — All messages persisted in SQLite, searchable via FTS5 keyword matching
- Sessions expire after `SESSION_TTL_MINUTES`, but long-term memory persists forever

### Semantic memory

Requires `VECTOR_MEMORY=true` and an embedding provider (Ollama, LM Studio, or OpenAI).

Each memory is embedded as a vector and auto-classified by the LLM into four dimensions:

- **Wing** — The entity: `user`, `person:john`, `project:blog`, `place:london`
- **Room** — The type: `facts`, `preferences`, `events`, `decisions`, `requests`
- **Hall** — The topic: `personal`, `tech`, `health`, `travel`, `food`, `work`
- **Status** — PARA classification: `project`, `area`, `resource`, `archive`

When you ask a question, entity extraction focuses the vector search on the most relevant wings. Results are merged with FTS5 keyword results using **reciprocal rank fusion** — so you get the best of both keyword and semantic matching.

### Knowledge graph

A temporal triple store for structured, durable facts:

- Triples: `(subject, predicate, object)` with `valid_from` / `valid_until` timestamps
- **Single-value** predicates (`lives_in`, `partner`) auto-invalidate the old value on update
- **Multi-value** predicates (`child`, `friend`, `hobby`) coexist without invalidation
- Knowledge graph facts are injected alongside recalled memories in every conversation

When you tell the agent *"I moved to Berlin"*, it invalidates the old `lives_in` triple and creates a new one — automatically.

### PARA lifecycle

Every memory is tagged with a PARA status:

- **Project** — Active, time-bound work
- **Area** — Ongoing responsibilities
- **Resource** — Reference material (lists, recommendations, how-tos)
- **Archive** — Completed or cancelled projects

When a project completes, the agent uses semantic similarity to archive only that project's memories while preserving reference material for future use.

If `VECTOR_MEMORY` is disabled or the embedding provider is unreachable, the system falls back to FTS5-only with no errors.

## Skills

Skills are `.md` files in `skills/` that define iOS Shortcuts the agent can trigger and/or behavior rules. They use **dynamic loading**: only a compact index (title, description, shortcut list) is injected into the system prompt. The agent loads full content on demand via the `load_skill` tool, keeping token usage low as you add more skills.

Each skill file uses YAML frontmatter:

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
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Human-readable name |
| `description` | Yes | One sentence used in the skills index shown to the agent |
| `shortcuts` | Yes | Array of shortcut names defined in the file. Use `[]` for behavior-only skills |
| `target` | No | Where shortcuts execute: `device` (default, sent to iOS) or `mac` (run on the server) |
| `sync_app` | No | App to nudge in the background after server-side execution to trigger iCloud sync (e.g. `Notes`, `Calendar`, `Reminders`). Omit or use `none` to skip |

Skills can also be **behavior rules** without shortcuts (e.g., "how to plan a family trip"). Use `shortcuts: []` for these.

The agent can create and manage skills when asked — ask it to *"create a skill for controlling my lights"* and it will write the `.md` file for you.

### Executing shortcuts on the Mac server

When a skill has `target: mac`, shortcuts run **silently on the Mac server** via the `shortcuts run` CLI instead of being sent to the iOS device. This is ideal for actions that create iCloud-synced content — notes, reminders, calendar events — because the result syncs to all your devices automatically without needing the PocketHook app to do anything.

How it works:

1. The agent decides a shortcut should run (e.g. "create a note with today's meeting notes")
2. The server invokes `shortcuts run "shortcutName"` with the data passed as JSON on stdin, using the same wrapper format PocketHook iOS uses
3. If `sync_app` is set, the server briefly opens that app in the background (`open -gj -a Notes`) to force iCloud sync, then closes it after 5 seconds
4. The user receives a confirmation message in the chat; the shortcut itself is not sent to the device

**Requirements:**

- The server must be running on **macOS** — `shortcuts run` is macOS-only. On other platforms, the server logs a warning and falls back to device execution
- The shortcut must be installed in Shortcuts.app on the server Mac
- The shortcut should expect a Dictionary as input (PocketHook wraps data in `{ context, timestamp, app, data }`)

**When to use `target: mac`:**

- iCloud-synced actions (Notes, Reminders, Calendar) — the result reaches every device anyway
- Long-running processing you want to keep off the iOS device
- Any shortcut that doesn't need to interact with the iPhone's UI

**When to keep `target: device` (default):**

- Shortcuts that need iPhone-only features (camera, precise location, local app automations)
- Shortcuts that prompt the user for interactive input
- Shortcuts that use App Intents from iOS-only apps

## Background Jobs

Ask the agent to schedule tasks and it will handle the rest:

- *"Check the weather every morning at 8am and create a note"*
- *"Run this script every hour"*
- *"Remind me to check my email in 30 minutes"*

Jobs support cron expressions (`0 8 * * *`) and simple intervals (`30m`, `1h`, `2d`). Results are delivered to PocketHook when it polls the `/jobs` endpoint.

Two execution types:
- **Shell** — Runs a bash command, captures output. Can trigger a Shortcut on completion
- **Prompt** — Processed by the AI agent with full tool access, stores the complete PocketHook response

## Dev Servers

When the agent creates a web project in the workspace (Hugo, Astro, Next.js, Flask, Go, etc.), it proactively offers to serve it:

- **Preview** — Starts a local dev server on an auto-assigned port for quick viewing
- **Public** — Starts the server and exposes it via HTTPS tunnel so it's accessible from anywhere

The agent manages the lifecycle: start, stop, and list running servers. All servers are cleaned up when the main server stops.

## Dashboard

The built-in web dashboard at `/dashboard` shows a live overview of background jobs. It's fully customizable:

- **Quick edit** — Place a `dashboard.html` in `workspace/dashboard/` for simple customizations
- **Full project** — Create a framework project (Svelte, React, Vue, etc.) in `workspace/dashboard/` with build output to `dist/`

Ask the agent to customize your dashboard and it will handle the rest — each user gets a unique, personalized dashboard.

## Custom Tools

The agent can install CLI tools and register them as new capabilities — extending itself without modifying the server code.

For example, say *"install Playwright and use it to take screenshots"*. The agent will:
1. Install the dependency
2. Create a tool definition (a simple `.md` file)
3. Use the new tool in future conversations

Custom tools are hot-reloaded — no restart needed. Delete the `.md` file to remove a tool.

## Versioning

All user data is versioned automatically:

- **Workspace files** — Tracked with a local git repo inside `workspace/`. Every write creates an auto-commit. Ask the agent to *"undo the last change"* or use `git revert HEAD` manually
- **Config files** — `agent-instructions.md`, `skills/`, and `permissions.json` are backed up before each modification. Up to 20 versions per file

Git is optional — if not installed, workspace changes are unversioned. Config backups always work.

## Extending the Server

- **Custom tools** — Ask the agent to install CLI tools and it registers them automatically
- **Add skills** — Drop `.md` files in `skills/` to teach the agent new Shortcuts
- **Change behavior** — Edit `agent-instructions.md` to adjust the agent's methodology and style
- **Configure permissions** — Run `bun run permissions` to control which tools the agent can use
- **Add built-in tools** — Implement new tool functions in `src/tools.ts` for deeper integrations

## Configuration

All settings are stored in `.env` (created by `bun run setup`). Key options:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | (required) | Shared secret with PocketHook |
| `LLM_API_KEY` | (required) | LLM provider API key |
| `LLM_PROVIDER` | `anthropic` | Provider name |
| `LLM_MODEL` | `claude-sonnet-4-20250514` | Model ID |
| `PORT` | `3000` | Server port |
| `AGENT_NAME` | `PocketHook Assistant` | Agent display name |
| `MAX_HISTORY` | `50` | Messages in short-term memory |
| `SESSION_TTL_MINUTES` | `60` | Session expiration |
| `VECTOR_MEMORY` | `false` | Enable semantic memory (requires an embedding provider) |
| `EMBEDDING_PROVIDER` | `ollama` | Embedding provider: `ollama`, `lm-studio`, or `openai` |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model name |
| `EMBEDDING_URL` | (auto) | Embedding API URL |
| `EMBEDDING_API_KEY` | — | API key for OpenAI embeddings |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `RATE_LIMIT_MAX` | `30` | Max requests per window |

See the full configuration reference in the [GitHub repository](https://github.com/pockethook-app/pockethook-agent-server).

## Running as a Service

Install as a persistent service that starts automatically:

```bash
bun run service install
```

| Platform | Backend |
|----------|---------|
| macOS | launchd |
| Linux | systemd |
| Windows | NSSM |

Manage with `bun run service status`, `restart`, `stop`, or `uninstall`.

## Security

- **HTTPS required** — PocketHook enforces HTTPS for all URLs
- **Bearer token auth** — Shared secret between app and server
- **Rate limiting** — Per-token limits prevent abuse
- **Sandboxed tools** — Shell commands and file access restricted by permissions
- **Blocked patterns** — Dangerous commands (`sudo`, `rm -rf /`) blocked by default
- **Working directory boundary** — Agent can't escape its designated directory
- **Sensitive files protected** — `.env`, `.git`, `*.key`, `*.pem` blocked from agent access
- **Automatic versioning** — All workspace changes are git-tracked for easy rollback
