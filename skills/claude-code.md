### Claude Code — Programming Tool

This skill is NOT an iOS shortcut. It is an instruction for the agent to use Claude Code CLI (`claude`) as a programming tool inside background jobs.

When you need to perform a complex programming task (creating projects, refactoring, reviewing large codebases, etc.), delegate the work to Claude Code by running it as a shell job with a long timeout.

---

**How to use:**

Create a SINGLE job `type: "once"`, `execution_type: "shell"` with `timeout: "30m"` (or more for very heavy tasks). The job runs `claude --print` directly, captures the output, and delivers it to the user when finished. No tmux, no polling, no complications.

```
create_job({
  name: "Task description",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /path/to/project && claude --print --dangerously-skip-permissions \"Your prompt here. IMPORTANT: Always use non-interactive flags in all CLI commands.\""
})
```

The result is automatically delivered to the user via PocketHook polling when the job finishes.

---

**Claude Code CLI flags:**
- `--print` (`-p`): Non-interactive mode. Runs the prompt and exits.
- `--dangerously-skip-permissions`: Allows writing files and running commands without confirmation. Required for tasks that modify the filesystem.
- `--model`: Specify model.
- `--max-turns`: Limit tool turns.

**IMPORTANT — Non-interactive commands:**
Claude Code runs without an interactive terminal. The prompt you pass MUST instruct it to always use non-interactive flags in any CLI tool it runs. For example:
- `npx sv create` → NO (interactive, hangs). Use `npx sv create my-app --template minimal --no-install` or equivalent with `--yes`/`-y`.
- `npm init` → NO. Use `npm init -y`.
- `npx create-next-app` → Pass all flags: `--yes --ts --app --src-dir --eslint`.
- Any CLI that prompts for options → look for its `--yes`, `--no-interactive`, `--defaults` flag or similar.

Always include in the Claude Code prompt: **"IMPORTANT: Always use non-interactive flags (--yes, -y, --defaults, --no-interactive) in all CLI commands. You cannot respond to interactive prompts."**

**Timeout:** Use `timeout: "30m"` for normal tasks, `timeout: "1h"` for large projects. The default without timeout is 60s (insufficient for Claude Code).

**When to use Claude Code vs the agent itself:**
- **Claude Code** (this skill): heavy programming tasks — creating projects, refactoring, complex debugging. Has better code context, LSP, advanced grep, precise editing.
- **Agent itself** (`execution_type: "prompt"`): lightweight tasks that only read a few files, or that need PocketHook tools (respond, start_server, etc.).

---

**Example — create project:**
```
create_job({
  name: "Create API with Hono",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /Volumes/Ext/dev/workspace && claude --print --dangerously-skip-permissions \"Create a hono-api project with Bun and Hono. Routes GET /health and POST /echo. Install deps and verify it compiles. IMPORTANT: Always use non-interactive flags in all CLI commands.\""
})
```

**Example — review project:**
```
create_job({
  name: "Review blog",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /Volumes/Ext/dev/workspace/blog && claude --print \"Review this project: structure, quality, improvements and errors. Concise report.\""
})
```
