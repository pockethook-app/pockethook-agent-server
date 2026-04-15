---
title: Example — Route Planner (template, not active)
description: Reference template for building a personal route-planner skill. Copy into data/user/skills/ and edit to activate.
shortcuts: []
target: device
---

### Template — Route Planner

This is a **template**. It is not an active skill. To enable a route planner
tailored to you, copy this file into `data/user/skills/route-planner.md`
(create the directory if it doesn't exist) and edit the values below.

The user-authored copy will take precedence over any template in the base
`skills/` directory and is ignored by git (everything under `data/` is
user-local).

#### Personal values (edit these)

Prefer keeping typed values in `data/user/prefs.json` and referencing them
here as `{{prefs.<key>}}`. The server substitutes the placeholder at skill
load time. Example `prefs.json`:

```json
{
  "routeOrigin": "Madrid, Spain",
  "preferredMapsApp": "apple"
}
```

Then write the skill in neutral terms:

- **Transport mode**: Car, unless the user specifies otherwise.
- **Starting point**: `{{prefs.routeOrigin}}`, unless the user specifies a
  different origin or the context implies otherwise (e.g., a return trip).

#### Route generation

1. Generate a maps link appropriate for the configured app:
   - Apple Maps: `https://maps.apple.com/?saddr=Origin&daddr=Destination&dirflg=d`
   - Google Maps: `https://www.google.com/maps/dir/?api=1&origin=Origin&destination=Destination&travelmode=driving`
2. Estimate the total driving time.
3. Return the link in the `url` field of respond.

#### Stop rules (optional)

If the estimated driving time exceeds a threshold (e.g., 3 hours), consider
proposing a stop. Make this rule your own — it's your preference, not a
framework default.

#### Notes

- Keep this file at `data/user/skills/route-planner.md` (user-local).
- Never edit `skills/_example-route-planner.md` directly in the base — that
  is the shipped template for other users.
