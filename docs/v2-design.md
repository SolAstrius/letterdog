# v2 Tool Surface Design

Status: draft for review. Grounded in [rfc-notes/](rfc-notes/) (RFC 8620/8621/8984, RFC 9404,
RFC 9670, draft-ietf-jmap-calendars-26) and live probes against Stalwart v0.16.11.

## Why v2

The v1 surface wraps JMAP methods 1:1: typed tool names but untyped payloads (`event: object`,
`patch: object`, `filter: object`), raw JMAP responses (`{query, get}` with `get.list`),
inconsistent arg casing, ~60 tools with no MCP annotations, and two confirmed spec errors
(`updateScope`/`destroyScope` are silently ignored by Stalwart; `before`/`after` mail filters were
never documented as `receivedAt`-based). Skills currently teach around tool warts. v2 designs
verbs for an agent, with schemas and descriptions derived from the specs.

## Design principles

1. **snake_case for tool args; spec-shape camelCase only inside JMAP/JSCalendar object payloads.**
   One convention, stated in every schema description where a payload boundary occurs.
2. **Normalized response envelopes.** Tools never return raw JMAP method responses. Reads return
   `{items: [...], total?, not_found?, state}`. The model never digs in `get.list`.
3. **Partial failures are surfaced, never swallowed.** `/set` responses are checked;
   `notCreated/notUpdated/notDestroyed` become a `failed: {id: {type, description, properties?}}`
   map in the envelope, and a tool with zero successes returns `isError`. SetError modeled as a
   discriminated union on `type` with its typed extras (`properties`, `existingId`, `notFound`,
   `maxRecipients`, `invalidRecipients`, `maxSize`).
4. **Typed payloads with escape room.** JSCalendar Event and mail compose get real Zod schemas for
   every common field (with enums, formats, defaults from the RFC digests) plus `.passthrough()`
   so uncommon spec properties still flow. Cross-field invariants enforced with `superRefine`:
   `count`⟂`until`, `recurrenceId`⟂`recurrenceRules/Overrides`, `utcStart/utcEnd`⟂`start/duration`.
5. **Descriptions teach semantics, not implementation.** Each description says when to use the
   tool, the trap it protects against, and the follow-up tool if any. No "with Email/set update".
6. **MCP metadata everywhere.** `annotations: {readOnlyHint, destructiveHint, idempotentHint}` on
   every tool; `title` set; large binary results returned as MCP resources, not base64 text.
7. **One-field confirmation.** Mutations that need approval return
   `{confirmation_required: true, summary, preview, confirm_token}` where the token is a
   self-contained signed value (HMAC over canonical intent + embedded expiry + actor fingerprint).
   Confirm = repeat the call with `confirm_token`. `confirmExpiresAt` is gone. The HMAC covers the
   canonical *intent* (tool name, account, operation, resource ids, payload hash), not raw arg
   order, so re-serialization can't false-mismatch.
8. **Session + mailbox caching.** `JmapClient` caches `/jmap/session` and the mailbox role map per
   actor fingerprint with a short TTL (60s) and invalidates on `sessionState` change. Cuts 2 of
   the 3 round-trips most v1 calls make.
9. **Compact output.** `JSON.stringify` without pretty-printing; summary-level email/event
   projections by default; `include_body`/`verbose` opt-ins. Email body values fetched with the
   RFC-native `fetchAllBodyValues` + `maxBodyValueBytes` (UTF-8-safe truncation server-side)
   instead of client-side slicing.

## Tool inventory (≈38, from ~60)

### Session & profile (2)

| Tool | Notes |
|---|---|
| `whoami` | Merges v1 `stalwart_session_info` + `get_mail_profile` + `stalwart_account_resolve`: username, accounts, primary account per capability, capability limits worth knowing (`maxSizeUpload`, `maxObjectsInSet`, `maxDelayedSend`), mail identities, participant identities, default calendar. One call orients the whole session. readOnly |
| `jmap_call` | Escape hatch, unchanged semantics (read-only unless `allow_mutation`), but now documents the result-reference `#`/`*` pointer syntax and `using` inference. |

### Mail — read (6)

