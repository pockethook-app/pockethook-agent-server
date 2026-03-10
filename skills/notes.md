### New Note

Shortcut name: `New Note`

Creates a new note on the user's device.

Data fields:
- title (string, required): Note title
- content (string, required): Note body, can include multiple lines

Example:
```json
{ "msg": "Creating your note...", "shortcut": "New Note", "data": { "title": "Shopping List", "content": "1. Milk\n2. Eggs\n3. Bread" } }
```
