---
name: stalwart-calendar
description: "Manage Stalwart calendar workflows through the repo's MCP tools. Use when inspecting calendars/events, checking availability, creating or updating JSCalendar events, RSVP-ing, handling alerts, reading raw iCalendar through CalDAV, or making safe calendar changes with bearer-backed Stalwart JMAP."
---

# Stalwart Calendar

## Core Flow

Use the Stalwart MCP tools when they are available. If the expected tools are missing, report that
the Stalwart MCP server is not registered or not connected before trying another surface.

For HTTP MCP, expect the server to reject calls without `Authorization: Bearer <token>`. Do not ask
for or handle a separate MCP secret for normal tool use.

Start with `stalwart_session_info` when the account, capabilities, or backend URL matter. Use
explicit `account_id` only when the user gives one or the session exposes multiple plausible
accounts; otherwise let the tools resolve the account from the bearer-backed JMAP session.

Prefer bounded reads. Always turn relative dates such as today, tomorrow, or next week into concrete
local date/time windows before querying.

## Calendar And Event Reads

List calendars with `calendar_list`. Include user-supplied calendar filters when relevant, and use
`calendar_get` for specific ids.

Search events with `calendar_event_search` using `calendar_ids`, `time_min`, `time_max`, `query`,
`limit`, or a structured `filter` when needed. `fetch` defaults to true.

For complete event information, omit `properties` on `calendar_event_search`, `calendar_event_get`,
or `calendar_event_batch_get`. This returns the full JSCalendar event object exposed by Stalwart.
For search responses, read events from `get.list`. Do not look for a separate full-event alias.

Use `calendar_event_get` for one known event id and `calendar_event_batch_get` for a set of ids. Use
`fetch: false` only when ids/states are enough.

Use `calendar_event_changes` and `calendar_event_query_changes` for sync-style follow-up work rather
than polling broad date ranges.

## Availability And People

Use `availability_get` for free/busy checks when you have `calendar_addresses` or `principal_ids`.
Set `utc_start` and `utc_end` explicitly, and use `show_details` only when the user needs conflict
details.

Use `principal_search` and `principal_get` to resolve people, groups, or room-like principals.
`principal_search` defaults to ids only; set `fetch: true` when names, addresses, or other principal
fields matter. Do not assume a separate room directory exists unless `principal_search` reveals one.

Use `participant_identity_list` to determine which identity the caller can RSVP or invite as. Use
`participant_identity_set_default` only when the user explicitly asks to change their default
identity.

## Mutations

Use the typed mutation tools before `jmap_call`:

- `calendar_event_create` for one new JSCalendar event.
- `calendar_event_batch_create` for multiple new JSCalendar events in one JMAP call.
- `calendar_event_update` for patches to one event.
- `calendar_event_delete` for destroys.
- `calendar_event_copy` for copy/move-like workflows.
- `calendar_event_respond` for RSVP changes.
- `calendar_create`, `calendar_update`, `calendar_delete`, `calendar_set_default`,
  `calendar_subscribe`, and `calendar_share` for calendar-level changes.

For recurring events, always choose and state the scope: `this`, `future`, or `all`. Do not silently
apply a series-wide update.

For scheduling-visible changes, set `sendSchedulingMessages` deliberately. Default to avoiding
messages for private drafts and holds; send messages when the user is inviting, rescheduling,
cancelling, or RSVP-ing with attendees who should be notified.

Ordinary event creation executes directly. Mutations that delete, update, copy, RSVP, change
calendar-level settings, or send scheduling messages may return a preview with `confirmFingerprint`
and `expiresAt` instead of executing. Present the preview and, when the user confirms, call the same
tool again with the same arguments plus `confirmFingerprint` and `confirmExpiresAt` set to the
returned `expiresAt`. Do not invent, inspect, or persist any confirmation secret.

Use `if_in_state` when the tool response or prior read gives a usable state token.

## Alerts, Notifications, And Attachments

Use `event_notification_list` for event-change notifications and `event_notification_dismiss` only
after an explicit dismiss request.

Use `alert_acknowledge` and `alert_snooze` for alert state. For creating or editing reminders, patch
the event's JSCalendar `alerts` with `calendar_event_update`.

Read attachment/blob metadata from the full event object first. Use `blob_get`, `blob_lookup`,
`file_node_get`, or `file_node_list` only when the event references blobs or file nodes that need
separate metadata/download URLs. Use `blob_upload` for base64 uploads, then attach or link the
resulting blob through a separate event/file mutation if needed.

## Raw Source And Escape Hatches

Use CalDAV only when raw iCalendar source, ETags, hrefs, or server DAV metadata matter:

- `caldav_discover`
- `caldav_calendar_list`
- `caldav_calendar_resources`
- `caldav_event_search`
- `caldav_event_get_raw`
- `caldav_event_multiget_raw`
- `caldav_propfind`
- `caldav_event_put_raw`
- `caldav_event_delete_raw`

Use `icalendar_parse` to convert raw iCalendar text or blobs into JSCalendar where helpful.

For raw CalDAV writes, use `if_match` or `if_none_match_star` when possible and follow the same
confirmation flow as JMAP mutations. Prefer structured JMAP event tools unless raw iCalendar
fidelity is the point of the task.

Use `calendar_server_settings_get` and `calendar_server_settings_update` only for Stalwart
server/admin calendar settings, not user calendar data. Admin updates require
`ENABLE_ADMIN_TOOLS=true` on the server and confirmation.

Use `jmap_call` only for temporary gaps or diagnostics. It is read-only by default; mutating raw
calls require `allow_mutation` and the same confirmation flow as typed tools.

## Response Style

Separate observed calendar facts from recommendations. For proposed writes, include the target
calendar/event id, time zone, attendee-visible effects, recurrence scope, and whether scheduling
messages will be sent.
