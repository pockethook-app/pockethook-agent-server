# flowmate-agent-server

AI agent server for [FlowMate](https://github.com/AlfonsoMenworworkel/FlowMate) — connects any LLM provider to iOS Shortcuts via the FlowMate protocol.

The server receives messages from FlowMate, processes them through an LLM with tool-calling capabilities, and returns structured responses that FlowMate executes as iOS Shortcuts.

## Features

- **Multi-provider LLM support** — Anthropic, OpenAI, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter
- **OAuth authentication** — GitHub Copilot and OpenAI Codex via device code / browser flow
- **Agent tools** — Shell, file read/write, directory listing
- **Hot-reloadable skills** — Define shortcuts as `.md` files in `skills/`, no restart needed
- **Self-managing skills** — The agent can create, edit, and delete skill definitions
- **Long-term memory** — SQLite + FTS5 full-text search for context recall across sessions
- **Configurable agent name** — Customize how the assistant introduces itself
- **FlowMate protocol** — Standard `msg`/`shortcut`/`data`/`url` response format via `@flow-mate/sdk`

## Requirements

- [Bun](https://bun.sh) runtime
- A FlowMate app instance configured to point to this server
- An API key or OAuth credentials for your chosen LLM provider

## Quick start

```bash
# Install dependencies
bun install

# Interactive setup (provider, model, auth, port)
bun run setup

# Start the server
bun run start

# Or with hot-reload for development
bun run dev
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run setup` | Full interactive setup (first time) |
| `bun run switch` | Change LLM provider/model without full setup |
| `bun run refresh` | Refresh OAuth token (Codex / Copilot) |
| `bun run start` | Start the server |
| `bun run dev` | Start with hot-reload |

## Configuration

All configuration is stored in `.env` (created by `bun run setup`). See `.env.example` for all options.

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

### Agent tools

Control which tools the agent has access to via `TOOLS` in `.env`:

- `all` — Shell, read, write, ls (default)
- `readonly` — Read and ls only
- `shell,read` — Comma-separated list of specific tools

### Working directory

Set `WORKING_DIR` to restrict the agent's file access to a specific directory.

## Skills

Skills are `.md` files in the `skills/` directory that describe iOS Shortcuts the agent can trigger. They are hot-reloaded on each request when modified.

See `skills/_example.md` for the template format.

Example skill (`skills/notes.md`):
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

The agent can also create and manage skills itself when asked by the user.

## Memory

The server uses SQLite with FTS5 full-text search for long-term memory. Messages are stored persistently in `data/memory.db` and recalled when relevant to the current conversation.

- Short-term: Last N messages kept in memory per session
- Long-term: All messages stored in SQLite, searched via FTS5
- Recalled memories are injected into context with timestamps

## API

### `POST /`

Send a message to the agent. Requires `Authorization: Bearer <token>`.

**Request:**
```json
[{"sessionId": "uuid", "action": "sendMessage", "chatInput": "your message"}]
```

**Response:**
```json
[{"msg": "response text", "shortcut": "ShortcutName", "data": {"key": "value"}, "url": "https://..."}]
```

### `GET /health`

Health check endpoint. Returns `true` with status 200.

## License

MIT
