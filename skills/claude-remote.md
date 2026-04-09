### Claude Remote Control

Shortcut name: `claudeRemote`

Opens an interactive remote Claude Code session inside a persistent **tmux** session. The user can connect from their iPhone via claude.ai/code.

When the user says "open a session with Claude in [directory/project]", use the specified directory as the working directory. If no directory is specified, use the default workspace.

**Steps:**

1. If a tmux session `claude-remote` already exists, kill it first: `tmux kill-session -t claude-remote`
2. Create the new session with the appropriate directory:
```
tmux new-session -d -s claude-remote 'cd <DIRECTORY> && claude remote-control'
```

**Default directory:** `/Volumes/Ext/dev/pockethook-agent-server/workspace`

**Directory examples:**
- "open a session with Claude on the blog" → `cd /Volumes/Ext/dev/workspace/blog && claude remote-control`
- "open a Claude session on pockethook" → `cd /Volumes/Ext/dev/pockethook-agent-server && claude remote-control`
- "open Claude" (no project) → `cd /Volumes/Ext/dev/pockethook-agent-server/workspace && claude remote-control`

Data fields:
- action (string, required): Action to execute, default "start"
- directory (string, optional): Working directory for the session
- message (string, optional): Additional message or context for the session

Example:
```json
{ "msg": "Opening remote Claude session on the blog...", "shortcut": "claudeRemote", "data": { "action": "start", "directory": "/Volumes/Ext/dev/workspace/blog" } }
```
