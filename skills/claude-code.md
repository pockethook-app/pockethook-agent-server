### Claude Code

Shortcut name: `claudeRemote`

Guidance for using Claude Code from PocketHook, covering both non-interactive jobs and interactive Remote Control sessions.

## 1) Non-interactive Claude jobs

Use Claude Code CLI for programming and code analysis tasks inside background jobs.

Preferred command:
- `claude -p "your prompt"`

Equivalent long form:
- `claude --print "your prompt"`

Recommended for jobs that modify files:
- `claude -p --dangerously-skip-permissions "your prompt"`

Important behavior:
- `-p` / `--print` is the correct non-interactive mode for one-shot jobs.
- `-p` exits after answering, so it fits PocketHook jobs well.
- `-p` skips the workspace trust dialog, so only use it in directories you trust.
- Always instruct Claude to use non-interactive flags in downstream CLI commands (`--yes`, `-y`, `--defaults`, `--no-interactive`) because jobs cannot answer prompts.
- Use `timeout: "30m"` for normal programming tasks and `timeout: "1h"` for larger ones.
- Prefer a single shell job that runs `claude -p ...` directly.

Recommended job pattern:
```js
create_job({
  name: "Task description",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /path/to/project && claude -p --dangerously-skip-permissions \"Your prompt here. IMPORTANT: Always use non-interactive flags (--yes, -y, --defaults, --no-interactive) in all CLI commands. You cannot respond to interactive prompts.\""
})
```

When to use this mode:
- Create projects
- Review code
- Refactor or debug
- Run build/test/fix workflows
- Any long programming task that should complete in background and return a final result

Common reasons jobs may fail or appear not to run as expected:
- The `claude` binary is not on the job runner PATH. Use the full path if needed.
- The command launched an interactive tool that waited for input.
- The default timeout was too short.
- Workspace trust or permissions blocked the operation.
- Authentication is missing or expired.
- The job finished, but delivery depends on PocketHook polling and a later fetch.

Practical debugging tips for jobs:
- Prefer explicit `cd /absolute/path && claude ...`.
- If PATH is unreliable in jobs, use the absolute binary path.
- Add `--debug-file /tmp/claude-job.log` when diagnosing failures.
- Keep the command fully non-interactive.
- Use `claude auth status --text` separately if authentication is suspected.

## 2) Workspace trust

Before starting an interactive Claude session in a folder, trust it first.

Useful command:
- `claude --trust-workspace`

Notes:
- Remote Control documentation says to run `claude` in the directory at least once to accept workspace trust.
- In automation, `claude --trust-workspace` is a clearer explicit step when you need to trust a folder before interactive use.
- For print mode, Claude notes that the trust dialog is skipped, so only run `-p` in directories you already trust.

## 3) Remote Control

Remote Control starts with:
- `claude remote-control`

Purpose:
- Keep a Claude session running locally and control it from claude.ai/code or the Claude mobile app.

Important behavior:
- `claude remote-control` is a persistent local server process.
- The terminal or host process must stay alive, otherwise the remote session ends.
- It is different from `claude -p`, which is one-shot and exits immediately.
- Remote Control requires Claude.ai login with a supported subscription.
- Remote Control docs say you should trust the workspace first.

## 4) Should tmux be used?

Recommendation:
- **Yes for Remote Control.** tmux is useful to keep `claude remote-control` alive after the launching client disconnects.
- **No for one-shot jobs.** tmux adds unnecessary complexity for `claude -p` background jobs.

Why tmux helps Remote Control:
- Remote Control is a long-lived process.
- The docs explicitly say the terminal must stay open.
- tmux provides a durable terminal session on the machine.

Why tmux is not needed for jobs:
- PocketHook jobs already run in background and capture output.
- `claude -p` is designed to run and exit.
- Adding tmux makes output capture and failure diagnosis harder.

## 5) PocketHook shortcut for Remote Control

Use this shortcut when the user wants an interactive remote Claude session.

Data fields:
- action (string, required): Action to execute. Use `start`.
- directory (string, optional): Working directory for the session.
- message (string, optional): Optional label or context.

Recommended shell behavior behind the shortcut:
1. Ensure the target directory is trusted, for example with `claude --trust-workspace`.
2. If a tmux session `claude-remote` already exists, stop it.
3. Start a new tmux session that runs `claude remote-control` in the target directory.

Recommended commands:
```bash
tmux kill-session -t claude-remote || true
tmux new-session -d -s claude-remote 'cd <DIRECTORY> && claude --trust-workspace && claude remote-control'
```

Default directory:
- `/Volumes/Ext/dev/pockethook-main/pockethook-agent-server/workspace`

Directory examples:
- "open a session with Claude on the blog" → `cd /Volumes/Ext/dev/workspace/blog && claude --trust-workspace && claude remote-control`
- "open a Claude session on pockethook" → `cd /Volumes/Ext/dev/pockethook-main/pockethook-agent-server && claude --trust-workspace && claude remote-control`
- "open Claude" → `cd /Volumes/Ext/dev/pockethook-main/pockethook-agent-server/workspace && claude --trust-workspace && claude remote-control`

Example:
```json
{ "msg": "Opening remote Claude session...", "shortcut": "claudeRemote", "data": { "action": "start", "directory": "/Volumes/Ext/dev/workspace/blog" } }
```
