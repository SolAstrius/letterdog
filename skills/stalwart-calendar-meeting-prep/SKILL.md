---
name: stalwart-calendar-meeting-prep
description: "Prepare for meetings from Stalwart calendar events. Use when the user asks what a meeting is about, what to read, who is attending, what links or attachments matter, or for a concise prep brief based on Stalwart MCP calendar data."
---

# Stalwart Calendar Meeting Prep

## Find The Event

If the user gives an event id, call `calendar_event_get` without `properties`. Otherwise search a
bounded window with `calendar_event_search`, `fetch: true`, and no `properties` filter. Use the
user's words as `query` when matching by title or description, then read candidate events from
`get.list`.

When multiple events match, disambiguate by time, title, organizer, and calendar before doing deeper
work.

## Read Context

Use the complete JSCalendar event object as the primary source. Inspect title, description,
start/end, timezone, location, links, participants, organizer, recurrence, alerts, status, and
attachments.

Use `blob_get`, `blob_lookup`, `file_node_get`, or `file_node_list` only when the event references
blobs or file nodes that need metadata or download URLs.

Use `caldav_event_get_raw` only when raw iCalendar fields, hrefs, ETags, or source fidelity matter.
If raw iCalendar is easier to reason about after fetching, pass it to `icalendar_parse`.

Search adjacent calendar context only when useful: nearby events with the same participants,
repeated titles, project names, or locations.

## Prep Brief

Keep the output practical:

- Confirmed meeting facts: time, timezone, organizer, attendees, location/link.
- Likely purpose from title, description, recurrence, and nearby context.
- Materials and links to review.
- Decisions or questions to bring.
- Risks: missing description, missing attachments, ambiguous participant identity, or
  stale/conflicting calendar data.

Do not fabricate agenda details. Label inferences as inferences.
