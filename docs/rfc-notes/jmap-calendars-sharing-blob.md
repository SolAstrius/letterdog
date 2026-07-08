# JMAP Calendar Stack — Reference Notes for Typed Schemas & Tool Descriptions

Sources read (full text):

- `draft-ietf-jmap-calendars-26` (2025-11-05, Jenkins/Douglass) — latest version as of 2026-07
- **RFC 9670** (Nov 2024) — JMAP Sharing (Principals, ShareNotifications). Published successor of
  draft-ietf-jmap-sharing.
- **RFC 9404** — JMAP Blob extensions
- Stalwart `main` source (`crates/jmap-proto/.../calendar_event.rs`) for implementation cross-checks

Note: the CalendarEvent data format tracks **JSCalendar-bis** (`draft-ietf-calext-jscalendarbis`),
not RFC 8984 exactly — renames flagged in §12/§13, with live-Stalwart verification in §14.

## 1. Capability URNs

| Capability | Gates | accountCapabilities value |
|---|---|---|
| `urn:ietf:params:jmap:calendars` | Calendar, CalendarEvent, CalendarEventNotification, ParticipantIdentity + methods (all except `/parse`) | `maxCalendarsPerEvent: UnsignedInt\|null`, `minDateTime/maxDateTime: UTCDateTime`, `maxExpandedQueryDuration: Duration`, `maxParticipantsPerEvent: UnsignedInt\|null`, `mayCreateCalendar: Boolean` |
| `urn:ietf:params:jmap:calendars:parse` | `CalendarEvent/parse` only | `{}` |
| `urn:ietf:params:jmap:principals:availability` | `Principal/getAvailability` + `calendarAddress` filter on Principal/query. Requires `jmap:principals` too | `maxAvailabilityDuration: Duration` |
| `urn:ietf:params:jmap:principals` (RFC 9670) | Principal + ShareNotification | `currentUserPrincipalId: Id\|null` |
| `urn:ietf:params:jmap:principals:owner` (RFC 9670) | accountCapabilities-only key: marks an account as owned by a Principal | `accountIdForPrincipal: Id`, `principalId: Id` |
| `urn:ietf:params:jmap:blob` (RFC 9404) | Blob/upload, Blob/get extensions, Blob/lookup | `maxSizeBlobSet: UnsignedInt\|null`, `maxDataSources: UnsignedInt` (≥64), `supportedTypeNames: String[]`, `supportedDigestAlgorithms: String[]` (lowercase, e.g. `"sha"`, `"sha-256"`) |

Stalwart implements all of the above (verified in source).

## 2. Calendar object

| Property | Type | Mutability / default | Notes |
|---|---|---|---|
| `id` | `Id` | immutable; server-set | |
| `name` | `String` | mutable | non-empty, ≤255 octets UTF-8. **Per-user** once sharee sets it (initially inherited from owner) |
| `description` | `String\|null` | default `null` | |
| `color` | `String\|null` | default `null` | CSS Color L3 named or hex RGB. Per-user (inherited-then-forked) |
| `sortOrder` | `UnsignedInt` | default `0` | Per-user, NOT inherited |
| `isSubscribed` | `Boolean` | | SHOULD default false for shared accounts, true for own new calendars |
| `isVisible` | `Boolean` | default `true` | Per-user, not inherited. Clients ignore if `isSubscribed` false |
| `isDefault` | `Boolean` | **server-set** | ≤1 true per account. **Not writable directly — change via `Calendar/set` arg `onSuccessSetIsDefault`** |
| `includeInAvailability` | `String` | | `"all"` \| `"attending"` \| `"none"`. Default: "all" own account, "none" shared. Per-user |
| `defaultAlertsWithTime` | `Id[Alert]\|null` | | For events with `showWithoutTime:false` + `useDefaultAlerts:true`. Alert ids unique across ALL default alerts in account (UUID recommended). Trigger MUST NOT be AbsoluteTrigger. Per-user |
| `defaultAlertsWithoutTime` | `Id[Alert]\|null` | | Same for all-day events |
| `timeZone` | `TimeZoneId\|null` | default `null` | Null → Principal's timeZone. Per-user (inherited-then-forked) |
| `shareWith` | `Id[CalendarRights]\|null` | default `null` | Keys = Principal ids. Owner MUST NOT be in map. Writable only with `mayShare` |
| `myRights` | `CalendarRights` | server-set | |

