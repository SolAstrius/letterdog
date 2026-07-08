# JMAP Schema-Design Digest — RFC 8620 (Core) + RFC 8621 (Mail)

Reference notes for typed Zod schemas / MCP tool descriptions fronting Stalwart. Verified against
`rfc-editor.org/rfc/rfc8620.txt` and `rfc8621.txt` (fetched 2026-07-08).

---

## PART 1 — RFC 8620 (Core)

### 1.1 Session object & limits worth surfacing

Session props: `capabilities`, `accounts: Id[Account]`, `primaryAccounts: String[Id]` (capability
URI → default accountId), `username`, `apiUrl`, `downloadUrl`, `uploadUrl`, `eventSourceUrl` (all
URI Template level 1), `state` (changes when any Session prop changes; echoed as `sessionState` on
every API response). Account: `{name, isPersonal, isReadOnly, accountCapabilities}`.

`urn:ietf:params:jmap:core` capability object (suggested minimums in parens):

| Limit | Meaning |
|---|---|
| `maxSizeUpload` (50 MB) | max single file upload, octets |
| `maxConcurrentUpload` (4) | concurrent upload-endpoint requests |
| `maxSizeRequest` (10 MB) | max API request size, octets |
| `maxConcurrentRequests` (4) | concurrent API requests |
| `maxCallsInRequest` (16) | max method calls per request |
| `maxObjectsInGet` (500) | max ids per /get call (`ids: null` = all, only if count ≤ this) |
| `maxObjectsInSet` (500) | combined create+update+destroy count per /set call |
| `collationAlgorithms` | RFC 4790 collation ids usable in Comparator |

Exceeding maxObjectsInGet/InSet → method-level `requestTooLarge`. Exceeding request-wide limits →
HTTP-level `urn:ietf:params:jmap:error:limit` with a `limit` property naming the limit.

### 1.2 Error hierarchy (3 levels — type each separately)

1. **Request-level** (HTTP error + RFC 7807 problem details):
   `urn:ietf:params:jmap:error:unknownCapability | notJSON | notRequest | limit`.
2. **Method-level** (`["error", {type, ...}, callId]` in methodResponses; other calls still
   processed; server state unchanged except `serverPartialFail`): `serverUnavailable` (retry w/
   backoff), `serverFail`, `serverPartialFail` (client MUST resync), `unknownMethod`,
   `invalidArguments` (+optional `description`, non-localised), `invalidResultReference`,
   `forbidden`, `accountNotFound`, `accountNotSupportedByMethod`, `accountReadOnly`. Unknown type ⇒
   treat as `serverFail`. Per-method extras: /get+/set `requestTooLarge`; /set `stateMismatch`;
   /changes+/queryChanges `cannotCalculateChanges` (client MUST invalidate cache); /queryChanges
   `tooManyChanges`; /query `anchorNotFound`, `unsupportedSort`, `unsupportedFilter`; /copy
   `fromAccountNotFound`, `fromAccountNotSupportedByMethod`, `stateMismatch`.
3. **Per-item SetError** inside a successful /set response (see 1.4).

### 1.3 Result references (back-references)

- Argument name prefixed `#` (e.g. `#ids`); value is
  `ResultReference {resultOf: callId, name: methodName, path: jsonPointer}`.
- Resolution: find **first** prior response with matching call id; response name must equal `name`;
  apply `path` as RFC 6901 JSON Pointer **extended with `*`** which maps over an array and
  **flattens** one level (array-of-arrays → single array).
- Any resolution failure ⇒ whole method rejected `invalidResultReference`. Supplying both `foo` and
  `#foo` ⇒ `invalidArguments`.
- Distinct concept: **creation references** — `#creationId` used as a foreign-key *value* in later
  /set creates within the same request (referenced record must be created in same or earlier call;
  creation-id map is request-global, not per-type; reuse maps to most recent).
- Canonical chain: `Email/query → Email/get(#ids:/ids, properties:[threadId]) →
  Thread/get(#ids:/list/*/threadId) → Email/get(#ids:/list/*/emailIds)`.

### 1.4 /set semantics

Args: `accountId`, `ifInState: String|null` (mismatch ⇒ whole method aborts with `stateMismatch`),
`create: Id[Foo]|null` (creation id → object; server-set props MUST be omitted),
`update: Id[PatchObject]|null`, `destroy: Id[]|null`.

