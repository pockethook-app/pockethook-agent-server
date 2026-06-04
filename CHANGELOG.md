# Changelog

## 0.4.1 — 2026-06-04

### Fixes

- **Background jobs no longer block the HTTP server** — `commitWorkspace` (the auto-versioning run after every `write` / `shell` tool call) executed git synchronously via `execSync`, freezing the Bun event loop for the full duration of each commit. While a `prompt` job churned the workspace, `/health`, `/jobs`, and chat requests all stalled — the iOS app appeared unable to connect until the job finished. Git now runs in a child process (`spawn`) with commits queued serially, so the event loop stays free. The commit message is passed as an argv element (no shell escaping).
- **Workspace `.gitignore`** — `initWorkspaceGit` now writes a default `.gitignore` into the workspace repo when missing, so `node_modules/`, build output (`dist/`, `build/`, `.next/`, …), virtualenvs, logs and local env files are never versioned. Keeps auto-commits tiny and fast instead of staging thousands of dependency files on every change.

## 0.4.0 — 2026-04-15

### Breaking / behavior changes

- **User customization overlay** — Framework files (`skills/`, `custom-tools/`, `agent-instructions.md`) are now read-only for the agent. Per-deployment customization lives under `data/user/` (`skills/`, `custom-tools/`, `instructions.md`, `prefs.json`). The runtime scans both layers and the user layer wins on filename / tool-name collision. The `write` tool rejects any path into the base and redirects the agent to `data/user/*`. Framework updates land cleanly without overwriting user data
- **`complete_project` cascade** — Added optional `project_slug` and `reason` (`"cancelled"` | `"completed"`). When provided, the handler invalidates every active triple whose predicate is the slug exactly or ends in `_<slug>` (e.g., `scheduled_visit_barcelona`, `planning_visit_barcelona`) and records a single completion triple — one call replaces the old three-step pattern (`complete_project` → `remember_fact` → `respond`). Matching is boundary-aware: `visit_barcelona` does NOT invalidate `revisit_barcelona`
- **System prompt adelgazado** — `buildBaseSystemPrompt` reduced from ~400 to ~100 lines. Long procedural sections moved to loadable docs under `docs/` (content rendering, skills format, custom tools format, dashboard, serving projects, memory guide). `agent-instructions.md` rewritten to cover only universal rules; Hugo-specific rules removed (the underlying intent is now covered by the `start_server` tunnel contract and the `respond` URL sanitizer)

### Features

- **`run_code_job` meta-tool** — A single call creates a Claude Code background job AND sends the user the ack message. Internally composes the `claude -p --dangerously-skip-permissions` invocation, picks a sensible default timeout, escapes the task prompt, and emits `respond` through the same channel used by the `respond` tool. Replaces the error-prone respond-then-create_job pattern for programming tasks
- **`respond` URL sanitizer** — Post-processes every `msg` and `url` field, rewrites `localhost` / `127.0.0.1` URLs to the tunnel URL when a managed server has one, and logs a warning when it can't — so the iOS device never receives a link it can't reach. If the agent leaves a rewritten URL in `msg` with no `url` set, the first rewritten URL is surfaced on the `url` field so it renders as a clickable link
- **`start_server` tunnel contract** — `tunnel: true` is now enforced pre-flight: if no tunnel tool is installed (Tailscale / ngrok / cloudflared), the tool refuses to start. If tunnel setup fails after spawn, the orphan server is stopped and the agent receives a clear error. When tunnel is up, the tunnel URL is returned as the primary URL with an explicit note that the local URL is host-only
- **Typed user prefs** — `data/user/prefs.json` holds arbitrary JSON values (scalars, nested objects). Skills reference keys as `{{prefs.routeOrigin}}` or `{{prefs.tunnel.domain}}`; the server substitutes them when the skill is loaded. Unknown keys are left untouched so typos stay visible
- **User instructions** — `data/user/instructions.md` is concatenated into the system prompt after `agent-instructions.md`. Global rules the user wants always applied ("always respond in English", "never use tables") live here and survive framework updates
- **`invalidateTriplesByProjectSlug` primitive** — New helper in `knowledge-graph.ts` does safe boundary-matching (exact or `_slug` suffix) instead of substring matching

### Docs

- New loadable guides under `docs/`: `content-rendering.md`, `skills-format.md`, `custom-tools-format.md`, `dashboard.md`, `serving-projects.md`, `memory-guide.md`
- Skills index now loads from both `skills/` and `data/user/skills/`
- `skills/_example-route-planner.md` added as a neutral template showing how to reference `{{prefs.*}}`

### Tests

- `tests/knowledge-graph.test.ts` — covers slug cascade invalidation, exact-match, suffix-match, boundary safety, subject filter, empty-slug no-op
- `tests/user-customization.test.ts` — covers `{{prefs.*}}` top-level and nested substitution, unknown-key pass-through, and system-prompt references to the user layer

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
