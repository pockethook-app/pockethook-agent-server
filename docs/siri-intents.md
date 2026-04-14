---
title: "Siri & App Intents"
description: "Use PocketHook with Siri and iOS Shortcuts for hands-free automation."
---
PocketHook provides six App Intents that integrate with Siri and the iOS Shortcuts app. You can use them to build powerful automations triggered by voice, time, location, or other iOS triggers.

## Send Message

**Intent**: `SendMessageIntent`

Send a message to your server and optionally wait for the response.

| Parameter | Type | Description |
|-----------|------|-------------|
| Message | string | The message to send |
| Wait for Response | boolean | If true, polls for up to 5 minutes |

**Example**: "Hey Siri, send 'check servers' with PocketHook"

Returns the server's response text if waiting is enabled.

## Send Data to Server

**Intent**: `SendDataToServerIntent`

Send a message to your server silently — without adding it to the chat history. Useful for background automations.

| Parameter | Type | Description |
|-----------|------|-------------|
| Message | string | The message to send |

**Example**: Create a Shortcuts automation that runs every morning and sends "daily-report" to your server.

## Extract Message

**Intent**: `ExtractMessageIntent`

Extract the `msg` field from a PocketHook response JSON string.

| Parameter | Type | Description |
|-----------|------|-------------|
| Response JSON | string | The raw JSON response |

**Returns**: The `msg` string from the response.

## Extract Data

**Intent**: `ExtractDataIntent`

Extract the `data` object from a PocketHook response JSON string.

| Parameter | Type | Description |
|-----------|------|-------------|
| Response JSON | string | The raw JSON response |

**Returns**: The `data` object as a JSON string.

## Extract Shortcut Name

**Intent**: `ExtractShortcutIntent`

Extract the `shortcut` name from a PocketHook response JSON string.

| Parameter | Type | Description |
|-----------|------|-------------|
| Response JSON | string | The raw JSON response |

**Returns**: The shortcut name string.

## Add Local Message

**Intent**: `AddLocalMessageIntent`

Add a message to the local chat history without sending anything to the server. Useful for logging automations locally.

| Parameter | Type | Description |
|-----------|------|-------------|
| Message | string | The message text to add |
| Sender | enum | `user` or `server` |

## Building Shortcuts Automations

### Basic: Send and Display

1. Add **Send Message** action (wait for response: on)
2. Add **Show Result** with the output

### Advanced: Parse and Act

1. **Send Message** → get raw response
2. **Extract Data** → get the data payload
3. Use the extracted data in other Shortcuts actions (set brightness, open app, etc.)

### Background Automation

1. Create a **Time of Day** automation
2. Add **Send Data to Server** with your trigger command
3. The server processes it and can trigger Shortcuts back via PocketHook

### Chaining with Other Apps

PocketHook intents work with any Shortcuts action. Combine them with:

- **Home** actions to control smart devices
- **Calendar/Reminders** to read or create events
- **Files** to process documents
- **Health** to log workout data
- Any other Shortcuts-compatible app