**PatchObject** (`String[*]`): keys are JSON Pointers with implicit leading `/`. Rules (violation ⇒
`invalidPatch` SetError):

- MUST NOT point inside an array (arrays are replaced whole).
- All path segments except the last MUST already exist on the object.
- No key may be a prefix of another key in the same patch.

Value semantics: `null` ⇒ reset to default if defined, else **remove** the property (no-op if
absent); anything else ⇒ set/replace. A whole Foo object is a valid PatchObject. Server-set props
MAY appear in a patch iff identical to current server value, else `invalidProperties`.

Execution: each create/update/destroy is **atomic per record**; partial failure across records is
allowed and processing continues (never terminates the method); a single record update is never
partially applied. Final state must be valid (intermediate invalid states OK, e.g. name swaps).

Response: `accountId`, `oldState: String|null`, `newState`, `created: Id[Foo]|null` (creationId →
server-set + defaulted props, incl. `id`), `updated: Id[Foo|null]|null` (id → props changed
*beyond* what the patch requested, or null), `destroyed: Id[]|null`,
`notCreated/notUpdated/notDestroyed: Id[SetError]|null`.

**SetError** `{type, description: String|null, ...extras}`:

| type | applies to | notes |
|---|---|---|
| `forbidden` | c/u/d | ACL/permission violation |
| `overQuota` | c/u | count or total-size quota |
| `tooLarge` | c/u | single-object size limit |
| `rateLimit` | c | retry later may work |
| `notFound` | u/d | id doesn't exist |
| `invalidPatch` | u | PatchObject rule violation |
| `willDestroy` | u | same id also destroyed in this call; update skipped |
| `invalidProperties` | c/u | bad props / server-set prop mismatch / dangling foreign key. SHOULD carry `properties: String[]` listing all invalid props |
| `singleton` | c/d | singleton type — can't create another / destroy the one |
| `alreadyExists` | copy/import | MUST carry `existingId: Id` |

### 1.5 /get, /changes

**/get**: `{accountId, ids: Id[]|null (null = all), properties: String[]|null (null = all; id
always included)}`. Invalid property ⇒ `invalidArguments`. Response `{accountId, state, list: Foo[]
(order not guaranteed; dupes collapsed), notFound: Id[]}`.

**/changes**: `{accountId, sinceState, maxChanges: UnsignedInt|null (>0)}` → `{accountId, oldState,
newState, hasMoreChanges, created: Id[], updated: Id[], destroyed: Id[]}`. Created+destroyed within
window SHOULD be omitted entirely; total ids across three arrays ≤ maxChanges; server pages via
intermediate states (newest-first recommended). Servers SHOULD support states ≤30 days old; else
`cannotCalculateChanges`.

### 1.6 /query

| Arg | Type | Semantics |
|---|---|---|
| `filter` | `FilterOperator\|FilterCondition\|null` | Operator: `{operator: "AND"\|"OR"\|"NOT", conditions: [...]}`, arbitrarily nested. FilterCondition = type-specific object, MUST NOT have `operator` key |
| `sort` | `Comparator[]\|null` | `{property, isAscending=true, collation?, ...extras}`. Tie-broken by next comparator; final order server-dependent but stable |
| `position` | `Int` (default 0) | **Negative = offset from end** (added to total, clamped to 0). Past-end ⇒ empty ids, not an error |
| `anchor` | `Id\|null` | If given, `position` ignored. Index of anchor + `anchorOffset` (clamped ≥0) becomes effective position. Not found ⇒ `anchorNotFound` error |
| `anchorOffset` | `Int` (default 0) | may be negative (−1 = item before anchor first) |
| `limit` | `UnsignedInt\|null` | negative ⇒ `invalidArguments`; server may clamp and reports actual `limit` in response |
| `calculateTotal` | `Boolean` (default false) | totals may be expensive — request only when needed |

Response: `{accountId, queryState, canCalculateChanges, position: UnsignedInt (actual), ids: Id[],
total? (only if requested), limit? (only if server clamped)}`. `queryState` covers only the ordered
id list for this filter+sort; `canCalculateChanges` = /queryChanges likely supported for this
filter/sort (not guaranteed).

**/queryChanges**: args `{accountId, filter, sort (same as original query), sinceQueryState,
maxChanges, upToId: Id|null (ignore changes past this index if filter+sort immutable),
calculateTotal}` → `{accountId, oldQueryState, newQueryState, total?, removed: Id[], added: [{id,
index}] (sorted by index asc)}`. Client applies: splice out removed, splice in added by index.
Mutable filter/sort props force affected ids into both removed+added. Errors: `tooManyChanges`,
`cannotCalculateChanges`.