| Tool | Shape highlights |
|---|---|
| `list_mailboxes` | Unchanged surface; envelope normalized; role enum documented from the IANA registry (`inbox archive drafts sent trash junk all flagged important`). readOnly |
| `search_emails` | Absorbs `search_email_ids` (`ids_only: true`) . Gmail-query translation kept, but filter schema is now the **typed RFC 8621 FilterCondition** (all 18 conditions, incl. `inMailboxOtherThan`, the 3 thread-keyword conditions, `header`). Description states: `before`/`after` filter on **receivedAt**, quoted phrases vs tokenized terms, `collapse_threads` semantics. New: `include_snippets` runs `SearchSnippet/get` on the results — subject/preview with `<mark>` hits, dramatically better relevance triage for ~0 extra cost. readOnly |
| `read_emails` | Merges `read_email` + `batch_read_emails`: `email_ids: string[]`, `include_body`, `include_raw`, `max_body_bytes` (maps to `maxBodyValueBytes`). readOnly |
| `read_thread` | Merges single/batch thread reads: `email_id` or `thread_ids`. readOnly |
| `read_attachment` | Keeps email-membership verification. New: `mode: "content" \| "resource" \| "url"` — content returns text/base64 (bounded), resource returns an MCP resource, url returns the authenticated download URL + a curl one-liner for local saving. `.eml` attachments: new `parse: true` runs `Email/parse` on the blob and returns a structured Email instead of raw MIME. readOnly |
| `list_drafts` | Unchanged, normalized envelope. readOnly |

### Mail — compose & send (7)

| Tool | Shape highlights |
|---|---|
| `reply_email` | **New.** `email_id`, `mode: "sender" \| "all"`, `body`, `attachments?`, `send: bool` (false ⇒ draft). Builds per RFC 5322/8621: `inReplyTo` = parent `messageId`; `references` = parent `references` (else `inReplyTo`) + parent `messageId`; recipients from parent `replyTo` ?? `from` (+ to/cc minus self for `all`); subject keeps base form with `Re:`; quotes original; identity matched against recipient addresses; sets `$answered` on the parent via `onSuccessUpdateEmail`. Send path requires confirmation. |
| `send_email` | Compose+submit, or submit an existing draft (`draft_id` — absorbs `send_draft_email`). Compose schema unified (see below). Response includes `undo_status` and `send_at`; description notes delayed send (`send_at` arg via FUTURERELEASE when `maxDelayedSend > 0`) and that undo is possible while `pending`. Confirmation required. destructive |
| `cancel_send` | **New.** Sets `undoStatus: "canceled"` on a pending EmailSubmission. Fails with clear message on `cannotUnsend`. |
| `forward_emails` | Kept; `attachOriginal` now documented as zero-copy (original `blobId` reattached as `message/rfc822` part per RFC — already true in v1, never stated). HTML bodies preserved in quote mode (v1 dropped them). Sets `$forwarded`. Confirmation required. |
| `create_draft` / `update_draft` | Kept; update documents that replace = new Email id (JMAP Emails are immutable). |
| `set_vacation_response` / `get_vacation_response` | **New.** The RFC 8621 singleton: `is_enabled`, `from_date`, `to_date`, `subject`, `text_body`, `html_body`. Set requires confirmation (outward-facing autoresponder). |

**Compose schema** (shared by reply/send/draft/forward): `{from?, to?, cc?, bcc?, reply_to?,
subject, text_body?, html_body?, attachments?: [{blob_id, type, name?, cid?, disposition?} |
{content_base64, type, name?} | {url, name?}], headers?: {name: value}}` — inline base64 and URL
attachment sources are uploaded server-side (RFC 9404 `Blob/upload` in the same JMAP request via
`#creationId` when small; HTTP endpoint when large), so the two-step upload dance disappears.

### Mail — organize (6)

