# Changelog

## 0.3.0 — 2026-04-14

### Features

- **Server-side shortcut execution** — Run shortcuts on the Mac server via `shortcuts run` CLI instead of sending them to the iOS device. Configure with `target: mac` in skill frontmatter. Ideal for iCloud-synced actions (notes, calendar, reminders)
- **iCloud sync nudge** — New `sync_app` frontmatter field opens the related app in the background after server-side execution to trigger iCloud sync, then auto-closes it
- **User onboarding** — New `USER_NAME` and `ONBOARDING_CHAT` env vars. The agent can greet the user by name and offer a brief onboarding chat to learn personal preferences
- **Respond tool `run_on` field** — Steps can specify `run_on: "server"` or `"device"` to control where shortcuts execute

## 0.2.2 — 2026-03-30

### Features

- LM Studio support — run local LLMs via LM Studio with no API key needed (`LLM_BASE_URL` defaults to `http://localhost:1234/v1`)

## 0.2.1 — 2026-03-22

### Rename

- Renamed project from FlowMate to PocketHook across the entire codebase.

## 0.2.0 — 2026-03-11

Pre-launch hardening.

### Features

- Rate limiting — configurable per-token limits (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`)
- Request size limit (1 MB) and message length limit (10,000 chars)
- Structured logging with configurable level (`LOG_LEVEL`) and JSON output in production
- API version header (`X-API-Version`) on all responses
- Retry mechanism for failed one-time jobs (max 2 retries with exponential backoff)
- User locale auto-detection for location-aware searches (`LOCALE_COUNTRY`, `LOCALE_CITY`, `LOCALE_TIMEZONE`)
- GitHub Actions CI workflow (tests + type checking on push/PR to main)
- Unit tests for permissions, jobs, rate limiting, and configuration
- Ollama support — run local LLMs with no API key, no data leaves your network (`LLM_BASE_URL`)

### Fixes

- Improved shell command validation with stricter pattern matching
- Added 30s timeout to web_fetch (Jina Reader) to prevent hanging requests
- Fixed empty catch blocks — all exceptions now logged with structured logger

## 0.1.0 — 2026-03-10

Initial release.

### Features

- Multi-provider LLM support via `@mariozechner/pi-ai` (Anthropic, OpenAI, OpenAI Codex, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter)
- OAuth authentication for GitHub Copilot and OpenAI Codex with auto-refresh
- Agent tools: shell, read, write, ls
- PocketHook protocol integration via `@pockethook/sdk`
- Hot-reloadable skill definitions from `skills/` directory
- Self-managing skills — the agent can create, edit, and delete skill files
- Long-term memory with SQLite + FTS5 full-text search
- Short-term session management with configurable history limit
- Contextual memory recall with conversation-enriched search
- Interactive setup CLI (`bun run setup`)
- Quick provider switch (`bun run switch`)
- OAuth token refresh (`bun run refresh`)
- Configurable agent name, tools, working directory, and session TTL
- Health check endpoint (`GET /health`)
