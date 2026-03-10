# Changelog

## 0.1.0 — 2026-03-10

Initial release.

### Features

- Multi-provider LLM support via `@mariozechner/pi-ai` (Anthropic, OpenAI, OpenAI Codex, GitHub Copilot, Google, Mistral, Groq, xAI, OpenRouter)
- OAuth authentication for GitHub Copilot and OpenAI Codex with auto-refresh
- Agent tools: shell, read, write, ls
- FlowMate protocol integration via `@flow-mate/sdk`
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
