---
title: Skill Template
description: Reference for authoring skill files. Not loaded as a real skill.
shortcuts: []
---

### Template — How to add a skill

Each skill file describes one or more iOS Shortcuts that the LLM can trigger.

## Frontmatter (recommended)

Add YAML frontmatter at the top of the file so the agent sees a short
summary in the skills index without loading the whole file:

```
---
title: Human-readable title
description: One short sentence describing the purpose
shortcuts: [shortcutName1, shortcutName2]
---
```

The `shortcuts` array lists ALL shortcut names defined in the file.
The agent uses this to know which file to load_skill when the user
needs a specific shortcut.

## Body format

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