There is **no `participantIdentities` property on Calendar** in -26; ParticipantIdentity is a
separate account-scoped datatype (§10).

### CalendarRights (all Boolean)

| Right | Grants |
|---|---|
| `mayReadFreeBusy` | included in `Principal/getAvailability`. If this is the *only* right, calendar is invisible in Calendar/get & /query |
| `mayReadItems` | fetch events |
| `mayWriteAll` | create/modify/destroy all events, move in/out. True ⇒ mayWriteOwn, mayUpdatePrivate, mayRSVP all true |
| `mayWriteOwn` | create/modify/destroy events the user owns or that are ownerless |
| `mayUpdatePrivate` | modify per-user props (keywords, color, freeBusyStatus, useDefaultAlerts, alerts) on any event, incl. per-occurrence |
| `mayRSVP` | modify `participationStatus`, `expectReply`, `scheduleSequence`, `scheduleUpdated` of own Participant; add self if event `mayInviteSelf`; add others (roles = attendee only) if `mayInviteOthers` and already participant |
| `mayShare` | modify `shareWith` |
| `mayDelete` | delete calendar |

*Owner* = event has a Participant with role `"owner"` whose `calendarAddress` matches one of the
user's ParticipantIdentities (RFC 3986 §6.2.2 normalization).

Multi-calendar events: may fetch with right on *any* calendar; remove-from-calendar with right on
*that* calendar; other edits need right on **all** calendars containing it.

### Calendar/set extra args

- `onDestroyRemoveEvents: Boolean` (default false) — false ⇒ destroying non-empty calendar fails
  with SetError **`calendarHasEvent`**. True ⇒ events removed (destroyed if in no other calendar);
  MUST NOT send scheduling messages; ShareNotification per previous sharee.
- `onSuccessSetIsDefault: Id|null` — applied only if all creates/updates/destroys succeed;
  `#creationId` refs allowed; if not permitted/not found: **silently ignored** (no error).
- shareWith escalation rule: user can't grant a right they don't hold themselves (⇒ `forbidden`).

## 3. CalendarEvent object (JSCalendar Event + JMAP additions)

| Property | Type | Notes |
|---|---|---|
| `id` | `Id` | immutable; server-set. Identifies (uid, recurrenceId) pair within account. May be a **synthetic id** from `expandRecurrences` |
| `baseEventId` | `Id\|null` | server-set. Points at the real stored event when `id` is synthetic (live Stalwart: equals `id` for base events) |
| `calendarIds` | `Id[Boolean]` | keys = Calendar ids, values MUST be `true`. Event must be in ≥1 calendar |
| `isDraft` | `Boolean` (default false) | true ⇒ no scheduling messages / alert pushes. Only settable at create; false→true forbidden. MUST NOT appear in recurrenceOverrides |
| `isOrigin` | `Boolean` | server-set. True iff `organizerCalendarAddress` is null OR account receives mail to that URI |
| `utcStart` / `utcEnd` | `UTCDateTime` | **Computed at fetch time; NOT returned unless explicitly requested.** Writable as convenience: utcStart→`start`, utcEnd→`duration`; MUST NOT combine with start/duration; MUST NOT set in recurrenceOverrides. If requested, `recurrenceOverrides` MUST NOT be requested |
| `useDefaultAlerts` | `Boolean` (default false) | use calendar defaultAlerts*, ignore `alerts` (except acknowledgements/snoozes) |
| `mayInviteSelf` | `Boolean` (default false) | base object only, never in overrides |
| `mayInviteOthers` | `Boolean` (default false) | ditto |
| `hideAttendees` | `Boolean` (default false) | ditto. Non-owners see only owners + themselves |

