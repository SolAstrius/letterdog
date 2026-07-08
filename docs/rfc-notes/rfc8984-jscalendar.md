# RFC 8984 JSCalendar — Event Schema Reference (for Zod + LLM tool descriptions)

Source: RFC 8984 (July 2021, Standards Track, Jenkins/Stepanek, Fastmail). Digest for schema
design; verified against the spec including the IANA property registry (Section 8.2.6).

Media type: `application/jscalendar+json;type=event`. JSCalendar objects MUST be valid I-JSON.
Property names and values are **case sensitive**.

## 1. Event object — complete property table

`@type` discipline: every JSCalendar object (Event, and every nested object: RecurrenceRule, NDay,
Participant, Location, VirtualLocation, Link, Alert, OffsetTrigger, AbsoluteTrigger, Relation,
TimeZone, TimeZoneRule) MUST carry a mandatory `@type` string naming its type. **The single
exception is PatchObject**, which has no `@type` of its own (an `@type` key inside a patch is just a
patched property path).

| Property | Type | Req? | Default | Semantic note |
|---|---|---|---|---|
| `@type` | String | mandatory | — | MUST be `"Event"` |
| `uid` | String | mandatory | — | Globally unique id; same for all occurrences of a recurring event; UUIDv4 recommended; implementations must accept ≥255 octets, never truncate mid-UTF-8-sequence |
| `updated` | UTCDateTime | mandatory | — | Last-modified timestamp (creation time if never modified) |
| `start` | LocalDateTime | **mandatory** (Event-specific) | — | Start date-time in the event's `timeZone` |
| `duration` | Duration | optional | `"PT0S"` | Zero-or-positive duration in the start time zone; end = start + duration |
| `status` | String | optional | `"confirmed"` | `"confirmed"` \| `"cancelled"` \| `"tentative"` (Event-only property) |
| `created` | UTCDateTime | optional | — | Creation timestamp |
| `sequence` | UnsignedInt | optional | `0` | iTIP revision counter; increment on every change **except** changes that only touch `participants` |
| `method` | String | optional | — | Lowercase iTIP method; MUST only be present in iTIP scheduling messages — never in stored objects |
| `prodId` | String | optional | — | Globally unique product identifier of last writer; set whenever `updated` is set |
| `relatedTo` | String[Relation] | optional | — | Map of related-object **UID → Relation**; used for series splits (`next` on original, `first` on new object) |
| `title` | String | optional | `""` | Short summary |
| `description` | String | optional | `""` | Long-form text, format per `descriptionContentType` |
| `descriptionContentType` | String | optional | `"text/plain"` | MUST be a `text/*` subtype; SHOULD be `text/plain` or `text/html`; `charset` param, if given, MUST be `utf-8`; HTML may use `cid:` URLs referencing Link `cid`s |
| `showWithoutTime` | Boolean | optional | `false` | "All-day" display flag; time still counts for free-busy |
| `locations` | Id[Location] | optional | — | Map location-id → Location |
| `virtualLocations` | Id[VirtualLocation] | optional | — | Map id → VirtualLocation (video conf, chat room…) |
| `links` | Id[Link] | optional | — | Map id → Link; rel `enclosure`=attachment, `describedby`=alt description, `icon`=display image |
| `locale` | String | optional | — | RFC 5646 language tag of the object's text |
| `keywords` | String[Boolean] | optional | — | Set-as-map, keys = free-text tags, values MUST be `true` |
| `categories` | String[Boolean] | optional | — | Set-as-map, keys = category **URIs** (structured, e.g. `http://example.com/categories/music/r-b`), values `true` |
| `color` | String | optional | — | CSS Color Module Level 3 named color or hex RGB |
| `recurrenceId` | LocalDateTime | optional | — | Only on an object representing **one occurrence**; if present, `recurrenceRules` and `recurrenceOverrides` MUST NOT be present |
| `recurrenceIdTimeZone` | TimeZoneId\|null | optional | `null` | MUST be set iff `recurrenceId` is set; time zone of the main object |
| `recurrenceRules` | RecurrenceRule[] | optional | — | Rules applied to `start`; multiple rules → union, deduplicated |
| `excludedRecurrenceRules` | RecurrenceRule[] | optional | — | Same semantics; generated date-times are subtracted (see §3) |
| `recurrenceOverrides` | LocalDateTime[PatchObject] | optional | — | Map recurrence-id → patch (see §3) |
| `excluded` | Boolean | optional | `false` | On an occurrence object: true = removed from expansion |
| `priority` | Int | optional | `0` | 0 = undefined, 1 = highest … 9 = lowest; other values reserved |
| `freeBusyStatus` | String | optional | `"busy"` | `"free"` \| `"busy"` |
| `privacy` | String | optional | `"public"` | `"public"` \| `"private"` \| `"secret"`; sharing-only, never affects scheduling messages |
| `replyTo` | String[String] | optional | — | Method → URI map for participant responses (organizer address lives here); omit rather than `{}` |
| `sentBy` | String | optional | — | RFC 5322 addr-spec of email From header (iMIP receipt only) |
| `participants` | Id[Participant] | optional | — | Map participant-id → Participant; if any participant has `sendTo`, `replyTo` MUST define ≥1 method |
| `requestStatus` | String | optional | — | `statcode ";" statdesc [";" extdata]`; server-managed scheduling result |
| `useDefaultAlerts` | Boolean | optional | `false` | true = use user's defaults and **ignore** `alerts`; if defaults indeterminable/none, process `alerts` as if false |
| `alerts` | Id[Alert] | optional | — | Map alert-id → Alert |
| `localizations` | String[PatchObject] | optional | — | Language tag → patch set (see §7) |
| `timeZone` | TimeZoneId\|null | optional | `null` | null/omitted = **floating time** |
| `timeZones` | TimeZoneId[TimeZone] | optional | — | Custom VTIMEZONE-equivalent definitions; keys MUST start with `/`; orphans not allowed |

