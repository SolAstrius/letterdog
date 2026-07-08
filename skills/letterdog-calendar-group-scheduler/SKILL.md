---
name: letterdog-calendar-group-scheduler
description: "Schedule groups with Letterdog availability data — the user's personal self-hosted mail/calendar/contacts (JMAP), not Google Calendar. Use when the user wants candidate meeting times, attendee or room availability checks, conflict ranking, temporary holds, or multi-participant event creation."
---

# Letterdog Calendar Group Scheduler

Tool mechanics, confirmation flow, and CLI routing live in the `letterdog-calendar` skill. This
skill covers only the group-scheduling workflow.

## Resolve Participants

Turn relative ranges into exact windows. Resolve people with `search_people` — it returns emails,
`calendar_address` (use for invite participants), and principal ids (use for availability). Use
`whoami` when the sender/organizer identity matters (it lists the user's participant identities).
For rooms and resources, try `search_people` with `include_principals` first; if none are exposed,
inspect prior events via `search_events` for locations or participant records — do not assume a
dedicated room directory exists.

## Check Availability

Call `get_availability` with all known `principal_ids` and/or `addresses` (mailto:…), a UTC window
(`utc_start`/`utc_end`, Z-suffixed), and `show_details: true` only when ranking needs named
conflicts. Busy-period status precedence is confirmed > unavailable > tentative. Remember
`search_events` only sees the user's own calendars — availability is the ground truth for others.

Rank candidate slots by:

- Required-attendee availability.
- Optional-attendee conflicts.
- Room/resource availability, if known.
- Timezone reasonableness for all participants.
- Existing calendar load and travel/transition buffers.

Offer a small ranked set of slots rather than a long raw list.

## Draft Or Create The Meeting

Before creating, present title, start/duration/timezone, calendar, attendees (as resolved calendar
addresses), room/location, description, recurrence, alerts, and whether invitations will be sent.
Create with `create_events`: participants keyed with roles, `send_invitations: true` when the
meeting should invite/notify participants (false creates silently — pick deliberately); `is_draft`
for a stageable draft. Under stricter server policies an inviting create may return a
`confirm_token` challenge — show the preview and repeat the identical call with the token after the
user confirms.

For holds that become real meetings, `update_event` on the hold: add participants, then
`send_updates: true` so attendees are notified, preserving existing fields unless the user changes
them.