- `method` MUST NOT be set/present (⇒ `invalidProperties`); only appears in `/parse` output.
- **Attachments:** Link object with `rel:"enclosure"`; client MAY set **`blobId`** instead of
  `href` (server converts for external systems).
- Per-user props: `keywords`, `color`, `freeBusyStatus`, `useDefaultAlerts`, `alerts`
  (+ per-occurrence versions). Per-user writes also fork `updated` per-user.
- `privacy`: `"private"` ⇒ sharees see only time/metadata + derived + JMAP metadata; only calendar
  owner may update/destroy. `"secret"` ⇒ invisible to sharees. Non-"public" privacy MUST be
  rejected (`invalidProperties`) on calendars not belonging to the user.

## 4. CalendarEvent/get — extra args

| Arg | Type | Notes |
|---|---|---|
| `recurrenceOverridesBefore` | `UTCDateTime\|null` | only overrides with recurrenceId (in UTC) before this |
| `recurrenceOverridesAfter` | `UTCDateTime\|null` | on-or-after |
| `reduceParticipants` | `Boolean` (default false) | return only owners + participants matching user's identities |
| `timeZone` | `TimeZoneId` (default `"Etc/UTC"`) | interpretation of floating events for utcStart/utcEnd |

Default properties: all stored JSCalendar props except `iCalComponent`; `id`, `calendarIds`,
`isDraft`, `isOrigin` always included; `utcStart`/`utcEnd`/`iCalComponent` opt-in only. For
synthetic instance ids: overrides resolved, `start`/`recurrenceId` set,
`recurrenceRule`/`recurrenceOverrides` returned as null.

## 5. CalendarEvent/set

**Exactly one extra argument:** `sendSchedulingMessages: Boolean` (**default false**) — if true,
server sends iTIP after successful create/update/destroy: to participants if `isOrigin`, else back
to `organizerCalendarAddress`. Extra SetError: **`noSupportedScheduleMethods`**.

**`updateScope` / `destroyScope` DO NOT EXIST.** Zero occurrences in draft-26 and zero in the
Stalwart codebase (`CalendarEventSetArguments` parses only `sendSchedulingMessages` and routes
every other argument to `serde IgnoredAny`). Any client passing them gets whole-series behavior
silently. The real per-scope mechanisms:

- **Single occurrence:** update/destroy using the **synthetic instance id** from
  `expandRecurrences:true` query — server maps update→recurrenceOverride patch on base event,
  destroy→remove that instance. Never touch base id + synthetic id of the same event in one `/set`
  (undefined).
- Or patch the base event directly:
  `"recurrenceOverrides/2025-03-05T09:00:00/participants~1<key>~1participationStatus": "declined"`
  (JSON-Pointer `~1` = `/`). Gotcha: you cannot *add* a null-valued key via deep patch (null =
  remove); to null-out a participant in an override, rewrite the whole override object.
- **This-and-future:** no server support — client-side pattern: (a) split into two events
  (`next`/`first` relations; only if unscheduled/owner), or (b) update base + add restoring
  overrides for past occurrences.

Other server behaviors: on create fills `@type:"Event"`, `uid`, `created`; if `isOrigin`,
force-sets `updated`; auto-increments `sequence` on non-per-user changes when origin; sets
`organizerCalendarAddress` when participants first added (clients SHOULD NOT set it); enforces
`myRights` (⇒ `forbidden`). Null property value in create/update = omit/remove. Clients MUST NOT
edit non-per-user props when `isOrigin:false`.

### Scheduling messages (§5.9.2)

- **REQUEST** (origin): on create, or any non-per-user change incl. participant add/remove.
- **CANCEL** (origin): participant removed (sent to them only); event destroyed; excluded instance
  added; extra instance removed.