## 2. Custom scalar types — exact formats

| Type | Format | Constraints |
|---|---|---|
| **Id** | String | 1–255 octets; base64url alphabet only: `A-Za-z0-9`, `-`, `_` (no `=` pad). No cross-map uniqueness constraint — same Id may appear in `links` and `alerts` with no semantic link |
| **Int** | JSON Number | integer, −2⁵³+1 ≤ v ≤ 2⁵³−1 |
| **UnsignedInt** | JSON Number | integer, 0 ≤ v ≤ 2⁵³−1 |
| **UTCDateTime** | RFC 3339 `date-time` | Letters MUST be uppercase; offset MUST be literally `Z` (no numeric offsets). Fractional seconds MUST NOT appear unless non-zero, and MUST NOT have trailing zeros (single canonical representation). `2010-10-10T10:10:10.003Z` ✔; `...10.000Z` ✘ (write `...10Z`) |
| **LocalDateTime** | Same as UTCDateTime but **no zone/offset info at all** — no `Z`, no offset. Fractional-second rules identical. `2006-01-02T15:04:05` valid | Zone comes from the object's `timeZone`; if none → floating (occurs at that wall-clock time in every zone). DST discontinuities: use the offset **before** the transition |
| **Duration** | ISO 8601 subset: `P[nW][nD][T[nH][nM][nS[.frac]]]` | No negative; no fractional seconds unless non-zero, no trailing zeros. Weeks/days are calendar units (may ≠ exact 24h multiples across DST); h/m/s added in absolute time. Matches iCalendar DURATION semantics. Add order: date parts first, then convert to UTC, add time parts, convert back |
| **SignedDuration** | `["+"/"-"] duration` | Negative = at-or-before the anchor; positive/unsigned = at-or-after |
| **TimeZoneId** | String | IANA TZDB name (e.g. `America/New_York`) **or** a custom id defined in the object's `timeZones` map (custom ids MUST start with `/`) |

## 3. Recurrence model

