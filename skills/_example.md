### Template — How to add a skill

Each skill file describes one or more iOS Shortcuts that the LLM can trigger.

Format:
```
### Shortcut Display Name

Shortcut name: `Exact Name As On Device`

Description of what it does.

Data fields:
- fieldName (type, required/optional): Description

Example:
{ "msg": "Status message...", "shortcut": "Exact Name", "data": { "fieldName": "value" } }
```

Tips:
- The shortcut name must match EXACTLY as configured on the iOS device.
- Describe all data fields so the LLM knows what to send.
- Include a concrete example so the LLM understands the format.
- One file per category (e.g., notes.md, music.md, messaging.md).
- Files are sorted alphabetically. Prefix with _ for templates/docs.