- **REPLY** (non-origin): participationStatus changed to non-"needs-action" (base or per-instance).
- **RSVP recipe:** patch own Participant's `participationStatus` (+ optionally in an override for
  one occurrence) with `sendSchedulingMessages:true`; permitted by `mayRSVP`. **No counter-proposal
  (iTIP COUNTER) mechanism exists in the draft.**

## 6. CalendarEvent/query

Extra args: `expandRecurrences: Boolean` (default false; if true, filter MUST be a bare
FilterCondition — no operators — and MUST include both `before` and `after`), `timeZone: TimeZoneId`
(default `"Etc/UTC"`, interprets before/after). Expansion yields **opaque synthetic ids** per
instance (usable in /get and /set; never appear in /changes). Extra errors:
`expandDurationTooLarge` (exceeds `maxExpandedQueryDuration`), `cannotCalculateOccurrences`.

FilterCondition (all optional; AND semantics; if expandRecurrences all conditions must match the
*same* instance):

| Filter | Type | Semantics |
|---|---|---|
| `inCalendar` | `Id` | (singular — not "inCalendars") |
| `after` | `LocalDateTime` | event/recurrence **end** > this, in arg timeZone |
| `before` | `LocalDateTime` | event/recurrence **start** < this |
| `text` | `String` | title, description, locations (name/desc), participants (name/email), other textual props |
| `title` / `description` / `location` | `String` | incl. overridden values in recurrences |
| `owner` / `attendee` | `String` | participant name/email where role owner / attendee |
| `uid` | `String` | exact match |

Text matching: case-insensitive; quoted = phrase; whitespace tokenizes; stemmed whole-word allowed.
Sort: MUST `start`, `uid`, `recurrenceId`; SHOULD `created`, `updated`. (Stalwart implements
exactly this filter/sort set, lowercasing text inputs.)

## 7. CalendarEvent/copy & /parse

- `/copy`: plain RFC 8620 §5.4 `/copy`; no calendar-specific extras (Stalwart:
  `CopyArguments = ()`).
- `/parse` (needs `calendars:parse` cap): args `accountId`, `blobIds: Id[]`,
  `properties: String[]`; parses **iCalendar** blobs → response `parsed: Id[CalendarEvent[]]|null`,
  `notFound`, `notParsable`. Parsed objects have null `id/baseEventId/calendarIds/isDraft/isOrigin`
  and MAY have `method`.

## 8. Alerts & push

`useDefaultAlerts:true` ⇒ alerts from calendars' defaultAlerts maps; event `alerts` used only for
`acknowledged` stamps (same alert id as default) and snooze alerts (`relatedTo` snooze relation).
Acknowledge = set `acknowledged` on base (never creates an override). Snooze = acknowledge + add
AbsoluteTrigger alert related via snooze. Push pseudo-type **`CalendarAlert`**:
`{@type:"CalendarAlert", accountId, calendarEventId (base id, never synthetic), uid,
recurrenceId: LocalDateTime|null, alertId}`.

## 9. CalendarEventNotification

Server-created records of changes made by *others* to subscribed calendars (incl. auto-processed
iTIP). Dismiss by `/set destroy` (create/update ⇒ `forbidden`).

Object: `id`, `created: UTCDateTime`, `changedBy: Person {name, email: String|null,
principalId: Id|null, calendarAddress: String|null}`, `comment: String|null` (iTIP COMMENT),
`type: "created"|"updated"|"destroyed"`, `calendarEventId` (always the base event), `isDraft`,
`event: JSCalendar Event` (before-image for updated/destroyed, after-image for created),
`eventPatch: PatchObject` (updated only). Methods: get/changes/set(destroy-only)/query/
queryChanges. Query filter: `after`/`before` (UTCDateTime, on `created`), `type`,
`calendarEventIds: Id[]`. Sort: `created` MUST.

## 10. ParticipantIdentity

Object: `id` (immutable, server-set), `name: String` (default ""), `calendarAddress: String` (URI
for iTIP; server MAY restrict to user's own mailto:), `isDefault: Boolean` (**server-set**, ≤1 true
per account). Methods: get (ids nullable), changes, set — with extra arg
**`onSuccessSetIsDefault: Id|null`** (same silent-no-op semantics as Calendar/set). Matching to
event Participants is by normalized `calendarAddress` equality.