### 1.7 Binary data

- **Upload**: POST body to `uploadUrl` template (var: `accountId`), Content-Type = media type.
  Response: `{accountId, blobId, type, size}`. blobId = raw bytes only (no name/type metadata),
  immutable; identical content MAY dedupe to same blobId.
- **Expiry**: unreferenced blobs live ≥1 hour (barring quota pressure; oldest deleted first);
  reupload MAY return same id and SHOULD reset expiry. Blob never deleted during the method call
  that dropped its last reference. Unreferenced blobs visible only to uploader.
- **Download**: GET `downloadUrl` template with vars `accountId`, `blobId`, `type` (echoed as
  response Content-Type), `name` (filename for Content-Disposition). Responses are immutable →
  long cache OK.
- **Blob/copy** (cross-account): `{fromAccountId, accountId, blobIds}` → `{copied: Id[Id]|null,
  notCopied: Id[SetError]|null}`.
- Any existing blobId in the account is reusable in creates (e.g. re-attach an old attachment
  without download/upload). Server MAY re-issue a new blobId on create and must report it back.

### 1.8 EventSource (brief)

`eventSourceUrl` template vars: `types` (comma-sep type names or `*`), `closeafter` (`state` =
close after each push, for buffering proxies; `no`), `ping` (seconds; 0 = off). Pushes `state`
events carrying StateChange objects; `EmailDelivery` pseudo-type (8621) changes only when new mail
arrives — cheap new-mail notifications.

### 1.9 /copy (cross-account move step 1)

`{fromAccountId, ifFromInState, accountId (≠ from), ifInState, create: Id[Foo] (each MUST have
"id" = source id; other props override), onSuccessDestroyOriginal=false, destroyFromIfInState}`.
Copy-then-destroy is **not atomic**. Response mirrors /set create half; `alreadyExists` SetError
carries `existingId`.

---

## PART 2 — RFC 8621 (Mail)

### 2.1 Mail capability objects (per-account)

`urn:ietf:params:jmap:mail`: `maxMailboxesPerEmail: UnsignedInt|null (≥1)`, `maxMailboxDepth`,
`maxSizeMailboxName (≥100 octets)`, `maxSizeAttachmentsPerEmail` (sum of **unencoded** attachment
sizes), `emailQuerySortOptions: String[]`, `mayCreateTopLevelMailbox: Boolean`.
`urn:ietf:params:jmap:submission`: `maxDelayedSend` (seconds; 0 = no delayed send),
`submissionExtensions: String[String[]]` (EHLO name → args; e.g. FUTURERELEASE, SIZE, DSN).
`urn:ietf:params:jmap:vacationresponse`: `{}`.
Note: **no `maxKeywordsPerEmail` capability exists** — keyword limits surface only via the
`tooManyKeywords` SetError.

### 2.2 Mailbox

