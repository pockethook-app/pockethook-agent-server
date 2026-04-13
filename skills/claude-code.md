---
title: Claude Code
description: Run Claude as one-shot background jobs (claude -p) or start an interactive Remote Control session via tmux
shortcuts: [claudeRemote]
---

### Claude Code

Shortcut name: `claudeRemote`

Guidance for using Claude from PocketHook, covering both one-shot background jobs and interactive Remote Control sessions.

## When to use each mode

Use **background jobs** for programming work that should run and finish on its own:
- create projects
- review code
- refactor or debug
- run build, test, or fix workflows
- any non-interactive task that should return a final result later

Use **Remote Control** when the user wants to actively drive a live Claude session from the Claude app or claude.ai/code.

## 1) One-shot Claude jobs

Use Claude Code CLI in non-interactive mode inside PocketHook background jobs.

Preferred command:
- `claude -p "your prompt"`

Equivalent long form:
- `claude --print "your prompt"`

Recommended when the task may modify files:
- `claude -p --dangerously-skip-permissions "your prompt"`

Important behavior:
- `-p` / `--print` is the correct one-shot mode for jobs.
- `-p` exits after answering, so it fits PocketHook jobs well.
- `-p` skips the workspace trust dialog, so only use it in directories you trust.
- Always instruct Claude to use non-interactive flags in downstream CLI commands such as `--yes`, `-y`, `--defaults`, or `--no-interactive`.
- Use `timeout: "30m"` for typical programming tasks and `timeout: "1h"` for larger ones.
- Prefer a single shell job that runs Claude directly.
- If PocketHook jobs cannot find `claude`, use the absolute path to the binary instead of relying on PATH.
- Use absolute project paths in `cd` commands whenever possible to avoid mistakes such as `workspace/workspace/...`.
- In PocketHook, the default working area is already `workspace/`, so prompts and commands should not prepend an extra `workspace/` when they are already inside that base directory.

Recommended job pattern:
```js
create_job({
  name: "Task description",
  type: "once",
  execution_type: "shell",
  timeout: "30m",
  prompt: "cd /absolute/path/to/project && /absolute/path/to/claude -p --dangerously-skip-permissions \"Your prompt here. IMPORTANT: Always use non-interactive flags (--yes, -y, --defaults, --no-interactive) in all CLI commands. You cannot respond to interactive prompts.\""
})
```

## 2) Why Claude jobs may fail or seem not to run

Common causes:
- The `claude` binary is not on the job runner PATH, even if it works in an interactive terminal.
- The command started an interactive tool that is waiting for input.
- The timeout was too short.
- Authentication is missing, expired, or uses the wrong login method.
- The target directory is not trusted and the workflow depends on trust-sensitive behavior.
- The shell command used a relative path or wrong working directory.
- The shell command accidentally duplicated the workspace base path, causing incorrect paths such as `workspace/workspace/...`.
- The job actually finished, but PocketHook has not yet delivered the result because delivery depends on polling and a later fetch.

Practical debugging tips:
- Prefer explicit commands such as `cd /absolute/path && /absolute/path/to/claude ...`.
- If PATH is unreliable, do not use bare `claude`; use the absolute path to the binary.
- Keep the whole workflow non-interactive.
- Use `claude auth status --text` when authentication is suspected.
- Add `--debug-file /tmp/claude-job.log` when diagnosing failures.
- Compare the PATH in Terminal with the PATH available to the scheduler if the command works manually but fails in jobs.
- If the target project is inside PocketHook's workspace, verify that the path is not being prefixed twice.

## 3) Workspace trust

Before starting an interactive Claude session in a folder, trust it first.

Useful command:
- `claude --trust-workspace`

Notes:
- Remote Control documentation says to run `claude` in the project directory at least once to accept the workspace trust dialog.
- In automation, `claude --trust-workspace` is a clearer explicit step before interactive use.
- For print mode, Claude notes that the trust dialog is skipped, so only run `-p` in directories you trust.
- A robust remote startup flow is: `cd <DIRECTORY> && claude --trust-workspace && claude remote-control`.
- Prefer an absolute project directory here as well, especially when launching from PocketHook automation.

## 4) Remote Control

Remote Control starts with:
- `claude remote-control`

Purpose:
- Keep a Claude session running locally and control it from the Claude mobile app or `claude.ai/code`.

Important behavior:
- `claude remote-control` is a persistent local process.
- The process must remain alive for the remote session to keep working.
- If the launching terminal, shell, or host process exits, the remote session ends.
- It is different from `claude -p`, which is one-shot and exits immediately.
- Remote Control requires claude.ai authentication and a supported subscription or organization setting.
- Trust the workspace before interactive use.
- In practice, when Remote Control is launched from automation or any non-persistent shell, `tmux` is the recommended way to keep the session alive reliably.

## 5) Should tmux be used?

Recommendation:
- **Yes for Remote Control.** `tmux` is recommended because Remote Control is long-lived and the launching environment is often not persistent in real automation flows.
- **No for one-shot jobs.** `tmux` adds unnecessary complexity for `claude -p` background jobs.

Why `tmux` helps Remote Control:
- It keeps the process alive after the launching terminal disconnects.
- It gives a durable terminal session on the machine.
- It matches the requirement that the local process must remain running.
- It helps avoid the session dying immediately after startup.
- It is the practical default when Remote Control is started outside a terminal that the user will keep open.

Why `tmux` is not needed for jobs:
- PocketHook jobs already run in background and capture output.
- `claude -p` is designed to run once and exit.
- Adding `tmux` makes output capture and debugging harder.
- If the real problem is PATH, `tmux` will not fix it.

## 6) PocketHook shortcut for Remote Control

Use this shortcut when the user wants an interactive remote Claude session.

Data fields:
- action (string, required): Action to execute. Use `start`. Do not use the shortcut to stop a remote session.
- directory (string, optional): Working directory for the session.
- message (string, optional): Optional label or context.

Recommended shell behavior behind the shortcut:
1. Ensure the target directory is trusted with `claude --trust-workspace`.
2. If a tmux session `claude-remote` already exists, stop it.
3. Start a new tmux session that runs `claude remote-control` in the target directory.
4. To stop a remote session, do not run the shortcut again. Instead, check for running tmux sessions and close the Claude Remote Control tmux session directly.
5. After stopping, verify that no Claude Remote Control tmux session remains open.
6. Prefer the absolute path to the Claude binary if shell startup files are not loaded.
7. Prefer an absolute project directory instead of a relative workspace path.

Recommended commands:
```bash
tmux kill-session -t claude-remote || true
tmux new-session -d -s claude-remote 'cd <ABSOLUTE_DIRECTORY> && /absolute/path/to/claude --trust-workspace && /absolute/path/to/claude remote-control'

# Stop flow (outside the shortcut)
tmux list-sessions
tmux kill-session -t claude-remote
tmux list-sessions
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

Stopping guidance:
- Do not trigger `claudeRemote` to stop a session.
- Check tmux sessions first, then close the Claude Remote Control tmux session directly.
- Confirm afterward that no Claude Remote Control tmux session is still open.
