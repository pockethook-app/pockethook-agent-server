---
title: "OpenClaw Skill"
description: "Use PocketHook with OpenClaw — trigger iOS Shortcuts from your self-hosted AI assistant."
---
## What is the OpenClaw Skill?

The PocketHook skill for [OpenClaw](https://github.com/nickytonline/OpenClaw) lets your OpenClaw agent trigger iOS Shortcuts on your device. When you ask OpenClaw to create a note, make a playlist, or run any automation, the agent includes markers in its response that PocketHook detects and executes.

> **Early release.** This skill may need additional tuning for your setup. The included shortcuts are examples — you'll need to register your own and adapt the skill to match how you use PocketHook.

## How It Works

1. You send a message from PocketHook, which forwards it to your OpenClaw server
2. OpenClaw processes it with its LLM and the PocketHook skill
3. The response includes inline markers like `[SHORTCUT:New Note]` and `[DATA:{...}]`
4. PocketHook detects the markers, strips them from the displayed message, and executes the Shortcuts on your device

PocketHook communicates with OpenClaw using the OpenAI Chat Completions format with the header `x-openclaw-agent-id: main`.

## Setup

### 1. Install the skill

```bash
git clone https://github.com/pockethook-app/openclaw-pockethook.git
cp -r openclaw-pockethook/ ~/.openclaw/workspace/skills/pockethook/
```

OpenClaw hot-reloads skills — no restart needed.

### 2. Configure PocketHook

In PocketHook on your iOS device, go to **Settings**:

| Setting | Value |
|---------|-------|
| **Server URL** | Your OpenClaw HTTP proxy URL (HTTPS) |
| **Auth Token** | Your OpenClaw auth token |
| **OpenClaw Mode** | ON |

For background tasks (optional):

| Setting | Value |
|---------|-------|
| **Background Tasks** | ON |
| **Polling URL** | Your polling endpoint |
| **Fetch Message** | `fetchPendingTasks` |

Tap **Test Connection** to verify.

## Supported Markers

| Marker | Purpose |
|--------|---------|
| `[SHORTCUT:name]` or `[RUN:name]` | Trigger an iOS Shortcut |
| `[DATA:{...}]` | Pass JSON data to the preceding shortcut |
| `[URL:https://...]` | Open a URL in the in-app browser |

Markers are placed at the end of the response and can be combined:

```
Creating your note and opening the recipe.

[URL:https://example.com/recipe]
[SHORTCUT:New Note]
[DATA:{"title": "Pasta Recipe", "content": "Ingredients: flour, eggs, salt"}]
```

Multiple shortcuts execute in sequence — PocketHook waits for each to complete before running the next.

## Registering Your Shortcuts

The skill comes with example shortcuts (`New Note`, `newPlayList`). To add your own, edit `SKILL.md` in three places:

### 1. The `description` field

Add your shortcut trigger to the `Use when:` list so OpenClaw activates the skill:

```yaml
description: >
  ...
  Use when: create a note, make a playlist, set a reminder, ...
```

### 2. The "When to Use" table

Map user intent to the shortcut action:

```markdown
| User asks to set a reminder | `[SHORTCUT:Add Reminder]` with `title` and `date` |
```

### 3. The "User's Shortcuts" section

Document the shortcut name and data format:

```markdown
### Reminders
- `Add Reminder` — Create a reminder. Data: `{"title": "...", "date": "..."}`
```

## Background Tasks

PocketHook supports polling for async work:

1. PocketHook sends a **GET** to the Polling URL periodically
2. If the response is `true`, a notification appears
3. When the user opens PocketHook, it sends `fetchPendingTasks`
4. OpenClaw responds with the completed results (including shortcut markers)
5. If no pending results, respond with just `false`

This lets OpenClaw handle long tasks (research, project creation, data analysis) in the background and deliver results when ready.
