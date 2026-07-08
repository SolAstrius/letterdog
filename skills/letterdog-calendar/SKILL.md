---
name: letterdog-calendar
description: "Letterdog — the user's personal self-hosted mail/calendar/contacts (JMAP/JSCalendar), not Google Calendar. Use when inspecting calendars/events, checking availability, creating or updating events, editing recurring series or single occurrences, RSVP-ing, or making safe calendar changes on the user's own server."
---

# Letterdog Calendar

## Tool Surface

MCP tools for calendar: `whoami`, `list_calendars`, `search_events`, `read_events`, `create_events`,
`update_event`, `delete_events`, `respond_to_event`, `get_availability`, `search_people`, and the
escape hatch `jmap_call`. If these are missing, report that the Letterdog MCP server is not
connected before trying another surface.

Conventions that apply everywhere:

- Batch-first: `read_events`/`delete_events`/`create_events` take arrays; one call, many ids.
  `update_event` and `respond_to_event` are deliberately singular (one patch, one target).
- Every list/read returns `{items, failed?, not_found?, state?}`; per-item problems land in `failed`
  — check it instead of assuming all-or-nothing.
- `projection: "brief" | "full" | "raw"` (default brief) + `fields: [...]` on every read. Brief
  events carry title, start, computed end, time_zone, calendar name, location, participant count +
  own status, recurring flag.
- `whoami` first when the RSVP/invite identity or default calendar matters; it returns the
  participant identities (calendar addresses) and default calendar.
- Turn relative dates (today, next week) into concrete windows before querying, and state the
  timezone used.

## Time Semantics (search_events)

Time bounds are LocalDateTime (NO `Z` suffix) interpreted in the `time_zone` arg (default Etc/UTC).
Overlap semantics: `after` is compared against each event's END, `before` against its START — an
event straddling the window boundary is still returned. `in_calendar` scopes to one calendar;
`text`/`title`/`location` filter content.

## Recurrence: Occurrences And Series

There is NO scope/updateScope/destroyScope parameter — it never existed. Occurrence addressing works
through synthetic instance ids:

- `search_events` with `expand: true` — REQUIRES both `after` and `before` bounds — expands
  recurring events into individual occurrences, each with a synthetic per-instance id,
  `base_event_id`, and `utcStart`/`utcEnd`.
- A synthetic instance id passed to `read_events` / `update_event` / `delete_events` addresses just
  that one occurrence: update records a recurrenceOverride; delete excludes the occurrence (the rest
  of the series remains).
- A base event id addresses the whole series: update changes every occurrence; delete destroys the
  event entirely.
- This-and-future = the split-series pattern: truncate the original series (`update_event` on the
  base id, patching the recurrence rule's `until` to just before the split point), then
  `create_events` a new event starting at the split point with the changed properties.
- `respond_to_event` takes `occurrence_id` (a LocalDateTime recurrence id) to RSVP to a single
  occurrence.

Always state which scope an edit hits (one occurrence vs whole series) before mutating.

## Availability And People

`get_availability` over a UTC window (`utc_start`/`utc_end`, `Z`-suffixed) for `addresses`
(mailto:…) and/or `principal_ids`. Returns normalized busy periods `{start, end, status}` with
precedence confirmed > unavailable > tentative; `show_details` attaches events when rights allow.
Use it before proposing slots — `search_events` only sees the user's own calendars, and
freeBusy-only shares are invisible in `list_calendars` ("not listed" does not mean "free").

`search_people` resolves names/emails across contacts AND schedulable principals; use the returned
`calendar_address` for participants and RSVPs, and `principal_ids` for availability.

## Mutations

- `create_events`: typed JSCalendar bodies (title, `start` LocalDateTime + `timeZone`, `duration`,
  participants, recurrenceRules, alerts). `send_invitations` (default false) controls iTIP both
  ways: true emails every participant an invitation; false creates silently — pick deliberately.
  `is_draft` stages with no scheduling side effects.
- `update_event`: convenience fields (title/start/duration/time_zone/location/description/status)
  and/or a raw JSCalendar `patch` (JSON-Pointer keys, null removes). `send_updates` emails
  participants — without it, scheduled attendees silently desync; set it whenever attendees exist
  and the change is visible to them.
- `delete_events`: `send_cancellations` for iTIP CANCEL. Destructive — always two-phase.
- `respond_to_event`: status accepted/declined/tentative; matches the user's own participant entry
  via their ParticipantIdentity calendarAddress. `notify_organizer` defaults true (iTIP REPLY).
  There is no counter-proposal mechanism.

## Confirmation

Most actions run directly: event create/update without invitations or updates to attendees, drafts,
holds, RSVPs under the personal policy. Do not ask ritual confirmation for these.

Only these are two-phase: `delete_events` (always), deleting a calendar that still has events (CLI),
share/ACL changes (CLI), admin/sieve (CLI), raw JMAP mutations (`jmap_call` with `allow_mutation`),
and query-powered bulk over 100 items. Two-phase means the tool returns
`confirmation_required: true` + `confirm_token` + a brief preview instead of executing; show the
preview, then repeat the IDENTICAL call with `confirm_token` added. Outward scheduling messages
(invitations, update/cancel notices, RSVP replies) may return the same challenge under stricter
server policies — handle it identically. Never invent or persist tokens.

## MCP vs CLI Routing

Use the MCP tools for reading, scheduling, RSVPs, and event edits. Drop to the CLI binary
`letterdog` via Bash when the task involves:

- local files (export/import, saving raw data to disk);
- more than ~20 mutations (pipelines);
- raw iCalendar fidelity (CalDAV: `letterdog dav get|put|delete …`, ETag-guarded);
- calendar management (create/update/delete/share/set-default: `letterdog calendar …`),
  participant-identity management (`letterdog calendar identity_set`), alerts/notifications
  (`letterdog alert ack|snooze`, `letterdog notify list|dismiss`), admin settings, sync primitives;
- anything the MCP surface doesn't wrap.

CLI auth comes from `STALWART_BEARER` in the environment (launchctl-set on this machine). Shape:
`letterdog <group> <command> [flags] [ids…|-]` — trailing ids pipeable via stdin (`-`), `--json`
NDJSON output for lists (`--json=full|raw` for deeper projections), `--dry-run` to preview a gated
op and get its confirm token, `--yes` for outward sends, `--confirm <token>` for destructive/blast.
During development invoke it as `deno task cli -- <group> <command> …` from the repo. Calendar
groups: `calendar` (list/availability/create/update/delete/share/identity_set), `event`
(search/read/create/update/delete/rsvp), `people`, `contact`, `alert`, `notify`, `dav`. `--help` on
any command lists real flags.

```sh
letterdog event search --after 2026-07-08T00:00:00 --before 2026-07-15T00:00:00 \
  --time-zone Europe/Berlin --expand --json
letterdog calendar availability --addresses mailto:x@y.example \
  --utc-start 2026-07-08T00:00:00Z --utc-end 2026-07-09T00:00:00Z
letterdog dav get ...        # raw iCalendar source when byte fidelity matters
```

## Escape Hatch

`jmap_call` runs arbitrary JMAP `[method, args, callId]` triples with `#`-back-reference chaining;
read-only by default, mutations need `allow_mutation: true` + two-phase confirmation. Prefer the
typed tools.

## Response Style

Separate observed calendar facts from recommendations. For proposed writes, state the target
calendar/event id, timezone, whether the target is one occurrence or the whole series, the
attendee-visible effects, and whether scheduling messages (invitations/updates/cancellations) will
be sent.
