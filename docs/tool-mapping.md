# Stalwart MCP Tool Mapping

This document maps the public MCP tool surface for the Stalwart JMAP MCP server to the underlying
Stalwart APIs.

The connector is JMAP-first:

- JMAP is the primary structured API for mail, mailboxes, identities, submissions, calendars,
  events, principals, participant identities, notifications, blobs, and files.
- CalDAV is used when the caller explicitly needs raw iCalendar source data, CalDAV discovery, or
  CalDAV resource metadata.
- Stalwart `x:*` JMAP methods are used only for server/admin configuration, not normal user calendar
  data.
- The raw `jmap_call` escape hatch is read-only by default and must not be the normal path for
  user-facing workflows.

## Auth And Account Resolution

Every tool runs as the caller represented by its HTTP authorization value. The HTTP MCP server must
read:

```text
Authorization: Bearer <token>
```

Bearer is the normal deployed shape, but the authorization value is passed through unchanged so
local or direct Stalwart Basic auth can be used for diagnostics. The server then resolves the live
Stalwart session:

```text
GET /jmap/session
Authorization: <same value supplied to MCP>
```

The session response supplies:

- JMAP API URL, normally `/jmap/`.
- Upload and download URL templates.
- Available capabilities.
- Available accounts.
- Primary account IDs per capability.

Tools must not hardcode account id `b`. They should resolve an account in this order:

1. Use explicit `account_id` if the tool accepts one and the caller supplied it.
2. Use the session `primaryAccounts` entry for the capability the tool needs.
3. Fall back to the first account advertising the required capability.
4. Fail with a clear capability/account error if no account supports the tool.

Authorization values must never be logged or persisted. Logs may include a stable fingerprint
derived with the confirmation secret, but never the raw credential.

## Session And Profile Tools

| MCP Tool                   | Underlying Calls                                 | Notes                                                                                                  |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `stalwart_session_info`    | `GET /jmap/session`, optional `GET /api/account` | Returns capabilities, account IDs, API/upload/download URLs, and optional edition/permissions summary. |
| `stalwart_account_resolve` | `GET /jmap/session`                              | Resolves the account id that would be used for a requested capability.                                 |

## Mail And Gmail-Like Tools

The mail tools expose Gmail-like typed operations while using JMAP Mail, Submission, and Blob
internally. Mailboxes are the default user-visible label model; keywords are used for flags and
lightweight tags such as `$seen`, `$flagged`, `$draft`, `$Important`, and `$Forwarded`.

| MCP Tool                     | Underlying Calls                                 | Notes                                                                                                                      |
| ---------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `get_mail_profile`           | Session document, `Identity/get`                 | Returns username when present, account capability data, primary mail/submission accounts, and send identities.             |
| `list_mailboxes`             | `Mailbox/get ids:null`                           | Lists mailboxes/labels, including roles and counts when requested.                                                         |
| `search_email_ids`           | `Mailbox/get` as needed, `Email/query`           | Translates a known Gmail-query subset to JMAP filters and returns unsupported operators explicitly.                        |
| `search_emails`              | `Email/query` -> `Email/get` with result refs    | Fetches matching messages in one JMAP batch.                                                                               |
| `read_email`                 | `Email/get`, optional download URL               | Reads parsed email data; raw MIME is downloaded from the Email `blobId` when requested.                                    |
| `batch_read_emails`          | chunked `Email/get`                              | Reads explicit message ids in batches.                                                                                     |
| `read_email_thread`          | `Email/get` if needed, `Thread/get`, `Email/get` | Reads a thread by message id or thread id.                                                                                 |
| `batch_read_email_threads`   | `Thread/get`, `Email/get`                        | Deduplicates message ids across threads before fetching.                                                                   |
| `read_attachment`            | `Email/get`, download URL                        | Verifies the requested blob/part belongs to the email, then returns base64 or text with byte limits.                       |
| `create_draft_email`         | `Email/set create`                               | Creates a normal Email in Drafts with `$draft`; executes directly because it does not send mail.                           |
| `update_draft_email`         | `Email/get`, `Email/set create + destroy`        | Replaces draft content by creating a new draft and destroying the old draft; executes directly because it remains a draft. |
| `list_draft_emails`          | `Email/query`, `Email/get`                       | Searches `$draft` and the Drafts-role mailbox when available.                                                              |
| `send_draft_email`           | `Identity/get`, `EmailSubmission/set`            | Sends an existing draft and moves it to Sent via `onSuccessUpdateEmail`; send confirmation required.                       |
| `send_email`                 | `Email/set create`, `EmailSubmission/set`        | Creates a draft Email and submits it in one JMAP batch using back-references; send confirmation required.                  |
| `forward_emails`             | `Email/get`, `Email/set`, `EmailSubmission/set`  | Builds quoted or original-message-attached forwards and marks originals with `$Forwarded`; send confirmation required.     |
| `archive_emails`             | `Email/get`, `Email/set update`                  | Removes Inbox and optionally adds Archive. Never destroys mail, so explicit-id archives execute directly.                  |
| `delete_emails`              | `Email/set update` or `Email/set destroy`        | Trash is the default; permanent destroy requires `permanent: true` and confirmation.                                       |
| `create_mail_label`          | `Mailbox/set create`                             | Creates a mailbox-backed label; executes directly.                                                                         |
| `batch_modify_emails`        | `Email/set update` or `Email/set destroy`        | Additive keyword/mailbox changes execute directly; trash, permanent delete, and mailbox removals require confirmation.     |
| `apply_mail_labels`          | `Email/set update`                               | Adds mailbox labels or keyword tags without removing existing mailbox membership; executes directly for explicit ids.      |
| `bulk_label_matching_emails` | `Email/query`, chunked `Email/set update`        | Collects matching ids before mutation. Defaults to `dry_run: true`; mutating calls require confirmation.                   |

