---
name: letterdog-calendar-daily-brief
description: "Build concise one-day briefs from Letterdog, the user's self-hosted calendar. Use when the user asks for today's, tomorrow's, or a dated agenda, remaining meetings, conflicts, free windows, a day shape, or a daily calendar brief."
---

# Letterdog Calendar Daily Brief

## Read The Day

Resolve the requested day to a concrete local start and end. If the user says today, tomorrow, or
yesterday, use the active local timezone and state the exact date in the answer.

Use `calendar_list` when the user has not named calendars and calendar inclusion matters. Prefer
visible/subscribed calendars unless the user asks for all calendars or specific calendar ids.

Query the day with:

```json
{
  "time_min": "<local-day-start-as-ISO-instant>",
  "time_max": "<next-local-day-start-as-ISO-instant>",
  "calendar_ids": ["optional-calendar-ids"],
  "fetch": true,
  "limit": 500
}
```

Omit `properties` so `calendar_event_search` fetches complete JSCalendar event objects. Read the
events from `get.list`. Use `calendar_event_batch_get` without `properties` if you already have ids.

## Interpret Events

Normalize each event into title/summary, start, end, timezone, calendar id, location, participants,
status, and free/busy or transparency fields when present.

Treat all-day events and transparent/free events as context, not blockers. Compute conflicts from
overlapping busy timed events. If free/busy status is missing, infer cautiously and say what
assumption you made.

When a working-day readout is useful and the user did not specify hours, use a stated default such
as 09:00-18:00 local. Do not hide that assumption.

## Brief Format

Keep the brief compact and practical:

- Header with the exact date and timezone.
- One-line summary of meeting load, conflicts, and biggest free window.
- Agenda in chronological order.
- Conflicts or tight transitions.
- Free windows that are actually useful.
- Remaining-day readout when the day is already in progress.

Mention calendar/source gaps only when they affect confidence, such as missing availability
capability, failed calendar reads, or ambiguous all-day/free-busy semantics.