| Property | Type | Notes |
|---|---|---|
| `id` | Id | immutable, server-set |
| `name` | String | Net-Unicode ≥1 char; unique among siblings |
| `parentId` | Id\|null (default null) | forest; no loops |
| `role` | String\|null | IANA "IMAP Mailbox Name Attributes" registry, lowercased: `inbox`, `archive`, `drafts`, `sent`, `trash`, `junk`, `all`, `flagged`, `important`. Max one Mailbox per role per account; one role per Mailbox. Roles optional |
| `sortOrder` | UnsignedInt (default 0) | lower first among siblings; ties alphabetical |
| `totalEmails` / `unreadEmails` | UnsignedInt, server-set | unread = neither `$seen` nor `$draft` |
| `totalThreads` / `unreadThreads` | UnsignedInt, server-set | thread counted if ≥1 Email in Mailbox; trash isolated (trash-only mail excluded from other mailboxes' counts and vice versa) |
| `myRights` | MailboxRights, server-set | `mayReadItems, mayAddItems, mayRemoveItems, maySetSeen, maySetKeywords, mayCreateChild, mayRename, mayDelete, maySubmit` |
| `isSubscribed` | Boolean | per-user for shared mailboxes |

Methods: `Mailbox/get` (ids:null OK), `Mailbox/changes` (extra response arg `updatedProperties:
String[]|null` — set when only the 4 count props changed, chainable via back-ref into Mailbox/get
`#properties`), `Mailbox/query` (extra args `sortAsTree`, `filterAsTree`; FilterCondition:
`parentId: Id|null`, `name` (contains), `role: String|null` (exact), `hasAnyRole: Boolean`,
`isSubscribed: Boolean` — implicit AND; sort props MUST support `sortOrder`, `name`), `Mailbox/set`
(extra arg `onDestroyRemoveEmails=false`; destroy SetErrors: `mailboxHasChild`, `mailboxHasEmail`).

### 2.3 Thread

Thread = flat list of Emails sorted by `receivedAt` asc. Object: `{id (immutable server-set),
emailIds: Id[] (server-set)}`. `threadId` on Email is immutable. Suggested threading: same Thread
iff (1) shared msg-id across Message-Id/In-Reply-To/References **and** (2) same subject after
stripping Re:/Fwd:/[List-Tag] prefixes (prevents subject-change hijack). Methods: `Thread/get`,
`Thread/changes`.

### 2.4 Email object properties

**Metadata** (not parsed from message):

| Property | Type | Notes |
|---|---|---|
| `id` | Id, immutable server-set | JMAP id, **not** Message-ID |
| `blobId` | Id, immutable server-set | raw RFC 5322 octets — download or re-attach |
| `threadId` | Id, immutable server-set | |
| `mailboxIds` | `Id[Boolean]` | values MUST be true; must be non-empty at all times |
| `keywords` | `String[Boolean]` (default {}) | values true; lowercase on return |
| `size` | UnsignedInt, immutable server-set | raw message octets |
| `receivedAt` | UTCDate, immutable (default: server arrival time) | IMAP internaldate — this is what `before`/`after` filter on |

**Header-derived convenience props** (all immutable; each ≡ a `header:` form):

| Property | Type | Equivalent |
|---|---|---|
| `messageId` | String[]\|null | `header:Message-ID:asMessageIds` |
| `inReplyTo` | String[]\|null | `header:In-Reply-To:asMessageIds` |
| `references` | String[]\|null | `header:References:asMessageIds` |
| `sender`, `from`, `to`, `cc`, `bcc`, `replyTo` | EmailAddress[]\|null | `header:<X>:asAddresses` |
| `subject` | String\|null | `header:Subject:asText` |
| `sentAt` | Date\|null (default on create: server time) | `header:Date:asDate` |

`EmailAddress = {name: String|null, email: String}` (best-effort parse; email may be malformed for
drafts). `EmailAddressGroup = {name: String|null, addresses: EmailAddress[]}`.
`headers: EmailHeader[]` (immutable) = all fields in order, `{name, value(Raw)}`.

**Dynamic accessor grammar**: `header:{Field-Name}[:as{Form}][:all]` (suffix order fixed; field
matched case-insensitively; without `:all` returns the **last** instance or null; with `:all`
returns array).

| Form | Type | Allowed fields |
|---|---|---|
| Raw (default) | String | any (typically has leading space) |
| `asText` | String | Subject, Comments, Keywords, List-Id, + any non-RFC5322/2369 field |
| `asAddresses` | EmailAddress[] | From, Sender, Reply-To, To, Cc, Bcc, Resent-* variants, + non-standard |
| `asGroupedAddresses` | EmailAddressGroup[] | same as asAddresses |
| `asMessageIds` | String[]\|null | Message-ID, In-Reply-To, References, Resent-Message-ID (angle brackets stripped; null on parse failure) |
| `asDate` | Date\|null | Date, Resent-Date |
| `asURLs` | String[]\|null | List-Help/Unsubscribe/Subscribe/Post/Owner/Archive |

**Body props** (all immutable): `bodyStructure: EmailBodyPart` (full MIME tree, no recursion into
message/rfc822), `bodyValues: String[EmailBodyValue]`, `textBody: EmailBodyPart[]`,
`htmlBody: EmailBodyPart[]`, `attachments: EmailBodyPart[]`, `hasAttachment: Boolean` (server-set;
SHOULD be true iff attachments has a non-inline item), `preview: String` (server-set, ≤256 chars).

### 2.5 EmailBodyPart & the body-list algorithm

`EmailBodyPart`: `partId: String|null` (null iff multipart/\*; scoped to this Email),
`blobId: Id|null` (null iff multipart/\*; content **after** transfer-decoding),
`size: UnsignedInt` (decoded octets), `headers: EmailHeader[]`, `name: String|null`
(Content-Disposition filename, else Content-Type name), `type: String` (params stripped; defaults
text/plain), `charset: String|null` (us-ascii default for text/\*; null for non-text),
`disposition: String|null` (params stripped), `cid: String|null` (angle brackets stripped; for
`cid:` refs), `language: String[]|null`, `location: String|null`,
`subParts: EmailBodyPart[]|null` (iff multipart/\*). Also supports `header:...` accessors per-part.

`EmailBodyValue`: `{value: String (transfer- and charset-decoded, CRLF→LF),
isEncodingProblem=false, isTruncated=false}`. String length ≠ part `size`.

**textBody/htmlBody/attachments rules** (suggested algorithm): walk tree depth-first. A leaf is
*inline* if `disposition != "attachment"` AND type ∈ {text/plain, text/html, image/\*, audio/\*,
video/\*} AND (it's the first child, or parent isn't multipart/related and (it's media or has no
filename)). Inside `multipart/alternative`: text/plain → textBody, text/html → htmlBody, other
inline → attachments; if only one side found, the other list gets the same parts (so a part may
appear in both lists). Outside alternatives, inline parts append to both lists; inline media not in
both lists also goes to attachments. Everything non-inline → attachments. Attached `message/*`
parts appear in attachments without subParts — use `Email/parse` on their blobId.

### 2.6 Email/get

Extra args: `bodyProperties: String[]` (default `[partId, blobId, size, name, type, charset,
disposition, cid, language, location]`), `fetchTextBodyValues=false`, `fetchHTMLBodyValues=false`,
`fetchAllBodyValues=false`, `maxBodyValueBytes: UnsignedInt=0` (0 = no truncation; truncation is
UTF-8-safe, avoids mid-HTML-tag).
Default `properties` (when omitted/null — NOT "all"): `[id, blobId, threadId, mailboxIds, keywords,
size, receivedAt, messageId, inReplyTo, references, sender, from, to, cc, bcc, replyTo, subject,
sentAt, hasAttachment, preview, bodyValues, textBody, htmlBody, attachments]`. "Fast" properties =
that set minus references/bodyValues/textBody/htmlBody/attachments.

### 2.7 Email/query

Extra arg: `collapseThreads=false` — after filter+sort, keep only the first Email per threadId.
`Email/queryChanges` takes the same `collapseThreads`. `total` with a bare `inMailbox` filter ≡
mailbox `totalEmails`/`totalThreads` (fast).

**FilterCondition — complete list** (implicit AND across props; empty condition = true):

| Property | Type | Matches |
|---|---|---|
| `inMailbox` | Id | Email in this Mailbox |
| `inMailboxOtherThan` | Id[] | in ≥1 Mailbox **not** in list (exclude trash/spam-only) |
| `before` | UTCDate | `receivedAt` < value (**not sentAt**) |
| `after` | UTCDate | `receivedAt` ≥ value (inclusive) |
| `minSize` | UnsignedInt | size ≥ value |
| `maxSize` | UnsignedInt | size < value |
| `allInThreadHaveKeyword` | String | every Email in thread has kw |
| `someInThreadHaveKeyword` | String | ≥1 Email in thread has kw |
| `noneInThreadHaveKeyword` | String | no Email in thread has kw |
| `hasKeyword` / `notKeyword` | String | this Email has / lacks kw |
| `hasAttachment` | Boolean | equals `hasAttachment` prop |
| `text` | String | From+To+Cc+Bcc+Subject, SHOULD include text bodies |
| `from` / `to` / `cc` / `bcc` / `subject` | String | text in that header |
| `body` | String | text in body parts |
| `header` | String[] (len 1–2) | `[name]` = field exists; `[name, text]` = field value contains text |

Text-match semantics: case-insensitive; quoted `'…'`/`"…"` = phrase search; unquoted
whitespace-split tokens all required; stemming allowed; RFC 2047 decoded first; HTML markup ignored.

**Sort properties**: MUST: `receivedAt`. SHOULD: `size`, `from`, `to`, `subject` (RFC 5256 *base
subject*, Re:-stripped), `sentAt`, `hasKeyword`, `allInThreadHaveKeyword`,
`someInThreadHaveKeyword` (the 3 keyword sorts REQUIRE an extra `keyword` prop on the Comparator).
Full server list: capability `emailQuerySortOptions`.

### 2.8 Keywords

Case-insensitive (returned lowercase), 1–255 chars from `%x21–%x7E` excluding `( ) { ] % * " \`.
System keywords: `$draft`, `$seen`, `$flagged`, `$answered`. IMAP `\Recent` not exposed; `\Deleted`
messages invisible to JMAP. IANA registry adds `$forwarded`, `$phishing` (warn + disable
links/attachments), `$junk`, `$notjunk` (both train spam filters). Patch forms for both `keywords`
and `mailboxIds`: replace whole map (`"keywords": {...}`) or per-entry patch
(`"keywords/$seen": true`, `"mailboxIds/<id>": null` to remove, `true` to add).

### 2.9 Email/set

**Create constraints** (violations SHOULD ⇒ `invalidProperties`, server MAY instead repair):

- No `headers` property anywhere — set individual `header:` props.
- No duplicate representations of one field (e.g. `from` + `header:from`).
- No forbidden parsed forms; no `Content-*` fields on the top-level Email (only on EmailBodyParts).
- `bodyStructure` XOR (`textBody`/`htmlBody`/`attachments`); bodyStructure parts must not repeat a
  header set on the Email.
- If given: `textBody` = exactly one `text/plain` part; `htmlBody` = exactly one `text/html` part.
- Per EmailBodyPart: `partId` XOR `blobId`; a `partId` must exist in `bodyValues`; `charset` and
  `size` MUST be omitted with partId (size ignored with blobId); no Content-Transfer-Encoding
  header.
- In EmailBodyValue: `isEncodingProblem`/`isTruncated` false or omitted.

Server MUST generate Message-ID and Date if absent. Drafts may be RFC-5322-invalid; strict
validation happens at submission. Destroy removes from all mailboxes; "delete to trash" = rewrite
`mailboxIds` to the trash-role mailbox only. `created` response returns `{id, blobId, threadId,
size}`.

Extra SetErrors — create: `blobNotFound` (carries `notFound: Id[]` of missing blobIds);
create+update: `tooManyKeywords`, `tooManyMailboxes`.

### 2.10 Email/copy, Email/import, Email/parse

- **Email/copy**: standard /copy; only `mailboxIds`, `keywords`, `receivedAt` may be overridden;
  duplicate policy may reject with `alreadyExists` (+`existingId`).
- **Email/import**: `{accountId, ifInState, emails: Id[EmailImport]}`; `EmailImport = {blobId,
  mailboxIds (≥1 required), keywords={}, receivedAt (default: latest Received header, else import
  time)}`. Per-item atomic. Errors: `alreadyExists`(+existingId), `invalidProperties`, `overQuota`,
  `invalidEmail` (unparseable blob; server may repair and return a **different** blobId).
- **Email/parse**: parse blobs (e.g. attached .eml) without importing. `{accountId, blobIds,
  properties (default = Email/get default minus id/blobId/threadId/mailboxIds/keywords/size/
  receivedAt), bodyProperties, fetch*BodyValues, maxBodyValueBytes}` → `{accountId, parsed:
  Id[Email]|null, notParsable: Id[]|null, notFound: Id[]|null}`.

### 2.11 SearchSnippet/get

Args: `{accountId, filter (same shape as Email/query filter), emailIds: Id[]}` → `{accountId,
list: SearchSnippet[], notFound: Id[]|null}`. `SearchSnippet = {emailId, subject: String|null,
preview: String|null (≤255 octets)}` — HTML-escaped with matches wrapped in `<mark></mark>`; null
where no match. Errors: `requestTooLarge`, `unsupportedFilter`.

### 2.12 Identity

`{id (immutable server-set), name="", email (immutable; *@domain = wildcard mailbox part),
replyTo: EmailAddress[]|null, bcc: EmailAddress[]|null, textSignature="", htmlSignature=""
(body-snippet HTML), mayDelete: Boolean (server-set)}`. Multiple identities per address allowed.
Methods: get (ids:null OK) / changes / set (create SetError: `forbiddenFrom`).

### 2.13 EmailSubmission

Object: `id` (immutable server-set), `identityId` (immutable), `emailId` (immutable; need not be a
draft; later Email destruction doesn't cancel send), `threadId` (server-set),
`envelope: Envelope|null` (immutable), `sendAt: UTCDate` (server-set; FUTURERELEASE release time
else creation time), `undoStatus`, `deliveryStatus: String[DeliveryStatus]|null` (server-set),
`dsnBlobIds: Id[]`, `mdnBlobIds: Id[]` (server-set; multipart/report blobs, oldest first).

`Envelope = {mailFrom: Address, rcptTo: Address[]}`; `Address = {email (RFC 5321 path),
parameters: Object|null (SMTP params, e.g. HOLDFOR/HOLDUNTIL for FUTURERELEASE)}`. If envelope
omitted: mailFrom = Sender-else-From address, rcptTo = deduped To+Cc+Bcc.

**undoStatus**: `"pending" | "final" | "canceled"`. Cancel = update `undoStatus` to `"canceled"`
while pending; failure ⇒ `cannotUnsend` SetError. Delayed send = FUTURERELEASE params +
`maxDelayedSend` capability + cancel via undoStatus.

`DeliveryStatus = {smtpReply: String, delivered: "queued"|"yes"|"no"|"unknown",
displayed: "unknown"|"yes" (MDN-driven)}`.

**EmailSubmission/set extra args**: `onSuccessUpdateEmail: Id[PatchObject]|null`,
`onSuccessDestroyEmail: Id[]|null` — keyed by submission id or `#creationId`; after all c/u/d
processed, exactly one implicit `Email/set` runs and its response follows with the **same call
id**. Canonical send pattern: create submission + `onSuccessUpdateEmail: {"#k1":
{"mailboxIds/<drafts>": null, "mailboxIds/<sent>": true, "keywords/$draft": null}}`. Bcc is
stripped by the server on delivery.

Create SetErrors: `invalidEmail` (+`properties`), `tooManyRecipients` (+`maxRecipients`),
`noRecipients`, `invalidRecipients` (+`invalidRecipients: String[]`), `forbiddenMailFrom`,
`forbiddenFrom`, `forbiddenToSend` (+localised `description`), `tooLarge` (+`maxSize`),
`invalidProperties`. Update SetError: `cannotUnsend`.

Query filter: `identityIds`, `emailIds`, `threadIds`, `undoStatus`, `before`/`after` (**on
`sendAt`**). Server MAY destroy submission objects at any time post-send.

### 2.14 VacationResponse (OOO singleton)

Exactly one per account, `id = "singleton"` (create/destroy ⇒ `singleton` SetError). Props:
`isEnabled: Boolean`, `fromDate: UTCDate|null` (active on/after; null = immediately),
`toDate: UTCDate|null` (active before; null = indefinite), `subject: String|null` (null = server
default), `textBody: String|null`, `htmlBody: String|null`. MUST follow RFC 3834 auto-reply rules.
Methods: get / set only. Requires the `vacationresponse` capability in `using`.

### 2.15 Reply-building notes (RFC-grounded)

- Fetch parent's `messageId`, `references`, `replyTo`, `from` (all cheap props). Reply's
  `inReplyTo` = parent `messageId`; reply's `references` = parent `references` (or parent
  `inReplyTo` if no references) + parent `messageId`. Set these as `String[]` props on Email
  create — server renders the headers.