Supported Gmail-style search mappings include `from:`, `to:`, `cc:`, `bcc:`, `subject:`, `body:`,
`text:`, `has:attachment`, `is:read`, `is:unread`, `is:starred`, `is:draft`, `is:important`,
`is:answered`, `is:forwarded`, `in:`, `label:`, `after:`, `before:`, `larger:`, `smaller:`, and
simple free text. Unsupported operators such as Gmail categories and filename search are returned in
the `unsupported` array rather than silently treated as equivalent.

## Calendar Tools

| MCP Tool               | Underlying Calls                             | Notes                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_list`        | `Calendar/query` -> `Calendar/get`           | Lists calendars visible to the account. Include `isSubscribed`, `isVisible`, `includeInAvailability`, `shareWith`, and `myRights` when available.                                                   |
| `calendar_get`         | `Calendar/get`                               | Reads one or more calendars by id.                                                                                                                                                                  |
| `calendar_create`      | `Calendar/set create`                        | Creates a calendar. Executes directly.                                                                                                                                                              |
| `calendar_update`      | `Calendar/set update`                        | Updates mutable calendar fields such as `name`, `description`, `color`, `timeZone`, `sortOrder`, `isVisible`, and `includeInAvailability`. Executes directly unless using a broader raw/admin path. |
| `calendar_delete`      | `Calendar/set destroy`                       | Deletes a calendar. Destructive; confirmation required. If events would be destroyed, require an explicit `destroy_events` style argument.                                                          |
| `calendar_set_default` | `Calendar/set` with default-calendar option  | Sets the default calendar for the account. Executes directly.                                                                                                                                       |
| `calendar_subscribe`   | `Calendar/set update isSubscribed/isVisible` | Subscribes, unsubscribes, shows, or hides a calendar for the current user. Executes directly.                                                                                                       |
| `calendar_share`       | `Calendar/set update shareWith`              | Updates calendar sharing ACLs. Mutating and potentially broad; confirmation required.                                                                                                               |
| `calendar_changes`     | `Calendar/changes`                           | Sync primitive for calendar collection changes since a known state.                                                                                                                                 |

## Event Tools

| MCP Tool                       | Underlying Calls                                                                         | Notes                                                                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calendar_event_search`        | `CalendarEvent/query` -> optional `CalendarEvent/get`                                    | Searches by `inCalendar`, `after`, `before`, `text`, `title`, `description`, `location`, `owner`, `attendee`, or `uid`. May use `expandRecurrences` when the filter includes a bounded time range. |
| `calendar_event_get`           | `CalendarEvent/get`                                                                      | Reads one event by id.                                                                                                                                                                             |
| `calendar_event_batch_get`     | `CalendarEvent/get`                                                                      | Reads multiple events by id in one JMAP call.                                                                                                                                                      |
| `calendar_event_create`        | `CalendarEvent/set create`                                                               | Creates one JSCalendar event. Ordinary event creation executes directly; confirmation is required only when sending scheduling messages.                                                           |
| `calendar_event_batch_create`  | `CalendarEvent/set create`                                                               | Creates multiple JSCalendar events in one JMAP call. Ordinary event creation executes directly; confirmation is required only when sending scheduling messages.                                    |
| `calendar_event_update`        | `CalendarEvent/set update`                                                               | Updates an event patch. Ordinary single-event updates execute directly; scheduling-message sends and `future`/`all` recurrence scopes require confirmation.                                        |
| `calendar_event_delete`        | `CalendarEvent/set destroy`                                                              | Deletes an event or recurrence instance. Destructive; confirmation required.                                                                                                                       |
| `calendar_event_copy`          | `CalendarEvent/copy`                                                                     | Copies an event between accounts/calendars. Executes directly.                                                                                                                                     |
| `calendar_event_changes`       | `CalendarEvent/changes`                                                                  | Sync primitive for stored event changes since a known state.                                                                                                                                       |
| `calendar_event_query_changes` | `CalendarEvent/queryChanges`                                                             | Sync primitive for changes to a query result since a known query state.                                                                                                                            |
| `calendar_event_respond`       | `CalendarEvent/get` -> `ParticipantIdentity/get` if needed -> `CalendarEvent/set update` | Updates the caller's participant status. Mutating; confirmation required when it sends scheduling messages or changes an externally visible RSVP.                                                  |

