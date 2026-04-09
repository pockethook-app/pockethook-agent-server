### Claude Remote Control

Shortcut name: `claudeRemote`

Opens an interactive Claude Remote Control session in a persistent tmux session so it stays alive after launch.

Important behavior:
- Start Remote Control with `claude remote-control`.
- To send one-shot prompts to Claude in jobs, use `claude -p "your prompt"` instead. Do not use Remote Control for that.
- Trust the workspace before interactive use. Prefer `claude --trust-workspace` in the target directory.
- tmux is recommended here because Remote Control is a long-lived local process and the terminal must stay open.

Recommended shell behavior:
1. If a tmux session `claude-remote` already exists, kill it first.
2. Start a new detached tmux session in the target directory.
3. Run `claude --trust-workspace && claude remote-control`.

Recommended commands:
```bash
tmux kill-session -t claude-remote || true
tmux new-session -d -s claude-remote 'cd <DIRECTORY> && claude --trust-workspace && claude remote-control'
```

Default directory:
- `/Volumes/Ext/dev/pockethook-main/pockethook-agent-server/workspace`

Data fields:
- action (string, required): Action to execute. Use `start`.
- directory (string, optional): Working directory for the session.
- message (string, optional): Optional label or context.

Example:
```json
{ "msg": "Opening remote Claude session...", "shortcut": "claudeRemote", "data": { "action": "start", "directory": "/Volumes/Ext/dev/workspace/blog" } }
```