- Recipient precedence: reply to parent's `replyTo` if non-null, else `from` (RFC 5322 Reply-To
  semantics). Compose sender from the chosen **Identity** (`email` MUST be used; `name`/`replyTo`/
  `bcc` SHOULD be applied).
- Keep the subject's base form identical so subject-threading heuristics keep the thread together;
  `Re: ` prefix is convention; subject **sorting** uses the RFC 5256 base subject anyway.
- After successful submission of a reply, set `$answered` on the parent; `$forwarded` likewise for
  forwards — both ordinary keyword patches (`"keywords/$answered": true`).
- Attach the original message wholesale by referencing its `blobId` as an EmailBodyPart blobId
  (type `message/rfc822`) — no download/upload round-trip.

---

**Schema-design implications worth encoding**: (1) /set responses are inherently partial-success —
model `created/updated/destroyed` and `notCreated/notUpdated/notDestroyed` maps together, with
SetError as a discriminated union on `type` carrying typed extras. (2) `before`/`after` filter on
`receivedAt`, not `sentAt` — say so in tool descriptions. (3) `position` may be negative in
requests but is always UnsignedInt in responses. (4) `mailboxIds`/`keywords` accept both whole-map
replace and `field/key` patch keys — worth exposing both. (5) `total` only exists if
`calculateTotal: true`. (6) `ids: null` on /get is only valid for small types (Mailbox, Identity,
VacationResponse) — Email/get requires ids.
