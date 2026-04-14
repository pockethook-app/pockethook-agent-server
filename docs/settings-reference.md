---
title: "Settings Reference"
description: "Complete reference for every setting and option in PocketHook."
---
## Server Configuration

The core connection settings for your PocketHook server.

### Server URL

|  |  |
|---|---|
| **Type** | Text field (URL) |
| **Default** | Empty |
| **Stored in** | iOS Keychain |

The HTTPS endpoint where PocketHook sends your chat messages. Only **HTTPS** URLs are accepted — HTTP is rejected for security. This is the primary endpoint your server listens on.

### Authentication Token

|  |  |
|---|---|
| **Type** | Secure text field |
| **Default** | Empty |
| **Length** | 10–1,000 characters |
| **Stored in** | iOS Keychain |

Bearer token sent in the `Authorization` header with every request. Your server can use this to verify that requests come from your device. Stored securely in the iOS Keychain — never in plain text.

### OpenClaw Compatible

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | OFF |

Enable if your server uses the [OpenClaw](https://openclaw.com) platform or any OpenAI-compatible Chat Completions API. When enabled, PocketHook sends messages in the OpenAI chat format and parses inline shortcut markers (`[SHORTCUT:name]`, `[DATA:{...}]`, `[URL:...]`) from the response. An `x-openclaw-agent-id` header is included with requests.

### Test Connection

Button that sends a test request to your configured server. Displays:

- **Response time** in milliseconds
- **Health check result** (if enabled)
- **Error details** if the connection fails

Use this after changing your Server URL or Auth Token to verify everything works.

---

## Network

Fine-tune timeout behavior for different types of operations.

### Request Timeout

|  |  |
|---|---|
| **Type** | Stepper (±5 seconds) |
| **Default** | 5 seconds |
| **Range** | 1–600 seconds |

How long PocketHook waits for the server to **start responding** to a request. If your server does heavy processing (like calling an AI model), increase this value. For simple webhook servers, the default of 5 seconds is usually fine.

### Resource Timeout

|  |  |
|---|---|
| **Type** | Stepper (±10 seconds) |
| **Default** | 60 seconds |
| **Range** | 30–600 seconds |

Maximum time for the **entire response** to complete, including data transfer. This should be higher than the Request Timeout. Increase if your server returns large payloads or has slow upload speeds.

### Health Check

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | OFF |

Enable server health monitoring. When active, PocketHook sends a GET request to the Health Check URL during connection tests and displays whether your server reports healthy.

### Health Check URL

|  |  |
|---|---|
| **Type** | Text field (URL) |
| **Default** | Empty |
| **Visible when** | Health Check is ON |

A separate HTTPS endpoint that returns plain text `true` or `false`. This URL is pinged during connection tests to verify your server is operational. Useful when your main API endpoint is behind authentication but you want a simple status check.

---

## Automation

Control how PocketHook executes iOS Shortcuts triggered by server responses.

### iOS Shortcuts

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | ON |

Master toggle for Shortcut execution. When OFF, PocketHook still displays messages from the server but ignores any `shortcut` fields in responses. Useful for debugging or temporarily disabling automations.

### Delay Between Shortcuts

|  |  |
|---|---|
| **Type** | Slider |
| **Default** | 2.0 seconds |
| **Range** | 0.5–10.0 seconds |

Wait time between executing consecutive shortcuts when the server returns multiple automations in a single response. Increase this if your shortcuts depend on each other (e.g., the first shortcut creates a file that the second one reads).

### Shortcut Timeout

|  |  |
|---|---|
| **Type** | Segmented picker |
| **Default** | 5 minutes (300s) |
| **Options** | 30s, 1 min, 2 min, 5 min |

Maximum time to wait for each individual shortcut to finish before PocketHook considers it timed out. Long-running shortcuts (like ones that process media or make multiple API calls) may need the full 5 minutes.

---

## Personal UI

Embed a custom web interface directly in PocketHook.

### Personal UI

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | OFF |

Show a dedicated tab with an embedded web view. When enabled, a new tab appears in the main navigation where your custom web page is displayed. The page is preloaded for instant display and supports pull-to-refresh.

### Personal UI URL

|  |  |
|---|---|
| **Type** | Text field (URL) |
| **Default** | Empty |
| **Visible when** | Personal UI is ON |

The URL to display in the Personal UI tab. Both HTTP and HTTPS are accepted (HTTPS recommended). This could be a dashboard, admin panel, or any web page you want quick access to alongside your chat.

---

## Links

Configure how PocketHook handles URLs from server responses.

### Links Tab

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | ON |

Show or hide the Links tab in the main navigation. When enabled, all URLs received from server responses are saved and displayed in a dedicated tab with rich link previews, search, and delete functionality.

### Auto-open URLs

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | ON |

When enabled, PocketHook automatically opens URLs from server responses in your default browser. When disabled, URLs are still saved to the Links tab (if enabled) but won't open automatically.

---

## Language

Customize the app and dictation language.

### App Language

|  |  |
|---|---|
| **Type** | Picker |
| **Default** | System Default |
| **Options** | System Default, English, Español |

Override the app's display language independently of your device language. When set to "System Default", PocketHook follows your iOS language setting.

### Dictation Language

|  |  |
|---|---|
| **Type** | Picker |
| **Default** | System locale |
| **Options** | 21 languages |

Language used for voice dictation (speech-to-text) in the chat input. Available languages:

| Language | Code |
|----------|------|
| English (US) | en-US |
| English (UK) | en-GB |
| Spanish (Spain) | es-ES |
| Spanish (Mexico) | es-MX |
| French | fr-FR |
| German | de-DE |
| Italian | it-IT |
| Portuguese (Brazil) | pt-BR |
| Portuguese (Portugal) | pt-PT |
| Catalan | ca-ES |
| Chinese (Simplified) | zh-CN |
| Japanese | ja-JP |
| Korean | ko-KR |
| Arabic | ar-SA |
| Russian | ru-RU |
| Dutch | nl-NL |
| Swedish | sv-SE |
| Polish | pl-PL |
| Turkish | tr-TR |
| Thai | th-TH |
| Vietnamese | vi-VN |

---

## Background Tasks

Periodically check for pending tasks even when the app is in the background.

### Background Tasks

|  |  |
|---|---|
| **Type** | Toggle |
| **Default** | OFF |

Enable background polling. When active, PocketHook periodically sends a GET request to the Polling URL. If the response is `true`, it sends the Fetch Message to your main server when the app opens. Requires notification permission to alert you of pending tasks.

### Check Interval

|  |  |
|---|---|
| **Type** | Segmented picker |
| **Default** | 15 minutes |
| **Options** | 5 min, 15 min, 30 min, 1 hr, 2 hr |

How often PocketHook checks the Polling URL in the background. Shorter intervals mean faster detection of pending tasks but use more battery. iOS may adjust the actual frequency based on device usage patterns.

### Polling URL

|  |  |
|---|---|
| **Type** | Text field (URL) |
| **Default** | Empty |
| **Visible when** | Background Tasks is ON |

HTTPS endpoint that PocketHook polls at the configured interval. Must return plain text `true` (tasks pending) or `false` (no tasks). This is a lightweight check — your server should respond quickly without heavy processing.

**Agent Server:** Use `https://your-host/jobs` (adjust host and port to match your setup).

### Fetch Message

|  |  |
|---|---|
| **Type** | Text field |
| **Default** | `fetchPendingTasks` |
| **Max length** | 10,000 characters |

The message sent to your main server when a background check finds pending tasks and the app opens. The server response appears in chat like any other message. Customize this to trigger specific server-side behavior.

---

## Data Management

Monitor and manage your stored messages.

### Messages Stored

|  |  |
|---|---|
| **Type** | Read-only display |
| **Format** | "X of 500 messages" |

Shows how many messages are currently stored. The indicator is color-coded:

- **Green** — Under 70% capacity
- **Orange** — 70–90% capacity
- **Red** — Over 90% capacity

When the 500-message limit is reached, the oldest messages are automatically deleted to make room for new ones.

### Export Conversation

Button that exports all stored messages as a JSON file via the iOS share sheet. You can save the file, AirDrop it, or share it with any app. Useful for backing up conversations or analyzing message history.

### Delete All Messages

Destructive button that permanently removes all stored messages. Requires confirmation before executing. This action cannot be undone.

---

## About

Read-only information about your PocketHook installation.

| Field | Description |
|-------|-------------|
| **App Version** | Current PocketHook version (e.g., 1.0.0) |
| **Build** | Build number for this release |
| **iOS Version** | iOS/iPadOS version running on your device |