## Principal, Availability, And Participant Identity Tools

| MCP Tool                           | Underlying Calls                                                        | Notes                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `participant_identity_list`        | `ParticipantIdentity/get`                                               | Lists identities the current user may use as calendar participants.                               |
| `participant_identity_create`      | `ParticipantIdentity/set create`                                        | Creates a participant identity. Executes directly.                                                |
| `participant_identity_update`      | `ParticipantIdentity/set update`                                        | Updates a participant identity. Executes directly.                                                |
| `participant_identity_delete`      | `ParticipantIdentity/set destroy`                                       | Deletes a participant identity. Destructive; confirmation required.                               |
| `participant_identity_set_default` | `ParticipantIdentity/set` default identity option                       | Changes the default participant identity. Executes directly.                                      |
| `participant_identity_changes`     | `ParticipantIdentity/changes`                                           | Sync primitive for identity changes since a known state.                                          |
| `principal_search`                 | `Principal/query`                                                       | Searches principals by text or `calendarAddress` when supported.                                  |
| `principal_get`                    | `Principal/get`                                                         | Reads principals by id.                                                                           |
| `principal_availability_get`       | `Principal/getAvailability`                                             | Gets availability for one principal over a bounded UTC interval.                                  |
| `availability_get`                 | `Principal/query` if resolving addresses -> `Principal/getAvailability` | Resolves calendar addresses to principals when needed, then gets availability for each principal. |

## Notification And Alert Tools

| MCP Tool                           | Underlying Calls                                                        | Notes                                                        |
| ---------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `event_notification_list`          | `CalendarEventNotification/query` -> `CalendarEventNotification/get`    | Lists event-change notifications.                            |
| `event_notification_dismiss`       | `CalendarEventNotification/set destroy`                                 | Dismisses notifications. Executes directly.                  |
| `event_notification_changes`       | `CalendarEventNotification/changes`                                     | Sync primitive for notification changes since a known state. |
| `event_notification_query_changes` | `CalendarEventNotification/queryChanges`                                | Sync primitive for changes to a notification query result.   |
| `alert_acknowledge`                | `CalendarEvent/get` -> `CalendarEvent/set update alerts.*.acknowledged` | Acknowledges/dismisses an event alert. Executes directly.    |
| `alert_snooze`                     | `CalendarEvent/get` -> `CalendarEvent/set update alerts/relatedTo`      | Adds or updates a snoozed alert relation. Executes directly. |

## Raw iCalendar, CalDAV, Blob, And File Tools

| MCP Tool                    | Underlying Calls                                                                           | Notes                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `icalendar_parse`           | `CalendarEvent/parse`                                                                      | Parses uploaded iCalendar blobs into JSCalendar event objects.                                                               |
| `caldav_discover`           | `/.well-known/caldav` -> `PROPFIND current-user-principal` -> `PROPFIND calendar-home-set` | Discovers CalDAV principal, scheduling inbox/outbox, and calendar home.                                                      |
| `caldav_calendar_resources` | `PROPFIND Depth: 1` on calendar collection                                                 | Lists raw calendar resource hrefs, etags, content types, and lengths.                                                        |
| `caldav_event_get_raw`      | CalDAV `GET` resource href                                                                 | Returns raw `text/calendar` for one CalDAV resource.                                                                         |
| `caldav_event_multiget_raw` | CalDAV `REPORT calendar-multiget`                                                          | Returns raw `calendar-data` for selected resource hrefs.                                                                     |
| `blob_lookup`               | `Blob/lookup`                                                                              | Finds blob ids associated with supported JMAP data type/object ids.                                                          |
| `blob_get`                  | `Blob/get`, download URL from JMAP session                                                 | Gets blob metadata and, when requested, downloads bytes through the session download URL.                                    |
| `blob_copy`                 | `Blob/copy`                                                                                | Copies blobs between accounts. Mutating; confirmation required when copying into another account.                            |
| `blob_upload`               | upload URL from JMAP session                                                               | Uploads bytes to the account. Mutating; confirmation required when attaching or linking the uploaded blob to another object. |
| `file_node_list`            | `FileNode/query` -> `FileNode/get`                                                         | Lists files/folders from the JMAP file node capability.                                                                      |
| `file_node_get`             | `FileNode/get`                                                                             | Reads file node metadata by id.                                                                                              |