Recurrence set generation order: 1) `recurrenceRules` generate date-times → 2)
`excludedRecurrenceRules` date-times are removed → 3) `recurrenceOverrides` adds/excludes/modifies
to form the final set.

### RecurrenceRule object (JSON mapping of iCal RECUR, RFC 5545 + RFC 7529 semantics)

| Field | Type | Req? | Default | Constraints |
|---|---|---|---|---|
| `@type` | String | mandatory | — | `"RecurrenceRule"` |
| `frequency` | String | **mandatory** | — | `yearly` \| `monthly` \| `weekly` \| `daily` \| `hourly` \| `minutely` \| `secondly` (lowercase FREQ) |
| `interval` | UnsignedInt | optional | `1` | MUST be ≥ 1 |
| `rscale` | String | optional | `"gregorian"` | Lowercase CLDR calendar-system name or vendor value (RSCALE, RFC 7529) |
| `skip` | String | optional | `"omit"` | `omit` \| `backward` \| `forward`; only effective for `yearly`/`monthly` frequency |
| `firstDayOfWeek` | String | optional | `"mo"` | `mo` `tu` `we` `th` `fr` `sa` `su` (WKST) |
| `byDay` | NDay[] | optional | — | NDay: `@type:"NDay"` (mandatory), `day` (mandatory, same 2-letter values), `nthOfPeriod` Int optional, positive or negative, MUST NOT be 0 (−1 = last occurrence in the month/year period) |
| `byMonthDay` | Int[] | optional | — | 1..max-days-of-month for the rscale and negatives (Gregorian: 1..31, −31..−1); ≥1 entry if present |
| `byMonth` | String[] | optional | — | **Strings**, `"1"`-based, optional uppercase `"L"` suffix for leap months (e.g. `"3L"`); ≥1 entry |
| `byYearDay` | Int[] | optional | — | ±1..±max-days-of-year (Gregorian ±366); ≥1 entry |
| `byWeekNo` | Int[] | optional | — | ±1..±max-weeks (Gregorian ±53); ISO week numbering relative to `firstDayOfWeek`; ≥1 entry |
| `byHour` | UnsignedInt[] | optional | — | 0–23; ≥1 entry |
| `byMinute` | UnsignedInt[] | optional | — | 0–59; ≥1 entry |
| `bySecond` | UnsignedInt[] | optional | — | 0–60 (leap second allowed); ≥1 entry |
| `bySetPosition` | Int[] | optional | — | Indexes into the ordered candidate list after byX filtering; negatives from end (−1 = last); ≥1 entry |
| `count` | UnsignedInt | optional | — | **Mutually exclusive with `until`** |
| `until` | LocalDateTime | optional | — | Last occurrence on-or-before this; interpreted in the object's `timeZone`; **mutually exclusive with `count`** |

Interpretation notes (worth encoding in tool descriptions):

- The initial `start` is **always the first occurrence** (counted against `count`) even if it
  doesn't match the rule.
- Implicit byX injection: if frequency > secondly and no `bySecond`, the start's seconds value is
  implied; same cascade for `byMinute`/`byHour`; weekly implies `byDay` of start's weekday; monthly
  implies `byMonthDay` of start's day; yearly has a three-branch implication for
  `byMonth`/`byMonthDay`/`byDay` (Section 4.3.3.1, extra rule 3).
- `skip` semantics: with non-Gregorian rscale or e.g. `byMonthDay: [31]` monthly, invalid dates
  (Feb 31) are omitted (`omit`), rolled to first day of next month (`forward`), or last day of the
  current month (`backward`); duplicates produced by skipping are eliminated.

### excludedRecurrenceRules

Same RecurrenceRule[] semantics, except the initial date-time (`start`) is only part of the
exclusion expansion **if it matches the rule**. Resulting set subtracted from `recurrenceRules`
output.

### recurrenceOverrides — `LocalDateTime[PatchObject]`

- **Key**: a LocalDateTime recurrence id (the date-time produced by the rule, in the event's
  `timeZone`).
