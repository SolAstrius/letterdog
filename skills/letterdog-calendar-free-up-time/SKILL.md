---
name: letterdog-calendar-free-up-time
description: "Find practical ways to open time in Letterdog — the user's personal self-hosted mail/calendar/contacts (JMAP), not Google Calendar. Use when the user wants to clear a day, make a focus block, identify movable meetings, create holds, or draft safe reschedules."
---

# Letterdog Calendar Free Up Time

Tool mechanics, confirmation flow, recurrence/occurrence addressing, and CLI routing live in the
`letterdog-calendar` skill. This skill covers only the free-up-time workflow.

## Build The Baseline

Resolve the target date or range to concrete local times. Read the window with `search_events`
(`after`/`before` LocalDateTime + `time_zone`, `expand: true` so recurring events show their actual
occurrences with synthetic instance ids). Use `read_events` for participant/organizer detail before
judging what can move, and `get_availability` when other people or candidate replacement slots are
involved.

## Classify Time

Classify events conservatively:

- Fixed: externally organized meetings, travel, paid/customer commitments, accepted group meetings,
  hard appointments, events the user marked non-movable.
- Candidate movable: solo blocks, tentative events, free/transparent events, internally organized
  meetings, loose holds, duplicated reminders, events with flexible wording.
- Unknown: recurring series, events with missing organizer/participant data, unclear free/busy.

Do not propose moving or deleting externally organized meetings as the main plan unless the user
explicitly asks for aggressive changes.

## Propose And Execute

Prefer the smallest set of changes that creates the requested free block. Show before/after timing,
affected event ids, whether each change hits one occurrence (synthetic instance id) or the whole
series (base id), attendee-visible effects, and whether scheduling messages will be sent.

- Holds: `create_events` with `send_invitations: false` (the default) — runs directly.
- Reschedules: `update_event` with a minimal patch; target the synthetic instance id to move just
  one occurrence. Set `send_updates: true` whenever attendees must learn of the change.
- Cancellations: `delete_events` with explicit ids (instance id = skip one occurrence); always
  two-phase — present the preview, then repeat with `confirm_token`. `send_cancellations` notifies
  attendees.

Never run broad query-based deletion: search/read first, then pass explicit ids. If server state
changed between read and write, reread and rebuild the plan rather than forcing stale changes.
