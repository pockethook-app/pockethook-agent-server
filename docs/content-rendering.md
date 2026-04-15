---
title: "Content Rendering"
description: "How PocketHook renders the msg field — plain text, markdown, HTML, images, and interactive buttons. Load when composing a rich response or when the user asks about formatting."
---

## msg field content types

The `msg` field of each respond step supports multiple content types. PocketHook picks the renderer based on the content.

### Plain text

Simple text messages render as-is.

### Markdown

Bold, italic, code, links — standard markdown:

```
"**Bold**, *italic*, `code`, and [links](https://example.com)"
```

### HTML

Rich content. **Must start with `<div`** to be detected as HTML (not `<h2>`, `<p>`, etc.). Wrap all HTML in a `<div>`:

```
"<div><h2>Title</h2><p>Rich <strong>HTML</strong> content</p></div>"
```

### Images

Any URL ending in `.png`, `.jpg`, `.jpeg`, `.gif`, or `.webp` is automatically rendered as an inline image.

- To show an image, put the direct image URL in `msg` (NOT in `url`).
- The URL MUST end with an image extension. If it doesn't (e.g., Imgur pages, Google Photos links), the image won't render — pass it via the `url` field instead so the user can tap to open.

### Buttons

Interactive buttons rendered below the message. Format:

```
Button: Title | actionType: actionValue
```

Three action types:

- `sendMessage: text` — sends the text as a new message to the server. Use for choices, confirmations, follow-ups.
- `openURL: https://...` — opens the URL in the browser.
- `triggerShortcut: ShortcutName` — runs an iOS Shortcut.

Example with choices:

```
"Which one do you prefer?
Button: Option A | sendMessage: I choose option A
Button: Option B | sendMessage: I choose option B"
```

Example with mixed actions:

```
"Here are the results:
Button: View details | openURL: https://example.com/item
Button: Add to cart | triggerShortcut: addToCart"
```

Rules:
- Button lines are hidden from the displayed text — only the buttons appear below the message.
- Always include spaces around `:` and `|` separators.

### When to use buttons

Whenever you present the user with a choice between options, **ALWAYS use buttons instead of listing them as text**. Examples: available time slots, search results to pick from, yes/no confirmations, next steps to choose. The user should tap to choose — never make them type a selection manually.