- Key not produced by any rule → **extra occurrence** (RDATE equivalent); patch may be `{}`.
- Patch `{"excluded": true}` → occurrence removed (EXDATE equivalent); such a patch **MUST NOT
  patch anything else**.
- By default an occurrence inherits everything from the base except `start`, which shifts to the
  recurrence id. Patching `start` is valid and takes precedence over the id-derived value; both the
  id and patched start may lie **before** the base object's start.
- Pointers **ignored** (may-not-be-patched) if they start with: `@type`,
  `excludedRecurrenceRules`, `method`, `privacy`, `prodId`, `recurrenceId`, `recurrenceIdTimeZone`,
  `recurrenceOverrides`, `recurrenceRules`, `relatedTo`, `replyTo`, `sentBy`, `timeZones`, `uid`.
- `excluded` (Boolean, default false) is the per-occurrence flag itself; on a standalone occurrence
  object true = remove from expansion.
- `recurrenceId`/`recurrenceIdTimeZone` are for standalone occurrence objects only and mutually
  exclusive with rules/overrides on the same object.

## 4. Participant object (all `@type:"Participant"`)

| Field | Type | Req? | Default | Notes |
|---|---|---|---|---|
| `name` | String | opt | — | Display name |
| `email` | String | opt | — | RFC 5322 addr-spec |
| `description` | String | opt | — | Plain-text about the participant/role |
| `sendTo` | String[String] | opt | — | Method → URI; keys ASCII alnum only. `"imip"` → MUST be `mailto:` URI (may differ from `email`); `"other"` → any URI, undefined method. Omit rather than `{}` |
| `kind` | String | opt | — | `individual` \| `group` \| `location` \| `resource` |
| `roles` | String[Boolean] | **mandatory** | — | ≥1 role; values MUST be `true`. Registered: `owner`, `attendee`, `optional`, `informational`, `chair`, `contact`. `attendee` beats `informational` if both present; unknown roles MUST be preserved |
| `locationId` | Id | opt | — | Where this participant attends; dangling id ⇒ treat as omitted |
| `language` | String | opt | — | RFC 5646 tag |
| `participationStatus` | String | opt | `"needs-action"` | `needs-action` \| `accepted` \| `declined` \| `tentative` \| `delegated` |
| `participationComment` | String | opt | — | Free-text note explaining status |
| `expectReply` | Boolean | opt | `false` | Organizer expects an RSVP |
| `scheduleAgent` | String | opt | `"server"` | `server` \| `client` \| `none` — who sends scheduling messages |
| `scheduleForceSend` | Boolean | opt | `false` | Write-only request flag; MUST NOT be stored server-side or appear in scheduling messages |
| `scheduleSequence` | UnsignedInt | opt | `0` | Sequence of participant's last response |
| `scheduleStatus` | String[] | opt | — | iCal `statcode` values from last scheduling send; server-managed; MUST NOT appear in scheduling messages |
| `scheduleUpdated` | UTCDateTime | opt | — | Timestamp of most recent response (out-of-order detection) |
| `sentBy` | String | opt | — | addr-spec of From header of last iMIP update, only if ≠ the `sendTo.imip` address |
| `invitedBy` | Id | opt | — | Participant id of who added this participant |
| `delegatedTo` | Id[Boolean] | opt | — | Set of participant ids (values `true`); omit if empty |
| `delegatedFrom` | Id[Boolean] | opt | — | Set of participant ids; omit if empty |
| `memberOf` | Id[Boolean] | opt | — | Group-participant ids whose membership caused this invite; omit if empty |
| `links` | Id[Link] | opt | — | e.g. vCard/avatar; omit if empty |
| `progress`, `progressUpdated`, `percentComplete` | — | — | — | **Task-participant only — exclude from Event schemas** |

