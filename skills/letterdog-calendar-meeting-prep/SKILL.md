---
name: letterdog-calendar-meeting-prep
description: "Prepare for meetings from Letterdog calendar events — the user's personal self-hosted mail/calendar/contacts (JMAP), not Google Calendar. Use when the user asks what a meeting is about, what to read, who is attending, what links or attachments matter, or for a concise prep brief."
---

# Letterdog Calendar Meeting Prep

Tool mechanics, confirmation flow, and CLI routing live in the `letterdog-calendar` skill. This
skill covers only the prep workflow.

## Find The Event

If the user gives an event id, call `read_events` with that id (base or synthetic instance id;
`projection: "full"` when links/description/participants matter). Otherwise `search_events` over a
bounded window (`after`/`before` LocalDateTime + `time_zone`; `expand: true` when the meeting is a
recurring occurrence), matching the user's words via `title` or `text`, then `read_events` on the
candidates. When multiple events match, disambiguate by time, title, organizer, and calendar before
doing deeper work.

## Read Context

Use the full event object as the primary source: title, description, start/end, timezone, location,
virtual-location links, participants and their statuses, organizer, recurrence, status. Resolve
unfamiliar attendees with `search_people` / `read_contacts`. Related mail is often the real agenda:
`search_emails` for the organizer or subject keywords, `read_thread` for the latest state (mail
tools are documented in `letterdog-mail`). Raw iCalendar fidelity, if it ever matters, routes to the
CLI (`letterdog dav get`). Search adjacent calendar context only when useful: nearby events with the
same participants, repeated titles, project names.

## Prep Brief

Keep the output practical:

- Confirmed meeting facts: time, timezone, organizer, attendees and RSVP states, location/link.
- Likely purpose from title, description, recurrence, and nearby context.
- Materials and links to review.
- Decisions or questions to bring.
- Risks: missing description, ambiguous participant identity, stale or conflicting data.

Do not fabricate agenda details. Label inferences as inferences.
