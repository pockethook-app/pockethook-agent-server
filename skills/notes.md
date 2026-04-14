---
title: Notes
description: Create notes on the user's device with a title and body
shortcuts: [newNote]
target: mac
sync_app: Notes
---

### New Note

Shortcut name: `newNote`

Creates a new note on the user's device.

Data fields:
- title (string, required): Note title
- content (string, required): Note body, can include multiple lines

Example:
```json
{ "msg": "Creating your note...", "shortcut": "newNote", "data": { "title": "Shopping List", "content": "1. Milk\n2. Eggs\n3. Bread" } }
```