## 11. RFC 9670 — Principals & ShareNotifications

**Principal:** `id` (immutable, server-set); `type`: `"individual"|"group"|"resource"|"location"|
"other"` (**no "domain" value**); `name: String`; `description: String|null`; `email: String|null`;
`timeZone: String|null`; `capabilities: String[Object]` (server-set); `accounts: Id[Account]|null`
(server-set).

**Calendar entry in Principal `capabilities["urn:ietf:params:jmap:calendars"]`:**
`accountId: Id|null`, `mayGetAvailability: Boolean`, `mayShareWith: Boolean`,
`calendarAddress: String` (URI to invite this principal).

Principal/query FilterCondition: `accountIds: String[]`, `email`, `name`, `text` (substring
contains), `type` (exact), `timeZone` (exact). Availability extension adds
`calendarAddress: String` filter. Principal/set: mostly `forbidden`; SHOULD allow self-update of
name/description/timeZone for `currentUserPrincipalId`.

**Principal/getAvailability** args: `accountId: Id`, `id: Id` (principal), `utcStart`/`utcEnd:
UTCDateTime` (inclusive/exclusive), `showDetails: Boolean`, `eventProperties: String[]|null`.
Response `list: BusyPeriod[]`. **BusyPeriod:** `utcStart`, `utcEnd`, `busyStatus:
"confirmed"|"tentative"|"unavailable"` (default "unavailable"; precedence confirmed > unavailable >
tentative), `event: CalendarEvent|null` (null unless showDetails && privacy≠private &&
mayReadItems), `accountId: Id|null`. Relevance: subscribed calendar, includeInAvailability
all/attending, mayReadFreeBusy, overlaps window, privacy≠secret, freeBusyStatus busy,
status≠cancelled; "attending" ⇒ participationStatus accepted/tentative. Eventless periods merged/
split to be non-overlapping. Errors: `notFound`, `forbidden`, `tooLarge` (> maxAvailabilityDuration),
`rateLimit`.

**ShareNotification** (stored in the Principals account; destroy-only): `id`, `created: UTCDate`,
`changedBy: Entity {name, email|null, principalId|null}`, `objectType` (e.g. "Calendar"),
`objectAccountId: Id`, `objectId: Id`, `oldRights`/`newRights: String[Boolean]|null`, `name:
String`. Query filter: `after`/`before` (UTCDate), `objectType`, `objectAccountId`; sort `created`.

## 12. RFC 9404 — Blob extensions (attachment upload without the HTTP endpoint)

- **`Blob/upload`** (method, create-only, no state): args `accountId`, `create: Id[UploadObject]`.
  **UploadObject:** `data: DataSourceObject[]` (concatenated; 0 = empty blob), `type: String|null`.
  **DataSourceObject** = exactly one of `data:asText` (UTF-8) | `data:asBase64` |
  `{blobId, offset: UnsignedInt|null (→0), length: UnsignedInt|null (→rest)}` (range overrun ⇒
  notCreated). Created result: `id` (blobId), `type`, `size`. Successful uploads auto-enter
  `createdIds`, so `#creationId` back-references work in the same request — e.g. `Blob/upload` then
  a CalendarEvent Link `blobId: "#att1"`, **no separate HTTP upload round-trip**. Bounded by
  `maxSizeRequest`; RFC suggests the HTTP endpoint for >1 MB.
- **`Blob/get`**: standard /get + `offset`/`length` (UnsignedInt|null). `properties` from:
  `data:asText`, `data:asBase64`, `data` (text if valid UTF-8 else base64), `digest:<alg>` (base64
  digest of the *selected range*; alg from `supportedDigestAlgorithms`), `size` (always whole-blob
  size). Defaults: `data`,`size`. Flags: `isEncodingProblem`, `isTruncated`.
