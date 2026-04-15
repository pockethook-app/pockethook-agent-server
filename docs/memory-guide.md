---
title: "Memory Authoring Guide"
description: "What to store in the knowledge graph and vector memory, format conventions, and when to use each tool. Load when storing complex facts or reviewing memory behavior."
---

## What TO store

- **Personal info**: "Vivo en Madrid" → `("user", "lives_in", "Madrid")`.
- **Relationships**: "My mother is called Sarah" → `("user", "mother", "Sarah")`. Always store BOTH directions when relevant: `("user", "mother", "Sarah")` AND `("Sarah", "lives_in", "London")` if location is known.
- **Preferences**: "Prefiero modo oscuro" → `("user", "prefers", "dark mode")`.
- **Dates & milestones**: birthdays, anniversaries, wedding dates → `("John", "birthdate", "1990-03-15")`.
- **Daily routines**: "Me voy a dormir" → `("user", "went_to_sleep", "2026-04-10T23:30")`. These build daily summaries.
- **Mood & state**: "Estoy cansado" → `("user", "felt", "tired")` — only when explicitly stated.
- **Activities done**: "Fui al gym" → `("user", "went_to", "gym")`.
- **Confirmed events**: "I'm visiting London on the 17th" → `("user", "scheduled_visit_london", "2026-04-17")`.

## What NOT to store

- **Requests / commands**: "Créame una nota con X", "búscame Y", "recuérdame Z" — tasks to execute, not facts.
- **Acknowledgments**: small talk, greetings, confirmations.
- **One-off content**: lists, search results, generated content — goes in the note/file, not the knowledge graph.
- **Tool outputs**: anything you produced as a response.

## Object format rules

- Use structured, machine-readable values: ISO dates (`2026-04-17`), plain location names (`Madrid`), numbers as numbers.
- Avoid narrative sentences in the object (NOT `"will visit mother Sarah with the family on Friday at 17:00"`).
- For events, split one fact per triple: separate `scheduled_visit` from `travel_companions` from `return_date`.

## Evolving events

When the user is planning an event and details change in the same flow (date, time, companions):

- Store the event ONCE with a stable slugged predicate (e.g., `scheduled_visit_london_20260417`).
- When details change, the old triple auto-invalidates and the new value is stored (single-value predicates).
- If the event is cancelled, use `complete_project` with `project_slug` — the handler invalidates all related triples and records the cancellation in one call. You do NOT need to call `remember_fact` separately.

## Project naming convention

When the user announces a plan, use a UNIQUE predicate per project with a slug derived from the key attribute (destination, project name, topic):

- "Voy a Barcelona la semana que viene" → `remember_fact({subject: "user", predicate: "scheduled_visit_barcelona", object: "2026-04-19"})`
- "Voy a Japón en julio" → `remember_fact({subject: "user", predicate: "scheduled_visit_japan", object: "2026-07"})`
- "Estoy escribiendo una novela de ciencia ficción" → `remember_fact({subject: "user", predicate: "writing_scifi_novel", object: "in_progress"})`

Do NOT use generic predicates like `scheduled_visit` or `current_project` — those would overwrite each other when the user has multiple concurrent projects.

## PARA status

Every vector memory has a status:

- `project` — active undertaking with a specific outcome or deadline.
- `area` — ongoing responsibility or life area with no deadline. Default.
- `resource` — reference material or interests (lists, recipe collections).
- `archive` — completed, cancelled, or inactive. Excluded from search by default.

Use `update_memory_status` for manual transitions. Use `complete_project` when a project ends — it archives events/decisions and preserves reference material.

## Storage rule

ALWAYS store facts BEFORE executing any task the user asked. If the user says "my mother lives in London, create me a note about...", FIRST store `("Sarah", "lives_in", "London")`, THEN create the note. Never skip storing facts just because you are busy with another task.

Facts are temporal — if a fact changes (same subject+predicate), the old value is automatically invalidated. For multi-value relationships (child, friend, sibling, hobby), call `remember_fact` ONCE PER VALUE.

## When to use which

- `search_memory` — find past conversation fragments (what was said, when, context). Add `status: "project"` to list active projects, or `status: "resource"` to find saved lists and references.
- `query_facts` — retrieve structured facts about entities (preferences, relationships, events, dates).
- `remember_fact` — store a new fact. Include dates in the object value when relevant.
- `update_memory_status` — manually change status on a specific wing (e.g., a single project).
- `complete_project` — archive events + preserve resources + invalidate triples when a project ends. Always preferred for cancellations/completions.
