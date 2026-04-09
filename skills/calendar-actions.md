### newCalendarEvent

Shortcut name: `newCalendarEvent`

Creates calendar events in a specific calendar. Default calendar is `Personal`, and it can also use `Familia`.

The agent must gather all required details before triggering the shortcut. If any relevant detail is missing, it must ask a follow-up question first. This includes reminder behavior and any ambiguity about date, time, title, calendar, or all-day status.

Important behavior:
- Once all required details are known, the agent must trigger the shortcut immediately. It must not stop at a text-only confirmation such as “Creating...” or “Updating...” without actually executing the shortcut.
- If the user does not specify a calendar, use `Personal` by default.
- If the user does not specify whether the event is all-day, assume `false` when the user gives explicit times.
- If `alert` is not provided, the agent should ask whether the user wants a reminder.
- If the user says they do not want a reminder, send `alert: false` and omit `alertTime`.
- If the user wants a reminder, send `alert: true` and include `alertTime`.
- If notes are not provided, they may be omitted.

Data fields:
- title (string, required): Event title.
- calendar (string, required): Target calendar. Default is `Personal`; it can also be `Familia`.
- startDate (ISO-8601, required): Event start date and time.
- endDate (ISO-8601, required): Event end date and time.
- allDay (boolean, required): Whether the event lasts all day.
- alert (boolean, required): Whether the event should include an alert.
- alertTime (ISO-8601, optional): Alert date and time. Required when `alert` is true.
- notes (string, optional): Additional event notes.

Example:
{ "msg": "Creating your calendar event...", "shortcut": "newCalendarEvent", "data": { "title": "Doctor appointment", "calendar": "Personal", "startDate": "2026-04-10T09:00:00+02:00", "endDate": "2026-04-10T10:00:00+02:00", "allDay": false, "alert": true, "alertTime": "2026-04-10T08:30:00+02:00", "notes": "Bring insurance card" } }

### findCalendarEvents

Shortcut name: `findCalendarEvents`

Searches calendar events within a day range to locate possible target events before editing or removing them. This shortcut is used to provide the search criteria; the shortcut itself returns the matching results.

Important behavior:
- Use this shortcut before editing or removing an event when the target event is not uniquely identifiable.
- Typical examples of ambiguity: the user changes “that event”, multiple events could share the same title, the calendar is unknown, or the original date is no longer clear.
- Do not guess when ambiguity exists. Identify the event first, then edit or remove it.

Data fields:
- calendar (string, optional): Target calendar. Use a specific calendar when known; otherwise use null if unknown.
- days (number, required): Number of days to search.

Example:
{ "msg": "Searching for matching calendar events...", "shortcut": "findCalendarEvents", "data": { "calendar": null, "days": 7 } }

### editCalendarEvent

Shortcut name: `editCalendarEvent`

Updates an existing calendar event after the correct target has been identified.

The agent must actually execute the edit once the event and updated values are clear. It must not reply with a text-only promise such as “I’ll update it” or “Updating...” unless it is also triggering the shortcut in that same response.

Important behavior:
- If the user corrects a previously created event, treat this as an edit flow and trigger `editCalendarEvent` once the target and new values are clear.
- If the target event is not clear, first use `findCalendarEvents` with an appropriate date range to identify it.
- If relevant details are missing, including `alert` or `alertTime`, ask follow-up questions before triggering the shortcut.
- If the user says the schedule stays the same except for the day, preserve the original time range.
- If the user says there should be no reminder, send `alert: false` and omit `alertTime`.
- Do not invent or assume fields that are still ambiguous.

Data fields:
- title (string, required): Event title.
- calendar (string, required): Target calendar.
- startDate (ISO-8601, required): Event start date and time.
- endDate (ISO-8601, required): Event end date and time.
- allDay (boolean, required): Whether the event lasts all day.
- alert (boolean, required): Whether the event should include an alert.
- alertTime (ISO-8601, optional): Alert date and time. Required when `alert` is true.
- notes (string, optional): Additional event notes.

Example:
{ "msg": "Updating your calendar event...", "shortcut": "editCalendarEvent", "data": { "title": "Doctor appointment", "calendar": "Personal", "startDate": "2026-04-10T09:00:00+02:00", "endDate": "2026-04-10T10:00:00+02:00", "allDay": false, "alert": true, "alertTime": "2026-04-10T08:30:00+02:00", "notes": "Bring insurance card" } }

### removeCalendarEvent

Shortcut name: `removeCalendarEvent`

Removes a calendar event by title and calendar only. Do not include dates or any other event fields in the payload. The payload must contain only `title` and `calendar`.

Important behavior:
- If the target event is ambiguous, identify it first with `findCalendarEvents`.
- Once the target is clear, execute the removal directly rather than only acknowledging it in text.

Data fields:
- title (string, required): Event title.
- calendar (string, required): Target calendar.

Example:
{ "msg": "Removing your calendar event...", "shortcut": "removeCalendarEvent", "data": { "title": "Doctor appointment", "calendar": "Personal" } }
