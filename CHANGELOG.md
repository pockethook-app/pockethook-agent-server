# Changelog

## 0.8.0 — release candidate for PocketHook 1.4

### Features

- Connect PocketHook 1.4 using an expiring, single-use QR invitation. Authenticated creation and bounded redemption endpoints work on every supported server platform.
- `bun run app:qr` on macOS detects an existing Tailscale HTTPS route for this instance and its configured agent name. Non-default HTTPS ports and multiple instances are supported; explicit URLs remain available for other tunnel providers.
- Display the QR directly in the terminal and save a restricted temporary PNG. `--open` opens the image; narrow terminals receive the file path rather than an unreadable wrapped code.
- Import the chat endpoint, credentials, health check, pending jobs and optional Personal UI into the selected app profile. QR invitations expire after five minutes, and regeneration or a server restart invalidates them.

### Compatibility

- Pairing grants the existing server owner's access; this release does not add multi-user permissions. The QR never contains the permanent server token.
- Retains 0.7.0 result acknowledgements, durable shares, authenticated attachments, timeouts and per-instance service names. PocketHook 1.3 clients remain supported; QR profile setup requires 1.4.
- SDK 0.1.3, pinned pi packages 0.85.0, Apple Bridge 0.6.0 and Safari companion 1.0 are unchanged.

## 0.7.0 — 2026-09-12

### Features

- Durable App Intent and Share Extension jobs with request-ID deduplication, status queries, restart recovery and explicit result acknowledgements. Stable delivery/message IDs preserve results across network loss and recurring job runs.
- Image and document uploads, vision input and PDF/text extraction. Upload downloads require Bearer authentication; expiry defaults to 30 days and upload size to 25 MiB.
- Apple Bridge installation, pairing, status and capability-gated tools; signed/notarized 0.6.0 bundle. Safari installer and existing notarized companion bundle.
- Response deep links and device-local photo query instructions. SDK 0.1.3.

### Fixes and compatibility

- Empty result collection returns false without invoking a model. Accepted shares are stored before returning 202. Interrupted intent/share jobs do not repeat side effects automatically.
- Provider switching, model catalog supplementation, streaming error recovery and cancellation of timed subprocesses. Pin pi-ai and pi-agent-core to 0.85.0.
- Preserve public per-instance service/log naming, installation overwrite protection and device-targeted note template.
- Existing clients keep the legacy fetch behavior; reliable acknowledgements require the new capability/header. See docs/release-1-3.md for protocol, retention and migration details.

## 0.6.0 — 2026-08-14

### Features

- **Safari extension support (`safari` tool)** — Control a paired PocketHook Safari Web Extension: open/navigate/close tabs, inspect pages (up to 120 visible controls with stable locators, semantic attributes and state), `find_text` across labels AND identifying attributes with ranked multi-match results, click with a full synthetic pointer/mouse event sequence (React-compatible) and post-click `state_changed` verification, React-safe `fill`, scrolling, and screenshots served as URLs the app renders inline. Commands are delivered exclusively through a native-messaging poll queue (a WebSocket acts only as a wake-up nudge — sockets can zombie after Safari suspends the extension); queued commands expire after 20s so nothing executes late. Pairing uses one-time codes (5 min TTL) and per-installation credentials persisted in `data/safari-extension.json`.
- **Configurable Safari permission level** — `SAFARI_PERMISSION_LEVEL`: `confirm` (default — clicks with external effects require explicit user confirmation), `autonomous` (votes/follows/submits run without asking; payments, permanent deletions and account/security changes still ask), `readonly` (navigate, inspect and capture only). Enforced in the tool itself, and the tool description the model sees adapts to the level.
- **New commands** — `bun run help` (grouped overview of every command, flags undocumented scripts automatically), `bun run config` (current configuration at a glance, secrets masked, defaults shown for unset vars), `bun run safari:config` (optional, skippable: permission level + captures base URL), `bun run safari:code` (one-time pairing code + popup endpoint), `bun run safari:status` (paired installations and live connection state).
- **Quick model** — `LLM_QUICK_PROVIDER/MODEL/API_KEY/BASE_URL/REASONING`: a lightweight secondary model for internal helpers (message classification, memory entity extraction). Defaults to the main model with reasoning off; shares credentials (including OAuth refresh) when the provider matches. Configurable in `setup`/`switch`.
- **`max` reasoning level** — added to `REASONING_VALUES`, the setup selector, and the `set_reasoning` tool.

### Fixes & robustness

- **pi 0.57.1 → @earendil-works 0.80.10** — migrated to the `@earendil-works/pi-ai` / `pi-agent-core` scope (supports GPT 5.6-class models). `Provider` type → `ProviderId`; `getModel/getModels` from `pi-ai/compat`; OAuth login/refresh rewritten to the new `OAuthAuth` API.
- **Stream-error retries** — `chat()` retries up to 2× with a fresh Agent when the provider fails mid-stream and no tools have run (side-effect safety); `quickPrompt` retries 1×; pi's swallowed stream errors (`agent.state.errorMessage`) are now logged.
- **Interrupted-turn handling** — if a stream dies after tools already ran, the turn is resumed with a steering prompt (tools allowed, 2 attempts with backoff) instead of being forced to answer without tools (which used to drop pending work). If it still fails, jobs are marked failed and requeued by the existing retry mechanism.

## 0.5.0 — 2026-06-10

### Features

- **`set_reasoning` tool — change the reasoning level from chat** — The agent can switch the model's reasoning (thinking) level at runtime when asked in natural language ("think harder about this", "back to fast mode"). Updates `config.llmReasoning` live — each turn builds its Agent from live config, so the change applies from the next message onward — and persists the choice to `.env`. Levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Registered in `permissions.json` and documented in the agent instructions; has no effect on models without reasoning support.

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
