---
title: "Setup Guide"
description: "Step-by-step guide to install PocketHook and connect it to your server."
---
## 1. Install PocketHook

Download PocketHook from the [App Store](https://apps.apple.com/app/pockethook/id0000000000) and open it on your iPhone, iPad, or Mac.

## 2. Configure Your Server

PocketHook needs an HTTPS endpoint to communicate with. You can use:

- **[Agent Server](/docs/agent-server/)** — Self-hosted AI agent with LLM, tools, background jobs, and memory
- **Your own API** — Any server that accepts POST requests and returns JSON
- **n8n** — Self-hosted workflow automation with a webhook trigger
- **[OpenClaw](/docs/openclaw-skill/)** — Self-hosted AI assistant with multi-channel messaging

### Server Requirements

Your server must:

- Accept **POST** requests with JSON body
- Return JSON responses
- Be accessible via **HTTPS** (HTTP is rejected for security)
- Optionally support Bearer token authentication

## 3. Connect in PocketHook

1. Open PocketHook and go to **Settings**
2. Enter your **Server URL** (must be HTTPS)
3. Enter your **Auth Token** (if your server requires authentication)
4. Tap **Test Connection** to verify

![PocketHook Settings screen](/images/docs/settings-screen.png)

## 4. Request Format

PocketHook sends messages as a JSON array:

```json
[{
  "sessionId": "uuid-v4",
  "action": "sendMessage",
  "chatInput": "your message here"
}]
```

## 5. Response Format

Your server should respond with a JSON object:

```json
{
  "msg": "Message displayed to the user",
  "shortcut": "OptionalShortcutName",
  "data": { "key": "value" },
  "url": "https://optional-url.com"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `msg` | string | Yes | Text displayed in chat |
| `shortcut` | string | No | iOS Shortcut to execute |
| `data` | object \| array | No | Data passed to the Shortcut |
| `url` | string | No | URL to open or display |

For multi-step automations, return an array of responses:

```json
[
  { "msg": "Step 1...", "shortcut": "FirstShortcut" },
  { "msg": "Step 2...", "shortcut": "SecondShortcut", "data": { "input": "value" } }
]
```

## 6. Quick Start with the Starter Server

Use our [starter server template](https://github.com/pockethook-app/pockethook-server) to get running in minutes:

```bash
git clone https://github.com/pockethook-app/pockethook-server.git
cd pockethook-server
bun install
cp .env.example .env
# Edit .env with your secret token
bun dev
```

The starter includes built-in commands (`ping`, `hello`, `help`, `time`) and examples for triggering Shortcuts. See the [API Reference](/docs/api-reference/) for the full protocol specification.

## 7. Using the SDK

Install the [pockethook-sdk](https://www.npmjs.com/package/pockethook-sdk) package to build type-safe responses:

```bash
bun add pockethook-sdk
```

```typescript
import { text, shortcut, responses, toResponse } from "pockethook-sdk";

// Simple text response
return toResponse(text("Hello from my server!"));

// Trigger a Shortcut
return toResponse(shortcut("Running...", "MyShortcut", { key: "value" }));

// Multi-step automation
return toResponse(responses([
  { msg: "Step 1", shortcut: "First" },
  { msg: "Step 2", shortcut: "Second" }
]));
```