- **`Blob/lookup`**: args `accountId`, `typeNames: String[]` (unknown ⇒ `unknownDataType` error),
  `ids: Id[]` (blobIds). Response `list: BlobInfo[]` = `{id, matchedIds: String[Id[]]}`;
  invisible/nonexistent blobs return empty arrays (no existence leak).

## 13. Traps / old-draft divergences worth encoding in tool descriptions

1. **`updateScope`/`destroyScope` are fiction** — not in any draft revision nor in Stalwart;
   Stalwart silently ignores unknown `/set` args, so callers get whole-series modification while
   believing they scoped it. Replace with synthetic-instance-id writes (after `expandRecurrences`
   query) or `recurrenceOverrides` patches.
2. **JSCalendar-bis renames** (vs RFC 8984): Participant `sendTo: String[String]` →
   **`calendarAddress: String`** (single URI); Event `replyTo` → **`organizerCalendarAddress:
   String`**. See §14 for what Stalwart actually serves today.
3. `isDefault` (Calendar, ParticipantIdentity) is **server-set**; the only mutation path is the
   `onSuccessSetIsDefault` `/set` argument, and failures there are *silent* — verify by re-reading.
4. Older calendars drafts had finer-grained rights (`mayAddItems`, `mayUpdateAll`, `mayRemoveAll`,
   `mayAdmin`); current is the 8-field CalendarRights above.
5. Filter is `inCalendar` (singular Id), not `inCalendars`.
6. `after` is compared against event **end**, `before` against event **start** (overlap
   semantics), both `LocalDateTime` in the query `timeZone` arg — not UTCDateTime (unlike
   Notification filters, which use UTCDateTime on `created`).
7. `utcStart`/`utcEnd` are opt-in, fetch-time-computed, unstable under tzdata updates, and mutually
   exclusive with fetching `recurrenceOverrides`.
8. `sendSchedulingMessages` defaults **false** — a tool that mutates scheduled events without it
   silently desyncs attendees. Conversely CANCEL is emitted on destroy when true.
9. Destroying a Calendar needs `onDestroyRemoveEvents:true` or a `calendarHasEvent` SetError.
10. `mayReadFreeBusy`-only calendars are invisible to Calendar/get//query — don't treat "not
    returned" as "doesn't exist" when reasoning about availability.
11. Stalwart specifics: only `sendSchedulingMessages` (set), `expandRecurrences`+`timeZone`
    (query), `recurrenceOverridesBefore/After`+`reduceParticipants`+`timeZone` (get) are parsed;
    invalid `timeZone` strings degrade silently to none; filter text is lowercased server-side.

## 14. Live-Stalwart verification (mail.astrius.ink, v0.16.11, probed 2026-07-08)

Stalwart v0.16.11 serves a **hybrid** of RFC 8984 and JSCalendar-bis shapes:

- Participants carry bis-style **`calendarAddress`** (single `mailto:` URI) — no `sendTo` map.
- The event still serves 8984-style **`replyTo`** (`{"imip": "mailto:..."}` map);
  `organizerCalendarAddress` was requested explicitly and **not returned**.
- Participant `roles` observed as `{"required": true}` — `required` is in neither the RFC 8984
  registry (owner/attendee/optional/informational/chair/contact) nor the draft; it is Stalwart's
  mapping of iCalendar `ROLE=REQ-PARTICIPANT`. Schemas must accept unknown role keys.
- `baseEventId` on a base (non-synthetic) event returns the event's own id, not null.
- Expanded instances: synthetic `id`, `baseEventId`, `recurrenceId` (LocalDateTime), and
  `utcStart`/`utcEnd` are returned when requested.
- `expandRecurrences: true` without both `after` and `before` ⇒ `invalidArguments` ("Both 'after'
  and 'before' filters are required when expanding recurrences").

Consequence for v2 schemas: organizer/participant address fields should be modeled as a union
(accept both `replyTo`-map and `organizerCalendarAddress`; both `sendTo` and `calendarAddress` on
participants), normalize at the tool layer, and re-verify on Stalwart upgrades.
