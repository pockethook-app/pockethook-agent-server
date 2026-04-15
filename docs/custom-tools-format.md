---
title: "Custom Tools File Format"
description: "Reference for authoring custom tool files — shell-command tools with typed parameters. Load this when installing a new CLI library and wiring it up as a tool."
---

## Where custom tool files live

- Base `custom-tools/` — framework-shipped (read-only).
- `data/user/custom-tools/` — user-installed (overrides base on tool-name collision).

Write every new or edited custom tool to the user layer.

## File format

Each `.md` file defines one tool with a shell command template.

```markdown
### Tool Display Name

Tool name: `tool_name`

Description of what it does.

Install: `command to install dependencies`

Command: `command with $param placeholders`

Parameters:
- paramName (type, required/optional): Description. Default: value
```

## Rules

- Tool name must be lowercase with underscores (e.g., `web_screenshot`, `pdf_convert`).
- Use `$paramName` in the Command to substitute parameter values.
- The Install command runs automatically the first time the tool is used (only once).
- One tool per file. Use kebab-case for file names (e.g., `web-screenshot.md`, `pdf-convert.md`).
- Files prefixed with `_` are treated as templates and ignored.
- Custom tools are hot-reloaded — available on the next request after creation.

## When to create a custom tool

When the user asks you to install a CLI tool or library and use it for tasks (e.g., "install playwright and take screenshots", "install ffmpeg and convert videos"):

1. Install the dependency using `shell` (e.g., `bun add playwright`, `brew install ffmpeg`).
2. Create a custom tool definition in `data/user/custom-tools/` so you can use it in future conversations.
3. Confirm to the user what was installed and what the new tool can do.

## Listing tools

If the user asks "what tools do you have?", list both built-in and custom tools.