| Tool | Shape highlights |
|---|---|
| `move_emails` | **New, replaces archive_emails.** `email_ids`, `to: "archive" \| "trash" \| "inbox" \| mailbox_id`, `keep_in_current: bool` (label-style add vs move). Archive = remove inbox + add archive; trash documented per RFC (rewrite mailboxIds to trash only). Trash requires confirmation. |
| `mark_emails` | **New.** `email_ids`, `mark: "read" \| "unread" \| "flagged" \| "unflagged" \| "junk" \| "not_junk" \| "answered" \| "forwarded"` — sugar over `$seen/$flagged/$junk/$notjunk/...` so the model never hand-writes keyword patches. `$junk`/`$notjunk` documented as spam-filter training signals. |
| `label_emails` | Absorbs `apply_mail_labels` + non-delete `batch_modify_emails`: add/remove mailbox labels and keywords on explicit ids. Removals require confirmation. |
| `bulk_label_matching_emails` | Kept: query → dry-run → confirm flow unchanged (it's good). |
| `delete_emails` | Kept: trash default, `permanent: true` destroys. Confirmation both ways. destructive |
| `create_mail_label` | Kept. |

### Calendar — read (3)

| Tool | Shape highlights |
|---|---|
| `list_calendars` | Direct `Calendar/get ids:null` (drops the pointless query+get pair). Returns typed Calendar objects incl. `myRights`, `isDefault`, `includeInAvailability`, default alerts. Description notes: freeBusy-only shares are invisible here. readOnly |
| `search_events` | Typed draft-26 filter (`in_calendar` singular, `after`/`before` as **LocalDateTime in the `time_zone` arg** with overlap semantics — after compares event *end*, before compares event *start* — `text/title/description/location/owner/attendee/uid`). `expand: true` documented: requires both bounds, returns synthetic per-instance ids usable directly in read/update/delete, plus `utcStart/utcEnd`. Schema enforces the both-bounds constraint. readOnly |
| `read_events` | Merges get/batch_get: `event_ids[]`, plus draft args `recurrence_overrides_before/after`, `reduce_participants`, `time_zone`. Description: `utcStart/utcEnd` are opt-in and mutually exclusive with `recurrenceOverrides`. readOnly |

### Calendar — write (7)

| Tool | Shape highlights |
|---|---|
| `create_events` | Merges single/batch: `events: TypedEvent[]`. TypedEvent = full RFC 8984 Event schema (see below). `send_invitations: bool` (⇒ `sendSchedulingMessages`; default false, description warns about attendee desync both ways). `is_draft` supported. Confirmation only when sending invitations. |
| `update_event` | `event_id` (base **or synthetic instance id** — this is how "just this occurrence" works; description teaches it), `patch: EventPatch` (typed common fields) or raw PatchObject with the RFC pointer rules stated (no array interiors, no prefix overlap, parents must exist, null=remove). **No update_scope** — this-and-future documented as split-series (`relatedTo` first/next) helper guidance. `send_updates: bool`. Confirmation when sending scheduling messages. |
| `delete_events` | `event_ids` (base or instance ids), `send_cancellations: bool`. Destroying an instance id = excluding that occurrence. Confirmation always. destructive |
| `respond_to_event` | RSVP: patches own participant (matched via ParticipantIdentity `calendarAddress`, accepting Stalwart's hybrid shapes), `status`, `comment` (→ `participationComment`), optional `occurrence_id` for per-instance RSVP, `notify_organizer: bool` (default true ⇒ scheduling REPLY). Confirmation when notifying. |
| `manage_calendar` | Create/update/delete/subscribe/set-default in one tool with `action` enum and typed Calendar fields. Delete needs `delete_events: true` when non-empty (`calendarHasEvent` surfaced otherwise) + confirmation. Set-default uses `onSuccessSetIsDefault` **and re-reads to verify** (spec: silent no-op on failure). |
| `share_calendar` | Typed 8-field CalendarRights map keyed by principal id. Escalation rule in description (can't grant rights you lack). Confirmation always. |
| `event_alerts` | Merges acknowledge/snooze: `action: "acknowledge" \| "snooze"`, `until` for snooze. Implements the RFC pattern exactly (ack on base alert; snooze = ack + AbsoluteTrigger alert with snooze relation). |

**TypedEvent schema** (from RFC 8984 + draft-26 digests): typed `title, description(+ContentType),
start (LocalDateTime regex), time_zone, duration (Duration regex), show_without_time, status,
privacy, free_busy_status, priority, calendar_ids, keywords/categories/color, locations,
virtual_locations (uri mandatory, features enum), links (incl. blob_id attachments per draft),
recurrence_rules (full RecurrenceRule: frequency enum, interval≥1, rscale, skip, byDay NDay,
byMonth string-with-L, ... , count⟂until), recurrence_overrides (LocalDateTime keys → patch),
participants (name/email/calendar_address/kind/roles/participationStatus/expectReply — union
accepting both `sendTo` map and `calendarAddress` string per the Stalwart hybrid), alerts
(discriminated OffsetTrigger/AbsoluteTrigger), use_default_alerts` + `.passthrough()`. Sets-as-maps
(`z.record(z.literal(true))`) for keywords/roles/features. Server-set fields (`uid`, `updated`,
`isOrigin`, `baseEventId`, `organizerCalendarAddress`, `sequence`) excluded from create schema.

### People & availability (3)

| Tool | Shape highlights |
|---|---|
| `search_principals` | Typed RFC 9670 filter (`email/name/text/type/time_zone/calendar_address`); `fetch` defaults **true** (v1 defaulted to ids-only, which every skill immediately overrode). Returns calendar capability info (`calendarAddress`, `mayGetAvailability`) per principal. readOnly |
| `get_availability` | Absorbs `principal_availability_get` + `availability_get`: addresses or principal ids, `utc_start/utc_end`, `show_details`. Returns normalized BusyPeriods (`busy_status` enum with the confirmed>unavailable>tentative precedence documented). Bounded by `maxAvailabilityDuration`. readOnly |
| `participant_identities` | List + `set_default` (via `onSuccessSetIsDefault`, verify-after). CRUD dropped from the default surface. |

### Notifications (2)

`list_event_notifications` (typed filter: after/before on `created` **UTCDateTime**, type,
event ids; returns changedBy/type/eventPatch so "what changed" is answerable in one call) and
`dismiss_event_notifications` (destroy-only per spec). The four `*_changes`/`queryChanges`
notification/sync tools are dropped (see Sync below).

### Blobs & files (3)

| Tool | Shape highlights |
|---|---|
| `upload_blob` | Sources: `content_base64`, `text` (uses RFC 9404 `data:asText` — no base64 inflation for text), or `url` (server-side fetch, SSRF-guarded: https only, no cross-origin redirects, size cap). Small payloads go through `Blob/upload` so they can be `#creationId`-chained. |
| `download_blob` | RFC 9404 `Blob/get` with `offset/length` ranges and `digest:sha-256` support; `mode: content \| resource \| url` like `read_attachment`. readOnly |
| `list_files` | Merges file_node list/get. readOnly |

### CalDAV raw (2, down from 9)

`caldav_request` (discover/propfind/list/multiget/get behind an `operation` enum — they are all
read-plumbing used only when raw iCal fidelity matters) and `caldav_put_delete` (writes, ETag
`if_match` required, confirmation). Path strictness rules unchanged.

### Admin (2)

`calendar_server_settings_get` / `_update` unchanged (gated by `ENABLE_ADMIN_TOOLS`).

### Sync primitives — dropped from default surface

All six `*/changes` + `*/queryChanges` tools are removed from the default registration and
available behind `ENABLE_SYNC_TOOLS=true` (or via `jmap_call`). An interactive agent re-queries; a
sync daemon can opt in. This alone removes ~10% of the schema tokens every session pays.

### Explicitly deferred domains (decide later, deliberately)

Stalwart advertises `contacts` (+parse), `sieve`, `quota`, `mail:share`. Contacts (RFC 9553
JSContact / RFC 9610) is the highest-value gap — "invite Daria" and "mail Ivan" need address
lookup. Proposed: `search_contacts` + `read_contacts` read-only pair in v2.1 after the same
RFC-digest treatment. Sieve/quota stay in `jmap_call` territory.

## Code structure

```
src/
  jmap/
    client.ts        # request/call/single + session cache (TTL 60s, keyed by actor fingerprint)
    session.ts       # typed Session/Account, account resolution
    envelopes.ts     # normalize /get,/query,/set responses; SetError union; partial-failure check
    types.ts         # typed JMAP objects (Email, Mailbox, Thread, Identity, Submission)
  schemas/
    jscalendar.ts    # RFC 8984 + draft-26 Zod schemas (Event, RecurrenceRule, Participant, Alert…)
    mail.ts          # compose, filter, address schemas
    common.ts        # Id, LocalDateTime, UTCDateTime, Duration regexes; sets-as-maps helper
  confirm.ts         # self-contained signed confirm_token (intent hash + expiry + actor)
  domains/
    mail/            # compose.ts (MIME building), query.ts (Gmail translation), mailboxes.ts
    calendar/
    people/
    blobs/
  tools/             # thin: schema + description + orchestration only, one file per group above
```

Rules: no JMAP-shape helpers outside `jmap/envelopes.ts` (kills the 4-way duplication); no
`Record<string, unknown>` narrowing in tool files (typed objects from `jmap/types.ts`); the Gmail
query parser and compose builder get unit tests (they are pure and currently untested).

## Migration & rollout

1. **Hotfix first (independent of v2):** remove the phantom `updateScope`/`destroyScope` args and
   fix the two skills instructing models to use them (task chip already filed).
2. v2 is one breaking sweep: tools, `docs/tool-mapping.md` (regenerated from the registry, not
   hand-maintained), and all six skills updated in the same change; Codex `config.toml` needs no
   change (same endpoint).
3. Skills consolidation lands with v2: `stalwart-mail` + `stalwart-calendar` as the two mechanics
   skills documenting the new surface; the four workflow skills slim to their deltas.
4. Plugin packaging (`.claude-plugin/`, marketplace, install script for Codex skills) on top.

## Open questions

- Response projection defaults: summary email projection = RFC "fast" property set minus
  `references`? (proposed: yes, plus `preview`).
- `search_emails` default `limit`: 25 (skills currently advise 10–25).
- Whether `manage_calendar` action-enum consolidation is worth it vs 4 small tools — leaning yes
  for schema-token economy; the actions share 80% of their fields.
- MCP resources: confirm the connected clients (Claude Code, Codex CLI) render `resource` results
  usefully before making it the `read_attachment` default; otherwise default `url` mode.