CalDAV path handling must be strict:

- Only use server-relative paths returned by CalDAV discovery or previous DAV responses.
- Reject paths containing `..`.
- Reject absolute external URLs.
- Reject cross-origin redirects.

## Admin And Server Settings Tools

| MCP Tool                          | Underlying Calls                                                    | Notes                                                                                            |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `calendar_server_settings_get`    | `x:Calendar/get`, `x:CalendarAlarm/get`, `x:CalendarScheduling/get` | Reads Stalwart server-level calendar, alarm, and scheduling settings. Admin-only.                |
| `calendar_server_settings_update` | `x:Calendar/set`, `x:CalendarAlarm/set`, `x:CalendarScheduling/set` | Updates Stalwart server-level calendar settings. Admin-only; confirmation required.              |
| `jmap_call`                       | raw POST to `/jmap/`, read-only by default                          | Escape hatch for unsupported methods. Mutating methods require explicit opt-in and confirmation. |

The `x:*` namespace is server/admin configuration. It is not the user's calendar collection. For
example, `x:Calendar/get` reads server defaults and limits, while `Calendar/get` reads user
calendars.

## Raw JMAP Escape Hatch Rules

`jmap_call` accepts raw JMAP method calls for diagnostics and temporary gaps in the typed tool
surface. It must classify methods before execution:

- Read-only by default: `*/get`, `*/query`, `*/changes`, `*/queryChanges`, `Core/echo`, and selected
  parse/lookup methods.
- Mutating methods require `allow_mutation: true`.
- Mutating methods require the same confirmation flow as typed tools.
- The caller must supply `using` capabilities explicitly, or the server may add only safe defaults
  such as `urn:ietf:params:jmap:core`.

## Destructive Action Safety

All destructive or externally visible actions use a stateless prepare/execute flow.

First call:

- Reads current server state.
- Builds the exact JMAP, CalDAV, or Stalwart management payload.
- Returns affected ids, a concise diff, scheduling-message side effects, and a signed
  `confirmFingerprint`.
- Includes a short expiration time.

Second call:

- Must pass the same user arguments plus `confirmFingerprint`.
- Recomputes the fingerprint from the canonical intent.
- Rechecks state preconditions.
- Executes only if the fingerprint and preconditions still match.

JMAP mutations should use state preconditions where available, such as `ifInState`. CalDAV mutations
should use ETags with `If-Match` where available.

The following actions always require confirmation:

- Destroying calendars, events, identities, mailboxes, files, or blobs.
- Updating calendar sharing ACLs.
- Sending mail or scheduling messages.
- Updating recurring event series or multiple recurrence instances.
- Trashing, permanently deleting, mailbox-removing, or query-powered bulk mail changes.
- Changing Stalwart `x:*` server settings.
- Running mutating raw JMAP calls.

Tools must not support query-powered destructive operations directly. A caller must first
search/read objects, then pass explicit ids into the mutating tool.

## Capability Summary

The connector should expect and prefer these Stalwart/JMAP capabilities when available:

| Capability                                     | Used For                                                       |
| ---------------------------------------------- | -------------------------------------------------------------- |
| `urn:ietf:params:jmap:core`                    | JMAP request/response framing and common types.                |
| `urn:ietf:params:jmap:mail`                    | Email, Thread, and Mailbox search/read/mutation tools.         |
| `urn:ietf:params:jmap:submission`              | Identity and EmailSubmission send workflows.                   |
| `urn:ietf:params:jmap:calendars`               | Calendar, event, participant identity, and notification tools. |
| `urn:ietf:params:jmap:calendars:parse`         | iCalendar parsing through `CalendarEvent/parse`.               |
| `urn:ietf:params:jmap:principals`              | Principal search and reads.                                    |
| `urn:ietf:params:jmap:principals:availability` | `Principal/getAvailability`.                                   |
| `urn:ietf:params:jmap:blob`                    | Blob metadata, copy, lookup, upload/download URL use.          |
| `urn:ietf:params:jmap:filenode`                | File node queries and metadata.                                |
| `urn:stalwart:jmap`                            | Stalwart admin/config `x:*` methods.                           |

If a required capability is missing from the resolved account, the tool must fail before attempting
the underlying method call.
