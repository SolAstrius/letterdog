---
name: stalwart-calendar-free-up-time
description: "Find practical ways to open time in Stalwart calendars. Use when the user wants to clear a day, make a focus block, identify movable meetings, create holds, or draft safe reschedules using Stalwart MCP calendar and availability tools."
---

# Stalwart Calendar Free Up Time

## Build The Baseline

Resolve the target date or range to concrete local times. Read the relevant calendars with
`calendar_list` if the user did not specify them.

Use `calendar_event_search` with a bounded `time_min` and `time_max`, `fetch: true`, and no
`properties` filter. Fetch complete event objects before judging what can move.

Use `availability_get` when other people, rooms, or candidate replacement slots are involved.

## Classify Time

Classify events conservatively:

- Fixed: externally organized meetings, travel, paid/customer commitments, accepted group meetings,
  hard appointments, or events the user marked non-movable.
- Candidate movable: solo blocks, tentative events, transparent/free events, internally organized
  meetings, loose holds, duplicated reminders, and events with flexible wording.
- Unknown: recurring series, events with missing organizer/participant data, or events with unclear
  free/busy status.

Do not propose moving or deleting externally organized meetings as the main plan unless the user
explicitly asks for aggressive changes.

## Propose Options

Prefer the smallest set of changes that creates the requested free block. Show before/after timing,
affected event ids, attendee-visible effects, and whether each step needs scheduling messages.

For holds, use `calendar_event_create` with a JSCalendar event in the target calendar and
`sendSchedulingMessages: false` unless the hold invites someone else.

For reschedules, use `calendar_event_update` with a minimal patch and explicit `update_scope` for
recurring events. For cancellations, use `calendar_event_delete` with explicit ids and scope.

## Execute Safely

Ordinary hold creation executes directly. Reschedules, cancellations, recurring-event changes, and
scheduling-message sends may return a preview with `confirmFingerprint` and `expiresAt`. Present the
preview; execute only after the user confirms, by repeating the same call with `confirmFingerprint`
and `confirmExpiresAt` set to the returned `expiresAt`.

Use `if_in_state` when available. If state changed between read and write, reread and rebuild the
plan rather than forcing stale changes.

Never run broad query-based deletion. Search/read first, then pass explicit ids to mutation tools.