**Organizer representation — exact mechanics**: there is no `organizer` property. The organizer's
*response address* is the event-level `replyTo` map (methods `imip` → `mailto:` URI, `web` →
`https:` URL, `other` → any URI; keys ASCII alnum; omit if empty). The organizer as a *person* is a
normal entry in `participants` carrying `"owner": true` in `roles` (often combined with
`attendee`/`chair`, as in the RFC's own example). Constraint: if any participant has `sendTo`,
`replyTo` MUST define at least one method. `sequence` is not bumped for participant-only changes
(so RSVPs don't invalidate iTIP sequencing).

## 5. Location & VirtualLocation

**Location** (`@type:"Location"` mandatory; MUST have ≥1 property other than `relativeTo`):

| Field | Type | Notes |
|---|---|---|
| `name` | String opt | Human-readable name |
| `description` | String opt | Plain-text access instructions (address, directions, door code) |
| `locationTypes` | String[Boolean] opt | Keys from IANA Location Types Registry (RFC 4589); values `true` |
| `relativeTo` | String opt | `"start"` \| `"end"` — for travel events (departure/arrival); unknown values treated as omitted |
| `timeZone` | TimeZoneId opt | Location's zone (arrival zone display for flights) |
| `coordinates` | String opt | `geo:` URI (RFC 5870) |
| `links` | Id[Link] opt | Omit rather than empty |

**VirtualLocation** (`@type:"VirtualLocation"` mandatory):

| Field | Type | Notes |
|---|---|---|
| `uri` | String **mandatory** | How to connect — `https:` URL, `tel:+1-555-555-5555`, any custom URI |
| `name` | String opt, default `""` | |
| `description` | String opt | e.g. access code |
| `features` | String[Boolean] opt | Values `true`; registered keys: `audio`, `chat`, `feed`, `moderator`, `phone`, `screen`, `video` |

## 6. Alert object (`@type:"Alert"`)

| Field | Type | Req? | Default | Notes |
|---|---|---|---|---|
| `trigger` | OffsetTrigger \| AbsoluteTrigger \| UnknownTrigger | **mandatory** | — | Discriminated union on `@type` |
| `acknowledged` | UTCDateTime | opt | — | Set on dismissal; syncing clients suppress duplicate alerts triggered on/before this. For recurring objects: MUST be set on the **base** alert, MUST NOT create a new recurrenceOverride. For feedback-less actions (email) set immediately on successful send |
| `relatedTo` | String[Relation] | opt | — | **Snooze mechanism**: snoozing creates a *new* alert that triggers after the snooze period and MUST set a `parent` relation to the original alert's id |
| `action` | String | opt | `"display"` | `"display"` \| `"email"` (email typically server-side only) |

- **OffsetTrigger**: `@type:"OffsetTrigger"`, `offset` SignedDuration mandatory (negative = before
  anchor, e.g. `"-PT15M"`), `relativeTo` optional, default `"start"`, values `"start"` \| `"end"`
  (end = start + duration for events).
- **AbsoluteTrigger**: `@type:"AbsoluteTrigger"`, `when` UTCDateTime mandatory.
- **UnknownTrigger**: any object with unrecognized `@type`; SHOULD NOT trigger, MUST preserve.

## 7. Remaining shared structures

**Link** (`@type:"Link"` mandatory): `href` String **mandatory** (URI; `data:` allowed but
discouraged); `cid` opt (RFC 2392 content-id, unique within this Link, may differ from the link's
map Id); `contentType` opt (media type); `size` UnsignedInt opt (decoded octets, informational);
`rel` opt (IANA Link Relations value); `display` opt (requires `rel:"icon"`; `badge` \| `graphic`
\| `fullsize` \| `thumbnail`); `title` opt (plain text).

**Relation** (`@type:"Relation"` mandatory): `relation` String[Boolean] opt, default `{}`; keys:
`first` \| `next` \| `child` \| `parent` (or registered/vendor); values `true`.

**localizations** `String[PatchObject]`: key = RFC 5646 language tag; patches applied to the
top-level object; patched object's `locale` is set to the tag. Every pointer MUST **end** with
`title`, `description`, or `name` (else ignored) — so `locations/abcd/name` ✔, `uid` ✘. Pointer
MUST NOT have prefix `recurrenceOverrides` — localize an override by patching the `localizations`
property *inside* the override instead.

**privacy** values: `public` (default, full detail shared) / `private` (only time+metadata shared;
whitelisted shareable props:
`@type,created,due,duration,estimatedDuration,freeBusyStatus,privacy,recurrenceOverrides` (only
patches to permissible props) `,sequence,showWithoutTime,start,timeZone,timeZones,uid,updated`) /
`secret` (hidden entirely). Unknown values → preserve, treat as `private`. Never affects scheduling
messages.

Quick recap of singles: `freeBusyStatus` `free|busy` (default `busy`); `status`
`confirmed|cancelled|tentative` (default `confirmed`); `priority` Int 0–9 (0 undefined, 1 highest,
9 lowest, default 0); `sequence` UnsignedInt default 0, not bumped for participants-only edits;
`method` lowercase iTIP, scheduling messages only; `prodId` globally unique writer id;
`created`/`updated` UTCDateTime (`updated` mandatory); `showWithoutTime` Boolean default false
(all-day flag; time still used for free-busy); `useDefaultAlerts` Boolean default false (true ⇒
ignore `alerts`; fall back to processing `alerts` if defaults unavailable).

## 8. PatchObject — exact definition (§1.4.9)

Type `String[*]`. Keys are JSON Pointer (RFC 6901) paths **with implicit leading `/`** (prepend `/`
before evaluating; so the key is `locations/loc1/name`, not `/locations/loc1/name`). Value
semantics: `null` ⇒ remove the property (no-op if absent; the property MUST be optional); non-null
⇒ set/replace (must be type-valid for the target property).

Validity rules — a PatchObject is valid only if **all** hold, and implementations MUST reject the
whole PatchObject (no partial application) if any patch is invalid:

1. Pointer MUST NOT reference **inside an array** — arrays are replaced wholesale.
2. All path segments except the last MUST already exist on the object being patched (no implicit
   intermediate-object creation — to add `locations/newloc/name` when `locations` doesn't exist,
   patch `locations` with a full map).
3. No two patches where one pointer is a prefix of the other (e.g. `alerts/1/offset` + `alerts` is
   invalid).
4. Value must be valid for the property; `null` only for optional properties.

PatchObject itself has no `@type`; a key literally named `@type` is treated as an ordinary patched
property. JSON Pointer escaping applies: `~` → `~0`, `/` → `~1` in key segments (relevant for map
keys containing `/`, e.g. custom TimeZoneIds).

## 9. LLM-facing "surprising/cool" notes worth conveying

- **UTC start times are an anti-pattern**: the spec exists partly because storing starts in UTC
  breaks when tz rules change. Always LocalDateTime + `timeZone`; omit `timeZone` deliberately only
  for floating (wall-clock-everywhere) events like the "yoga at 7am wherever I am" example.
- **The converse relabel footgun**: `timeZone` is the interpretation frame for `start`, not a
  display label. Patching `timeZone` alone rebases the wall-clock onto the new zone and silently
  shifts the absolute instant (16:00 Etc/UTC "relabeled" Europe/Moscow moves the event 3h early).
  An instant-preserving relabel must convert `start` into the new zone in the same patch
  (16:00 Etc/UTC → 19:00 Europe/Moscow). Confirmed live incident, 2026-07-08.
- **All-day ≠ dateless**: `showWithoutTime: true` + `start: "1900-04-01T00:00:00"` +
  `duration: "P1D"` is the RFC's all-day idiom.
- **Non-Gregorian recurrence** via `rscale` (any CLDR calendar: `chinese`, `hebrew`, `islamic`…),
  with `"L"`-suffixed leap months in `byMonth` and `skip` to resolve nonexistent dates (also useful
  in Gregorian for "31st of every month" with `skip:"backward"`).
- **Multi-time-zone travel events**: one `start`/`timeZone`/`duration`, plus two Location entries
  with `relativeTo:"start"` / `relativeTo:"end"` and the arrival Location's own `timeZone` (flight
  example, §6.6).
- **Three-layer recurrence exceptions**: rules generate, excludedRecurrenceRules subtract by rule,
  recurrenceOverrides add (`{}` patch), remove (`{"excluded":true}`, nothing else patched), or
  mutate (arbitrary patch incl. `start`) individual instances. Overrides may predate the base start
  (the "optional intro lecture before week 1" example).
- **Per-occurrence RSVP** is just an override patching one deep path:
  `"participants/<id>/participationStatus": "declined"`.
- **Per-language patches**: `localizations` is a language-tag → PatchObject map, restricted to
  `title`/`description`/`name` leaf paths — translate the virtual-location name, not the uid.
- **Snooze = new alert with `relatedTo: {origAlertId: {"@type":"Relation","relation":{"parent":true}}}`**;
  acknowledge on the base alert of recurring events, never via a new override.
- **Sets are maps-to-true** everywhere (`keywords`, `roles`, `features`, `delegatedTo`,
  `locationTypes`, Relation.relation…) — Zod: `z.record(z.literal(true))`.
- **"Omit rather than empty"** is a recurring MUST: `replyTo`, `sendTo`, `delegatedTo/From`,
  `memberOf`, Location/Participant `links` must be absent instead of `{}`.
- **Canonical datetime/duration forms**: no `.000` fractions, no trailing zeros, uppercase letters,
  `Z` only for UTCDateTime — schemas should normalize/regex-enforce.
- **count/until mutual exclusion** and **recurrenceId ⟂ recurrenceRules/recurrenceOverrides** and
  **recurrenceIdTimeZone iff recurrenceId** are the three cross-field invariants worth Zod
  `superRefine`s.
- **Series splits** ("this and future"): truncate original, new object gets `relatedTo` with
  `first`; original gets `next`.
- Registry-table erratum to ignore: IANA table lists TimeZoneRule `offsetFrom`/`offsetTo` as
  UTCDateTime; the spec text (§4.7.2) correctly says String (UTC offsets like `+0100`).

## 10. Non-Event properties to EXCLUDE from Event schemas

- **Task-only** (top level): `due` (LocalDateTime, opt), `start` becomes *optional* on Task,
  `estimatedDuration` (Duration), `percentComplete` (UnsignedInt 0–100), `progress`
  (`needs-action|in-process|completed|failed|cancelled`), `progressUpdated` (UTCDateTime). Task
  recurs from `start` else `due`; neither ⇒ no `recurrenceRules` allowed. Task has **no**
  `duration` and **no** `status`.
- **Task-participant-only**: `progress` (only when participationStatus = `accepted`),
  `progressUpdated`, `percentComplete` on Participant.
- **Group-only**: `entries` ((Task|Event)[], mandatory), `source` (URI String). Group supports
  only: `@type,uid,prodId,created,updated,title,description,descriptionContentType,links,locale,keywords,categories,color,timeZones`
  — no start/recurrence/participants/alerts.
- **Event-only** (for symmetry): `duration`, `status`.

## Live-Stalwart observations (probed 2026-07-08 against mail.astrius.ink, v0.16.11)

- Real events come back with `@type: "Event"`, `calendarIds` as a **map** (JMAP layer), `isDraft`,
  `isOrigin`, LocalDateTime `start` + `timeZone`, `duration`, participants keyed by UUID-ish ids
  with `calendarAddress` (JMAP-calendars property), `roles` maps, `replyTo.imip`.
- `CalendarEvent/query` with `expandRecurrences: true` **requires both `after` and `before`**
  filter bounds (invalidArguments otherwise).
- Expanded recurrence instances are first-class addressable objects: synthetic `id` (e.g.
  `daaaaaha`), `baseEventId` (e.g. `ha`), `recurrenceId` (LocalDateTime), plus server-computed
  `utcStart`/`utcEnd`. They can be fetched by id directly with `CalendarEvent/get`.
