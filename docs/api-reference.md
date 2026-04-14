---
title: "API Reference"
description: "Complete reference for the PocketHook communication protocol."
---
## Protocol Overview

PocketHook communicates with your server using a simple JSON-based protocol over HTTPS. The app sends POST requests and expects JSON responses.

## Authentication

PocketHook sends the configured auth token as a Bearer token:

```
Authorization: Bearer your-secret-token
Content-Type: application/json
```

## Request

### Standard Format

```json
[{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "action": "sendMessage",
  "chatInput": "user message"
}]
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string (UUID v4) | Unique session identifier |
| `action` | string | Always `"sendMessage"` |
| `chatInput` | string | User's message (max 10,000 characters) |

### OpenClaw Format

When OpenClaw mode is enabled, PocketHook uses the OpenAI Chat Completions format:

```json
{
  "model": "agent-id",
  "messages": [
    { "role": "user", "content": "user message" }
  ]
}
```

With the header `x-openclaw-agent-id` set to the configured agent ID.

## Response

### Single Response

```json
{
  "msg": "Display message",
  "shortcut": "ShortcutName",
  "data": { "key": "value" },
  "url": "https://example.com"
}
```

### Multi-Action Response

Return an array for sequential execution:

```json
[
  { "msg": "Starting...", "shortcut": "FirstAction" },
  { "msg": "Processing...", "shortcut": "SecondAction", "data": { "input": "from-first" } },
  { "msg": "Done!", "url": "https://results.example.com" }
]
```

PocketHook executes shortcuts in order, waiting for each to complete before running the next.

### Response Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `msg` | string | Yes | Text shown in the chat. Supports Markdown, HTML, images, and [button syntax](#buttons). |
| `shortcut` | string | No | Name of an iOS Shortcut to execute. |
| `data` | object \| array | No | JSON data passed as input to the Shortcut. |
| `url` | string | No | URL to associate with the message. |

### OpenClaw Response

When using OpenClaw mode, PocketHook parses inline markers from the response content:

```
Here's your result! [SHORTCUT:ProcessData] [DATA:{"key":"value"}] [URL:https://example.com]
```

## Content Rendering

The `msg` field supports multiple content types:

### Plain Text
```json
{ "msg": "Simple text message" }
```

### Markdown
```json
{ "msg": "**Bold**, *italic*, `code`, and [links](https://example.com)" }
```

### HTML

Must start with `<div` to be detected as HTML:

```json
{ "msg": "<div><h2>Title</h2><p>Rich <strong>HTML</strong> content</p></div>" }
```

### Images
```json
{ "msg": "https://example.com/image.png" }
```

Any URL ending in `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp` is rendered as an image.

### Buttons

Interactive buttons rendered below the message. Format: `Button: Title | actionType: actionValue`

Three action types:
- `sendMessage: text` — sends the text as a new message to the server
- `openURL: https://...` — opens the URL in the browser
- `triggerShortcut: ShortcutName` — runs an iOS Shortcut

```json
{ "msg": "Which one do you prefer?\nButton: Option A | sendMessage: I choose option A\nButton: Option B | sendMessage: I choose option B" }
```

Mixed actions:
```json
{ "msg": "Here are the results:\nButton: View details | openURL: https://example.com/item\nButton: Add to cart | triggerShortcut: addToCart" }
```

Button lines are hidden from the displayed text — only the interactive buttons appear below the message.

## Health Check

PocketHook supports an optional health check endpoint:

- **Method**: GET
- **Expected response**: Plain text `true` or `false`
- **URL**: Configured separately in Settings

## Background Polling

When enabled, PocketHook periodically sends a GET request to the polling URL:

- If the response is `true`, PocketHook sends the configured fetch message to the main server
- Polling intervals: 5, 15, 30, 60, or 120 minutes
- Requires notification permission for background alerts

**Agent Server:** Use `https://your-host/jobs` as the Polling URL. It returns `true` when there are completed background job results pending delivery.

## SDK

Use the [pockethook-sdk](https://www.npmjs.com/package/pockethook-sdk) npm package to build responses with TypeScript:

```typescript
import { text, shortcut, responses, toResponse, parseRequest } from "pockethook-sdk";

// Parse and validate incoming request
const { sessionId, chatInput } = parseRequest(requestBody);

// Build responses
toResponse(text("Hello!"));
toResponse(shortcut("Running...", "MyShortcut", { key: "value" }));
toResponse(responses([
  { msg: "Step 1", shortcut: "First" },
  { msg: "Step 2", shortcut: "Second" }
]));
```

See the [starter server](https://github.com/pockethook-app/pockethook-server) for a minimal working example, or the [agent server](https://github.com/pockethook-app/pockethook-agent-server) for a full AI agent with tool-calling and background jobs.
