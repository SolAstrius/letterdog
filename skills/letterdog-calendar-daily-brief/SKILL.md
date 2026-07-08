---
name: letterdog-calendar-daily-brief
description: "Build concise one-day briefs from Letterdog — the user's personal self-hosted mail/calendar/contacts (JMAP), not Google Calendar. Use when the user asks for today's, tomorrow's, or a dated agenda, remaining meetings, conflicts, free windows, a day shape, or a daily calendar brief."
---

# Letterdog Calendar Daily Brief

Tool mechanics, confirmation flow, and CLI routing live in the `letterdog-calendar` skill. This
skill covers only the daily-brief workflow.

## Read The Day

Resolve the requested day to a concrete local window and state the exact date and timezone in the
answer. Query with `search_events`: `after` = local day start, `before` = next day start (both
LocalDateTime, no Z), `time_zone` = the user's zone, `expand: true` so recurring events appear as
that day's actual occurrences (expand requires both bounds). Bounds use overlap semantics, so events
straddling midnight are included. Use `list_calendars` only when calendar inclusion matters and the
user has not named calendars; `in_calendar` scopes to one.

Follow up with `read_events` on the returned ids (base or synthetic instance ids) only when brief
fields are insufficient — location, participants, description.

## Interpret Events

Work from the brief projection: title, start, end (computed), time_zone, calendar, location,
participants, status. Treat all-day and free/transparent events as context, not blockers. Compute
conflicts from overlapping busy timed events. If free/busy status is missing, infer cautiously and
say what assumption you made. When a working-day readout is useful and the user did not specify
hours, use a stated default such as 09:00-18:00 local — do not hide that assumption.

## Brief Format

Keep the brief compact and practical:

- Header with the exact date and timezone.
- One-line summary: meeting load, conflicts, biggest free window.
- Agenda in chronological order.
- Conflicts or tight transitions.
- Free windows that are actually useful.
- Remaining-day readout when the day is already in progress.

Mention source gaps only when they affect confidence: failed calendar reads, freeBusy-only shares
invisible to `list_calendars`, ambiguous all-day/free-busy semantics.
