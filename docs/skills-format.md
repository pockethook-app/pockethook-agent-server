---
title: "Skills File Format"
description: "Reference for authoring skill files — frontmatter, shortcut definitions, behavior rules, file naming. Load this when creating or editing a skill file."
---

## Where skill files live

- Base `skills/` — framework-shipped (read-only).
- `data/user/skills/` — user-authored (overrides base on filename collision).

Write every new or edited skill to the user layer.

## Required file format

Every skill file MUST start with YAML frontmatter:

```markdown
---
title: Human-readable title
description: One short sentence describing the purpose (used in the skills index)
shortcuts: [shortcutName1, shortcutName2]
target: device
---

### Display Name

Body of the skill (shortcut definitions, behavior rules, etc.)
```

### Frontmatter rules

- `title`: short human-readable name.
- `description`: ONE sentence — this is what the agent sees in the skills index, so make it specific enough to know when to load the skill.
- `shortcuts`: array of every shortcut name defined in the file. Use `[]` for behavior-only skills with no shortcuts.
- `target` (optional): `mac` to execute shortcuts on the Mac server, `device` to send to the iOS device (default). Use `mac` for shortcuts that create iCloud-synced content (notes, reminders, calendar) or don't need iOS device interaction. When a skill has `target: mac`, set `run_on: "server"` in the respond tool call.

## Shortcut body format

For each shortcut in the file:

```markdown
### Display Name

Shortcut name: `ExactName`

Description.

Data fields:
- fieldName (type, required/optional): Description

Example:
{ "msg": "Status...", "shortcut": "ExactName", "data": { "field": "value" } }
```

## Behavior skill body format

For behavior rules (no shortcuts), use prose with sections describing the trigger, the rules to apply, and any examples. Be explicit and concrete.

## File naming

Use kebab-case (e.g., `new-playlist.md`, `family-trip.md`, `send-email.md`).

## Language

Skill files must ALWAYS be written in English, regardless of the language the user is speaking. Titles, descriptions, field descriptions, and rules must all be in English. Only the user's example values can stay in their original language.

## Authoring flow

1. Identify what is provided and what is missing.
   - For shortcut skills: shortcut name (exact, as on device), description, all data fields with types, and where it should run (mac or device).
   - For behavior skills: the trigger condition and the rules to apply.
2. Ask the user where the shortcut should run (Mac server vs iOS device). Suggest `mac` for iCloud-synced content (notes, reminders, calendar) or shortcuts that don't need iOS interaction.
3. If anything is missing or ambiguous, ask the user before proceeding. Do NOT invent names, fields, or rules.
4. Show the user a short summary of what you understood and ask for confirmation before creating the file.
5. Only after confirmation, create the `.md` file in `data/user/skills/`.
6. Confirm the result to the user via respond.

## Global rules vs skills

If the user asks for a rule that is NOT tied to a specific trigger or shortcut — "from now on always respond in English", "never use ASCII tables", "prefer brief answers" — that belongs in `data/user/instructions.md`, not in a skill file.

## Typed preferences

If the user expresses a default VALUE — "my route origin is Madrid", "my tunnel domain is foo.ts.net" — store it in `data/user/prefs.json` as a JSON key. Reference it in skills as `{{prefs.key}}` and the server substitutes at load time.
