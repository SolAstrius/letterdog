---
name: stalwart-calendar-group-scheduler
description: "Schedule groups with Stalwart calendar availability. Use when the user wants candidate meeting times, attendee or room availability checks, conflict ranking, temporary holds, or event creation for multiple participants through Stalwart MCP tools."
---

# Stalwart Calendar Group Scheduler

## Resolve Participants

Turn relative ranges into exact local windows. Resolve people with `principal_search` by
`calendar_address` or text when possible; set `fetch: true` when you need names, addresses, or
resource metadata. If you already have addresses, `availability_get` can resolve
`calendar_addresses` directly.

Use `participant_identity_list` when the sender identity matters for invitations.

For rooms and resources, try `principal_search` first. If no room/resource principals are exposed,
inspect prior events with `calendar_event_search` for locations or participant records; do not
assume a dedicated room directory exists.

## Check Availability

Call `availability_get` with all known `principal_ids` or `calendar_addresses`, `utc_start`,
`utc_end`, and `show_details: true` when ranking conflicts. Request detailed event properties only
when the user needs named conflicts.

Rank candidate slots by:

- Required-attendee availability.
- Optional-attendee conflicts.
- Room/resource availability, if known.
- Timezone reasonableness.
- Existing user calendar load and travel buffers.

Offer a small ranked set of slots rather than a long raw list.

## Draft Or Create The Meeting

Before creating, present the proposed title, start/end, timezone, calendar id, attendees,
room/location, description, recurrence, reminders, and scheduling-message behavior.

Use `calendar_event_create` with a complete JSCalendar event. Set `sendSchedulingMessages: true`
when the meeting should invite or notify participants.

If the create call returns a confirmation preview, show it and wait for explicit confirmation before
repeating the call with `confirmFingerprint` and `confirmExpiresAt` set to the returned `expiresAt`.

Use `calendar_event_update` for holds that become real meetings, preserving existing fields unless
the user explicitly changes them.
