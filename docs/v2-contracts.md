# Letterdog v2 — Module Contracts & Op Inventory

Normative companion to [v2-design.md](v2-design.md). The skeleton under `src/core/`, `src/mcp/`,
`src/cli/` and `v2.ts` compiles today (`deno task check:v2`); builders replace
`throw new
Error("not implemented: …")` bodies and fill the per-module `ops` arrays. **Exports
listed here are contracts** — do not rename or re-sign them without coordinator approval; adding
exports inside your own files is fine.

## Hard rules (apply to every builder)

- Touch ONLY the files assigned to you below. v1 (`main.ts`, `src/*.ts`, `src/tools/`,
  `src/server/`) is frozen; importing from it is allowed (`src/caldav.ts` is deliberately reused),
  editing is not. `deno.json`, `v2.ts`, `src/core/ops/registry.ts`, `src/core/ops/index.ts`,
  `src/core/config.ts` are architect-owned.
- snake_case tool/CLI arg names. Spec camelCase ONLY inside JMAP/JSCalendar payload objects.
- No invented semantics: no `updateScope`/`destroyScope` anywhere; occurrence edits use synthetic
  instance ids from expanded queries; `expandRecurrences` requires BOTH time bounds; this-and-future
  = documented split-series pattern.
- Stalwart v0.16 hybrid: participants may carry `sendTo` (map) OR `calendarAddress` (string); events
  `replyTo` (map) OR `organizerCalendarAddress` (string). Schemas are tolerant unions; normalization
  happens ONLY in the provider adapter.
- Batch-first: id-taking reads and uniform mutations accept `ids: string[]` (singular = array of
  one); per-item failures surface in `failed`, never as thrown errors.
- Every read goes through a projection; `brief` default; compact JSON (no pretty-printing).
- Gate: `cd <repo> && deno check <your files>` clean, then `deno fmt <your files>` (lineWidth 100).
  `deno task check:v2` must stay green.
- Live probes against `https://mail.astrius.ink/jmap/` are allowed READ-ONLY, bearer from
  `launchctl getenv STALWART_BEARER`. Never mutate; never log the bearer.
- `todoSchema()` (schemas/common.ts) placeholders: replace the ones in YOUR files; do not delete the
  helper until `grep -r todoSchema src/core` shows no callers.

## Builder ownership

| Builder              | Files                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| B1-jmap              | `src/core/jmap/client.ts`, `jmap/session.ts`, `jmap/envelopes.ts`, `jmap/types.ts`                                       |
| B2-schemas-mail      | `src/core/schemas/common.ts`, `schemas/mail.ts`                                                                          |
| B3-schemas-calendar  | `src/core/schemas/jscalendar.ts`, `schemas/jscontact.ts`                                                                 |
| B4-projections-query | `src/core/projections.ts`, `src/core/query.ts`                                                                           |
| B5-safety-compose    | `src/core/safety.ts`, `src/core/compose.ts`                                                                              |
| B6-provider          | `src/core/provider/types.ts`, `provider/stalwart.ts`                                                                     |
| B7-ops-mail-read     | `src/core/ops/mail_read.ts`                                                                                              |
| B8-ops-mail-write    | `src/core/ops/mail_compose.ts`, `ops/mail_organize.ts`                                                                   |
| B9-ops-calendar      | `src/core/ops/calendar.ts`, `ops/notifications.ts`                                                                       |
| B10-ops-misc         | `src/core/ops/session.ts`, `ops/people.ts`, `ops/blobs.ts`, `ops/caldav.ts`, `ops/admin.ts`, `ops/sync.ts`, `ops/raw.ts` |
| B11-frontends        | `src/mcp/server.ts`, `src/cli/main.ts`                                                                                   |

## Op inventory (normative)

Dotted `name` = CLI path (`mail.search` → `letterdog mail search`); `mcpName` is the MCP tool name
(verb-first — decided). `[mcp]` implies `[mcp, cli]`. confirmClass is the op's MAXIMUM class;
`safety.effectiveGate()` computes the per-call gate. The 22 `[mcp]` rows are the entire curated MCP
surface — do not add mcp-surface ops without coordinator approval.

| Module        | Op                      | mcpName                    | Surfaces | Confirm     | Projection   |
| ------------- | ----------------------- | -------------------------- | -------- | ----------- | ------------ |
| session       | `session.whoami`        | `whoami`                   | mcp      | none        | session      |
| session       | `identity.list`         | `list_identities`          | cli      | none        | identity     |
| mail_read     | `mail.search`           | `search_emails`            | mcp      | none        | email        |
| mail_read     | `mail.read`             | `read_emails`              | mcp      | none        | email        |
| mail_read     | `mail.thread`           | `read_thread`              | mcp      | none        | email        |
| mail_read     | `attachment.read`       | `read_attachment`          | mcp      | none        | blob         |
| mail_read     | `attachment.save`       | `save_attachment`          | cli      | none        | blob         |
| mail_read     | `mail.export`           | `export_emails`            | cli      | none        | raw          |
| mail_read     | `mail.import`           | `import_emails`            | cli      | none        | email        |
| mail_compose  | `mail.reply`            | `reply_email`              | mcp      | outward     | email        |
| mail_compose  | `mail.send`             | `send_email`               | mcp      | outward     | email        |
| mail_compose  | `mail.cancel_send`      | `cancel_send`              | mcp      | none        | raw          |
| mail_compose  | `mail.forward`          | `forward_emails`           | mcp      | outward     | email        |
| mail_compose  | `draft.list`            | `list_drafts`              | cli      | none        | email        |
| mail_compose  | `draft.create`          | `create_draft`             | cli      | none        | email        |
| mail_compose  | `draft.update`          | `update_draft`             | cli      | none        | email        |
| mail_compose  | `draft.delete`          | `delete_draft`             | cli      | none        | email        |
| mail_compose  | `vacation.get`          | `get_vacation`             | cli      | none        | raw          |
| mail_compose  | `vacation.set`          | `set_vacation`             | cli      | outward     | raw          |
| mail_organize | `mail.organize`         | `organize_emails`          | mcp      | none        | email        |
| mail_organize | `mail.delete`           | `delete_emails`            | mcp      | destructive | email        |
| mail_organize | `mailbox.list`          | `list_mailboxes`           | cli      | none        | mailbox      |
| mail_organize | `mailbox.create`        | `create_mailbox`           | cli      | none        | mailbox      |
| mail_organize | `mailbox.rename`        | `rename_mailbox`           | cli      | none        | mailbox      |
| mail_organize | `mailbox.delete`        | `delete_mailbox`           | cli      | destructive | mailbox      |
| calendar      | `calendar.list`         | `list_calendars`           | mcp      | none        | calendar     |
| calendar      | `event.search`          | `search_events`            | mcp      | none        | event        |
| calendar      | `event.read`            | `read_events`              | mcp      | none        | event        |
| calendar      | `event.create`          | `create_events`            | mcp      | outward     | event        |
| calendar      | `event.update`          | `update_event`             | mcp      | outward     | event        |
| calendar      | `event.delete`          | `delete_events`            | mcp      | destructive | event        |
| calendar      | `event.rsvp`            | `respond_to_event`         | mcp      | outward     | event        |
| calendar      | `calendar.availability` | `get_availability`         | mcp      | none        | busy         |
| calendar      | `calendar.create`       | `create_calendar`          | cli      | none        | calendar     |
| calendar      | `calendar.update`       | `update_calendar`          | cli      | none        | calendar     |
| calendar      | `calendar.delete`       | `delete_calendar`          | cli      | destructive | calendar     |
| calendar      | `calendar.share`        | `share_calendar`           | cli      | blast       | calendar     |
| calendar      | `calendar.identity_set` | `set_participant_identity` | cli      | none        | identity     |
| people        | `people.search`         | `search_people`            | mcp      | none        | person       |
| people        | `contact.read`          | `read_contacts`            | mcp      | none        | contact      |
| people        | `contact.search`        | `search_contacts`          | cli      | none        | contact      |
| blobs         | `blob.upload`           | `upload_blob`              | cli      | none        | blob         |
| blobs         | `blob.download`         | `download_blob`            | cli      | none        | blob         |
| blobs         | `blob.lookup`           | `lookup_blob`              | cli      | none        | blob         |
| notifications | `notify.list`           | `list_notifications`       | cli      | none        | notification |
| notifications | `notify.dismiss`        | `dismiss_notifications`    | cli      | none        | notification |
| notifications | `alert.ack`             | `ack_alert`                | cli      | none        | raw          |
| notifications | `alert.snooze`          | `snooze_alert`             | cli      | none        | raw          |
| caldav        | `dav.discover`          | `dav_discover`             | cli      | none        | raw          |
| caldav        | `dav.list`              | `dav_list`                 | cli      | none        | raw          |
| caldav        | `dav.get`               | `dav_get`                  | cli      | none        | raw          |
| caldav        | `dav.put`               | `dav_put`                  | cli      | blast       | raw          |
| caldav        | `dav.delete`            | `dav_delete`               | cli      | destructive | raw          |
| admin†        | `admin.settings_get`    | `get_admin_settings`       | cli      | none        | raw          |
| admin†        | `admin.settings_update` | `update_admin_settings`    | cli      | blast       | raw          |
| admin†        | `sieve.list`            | `list_sieve_scripts`       | cli      | none        | raw          |
| admin†        | `sieve.get`             | `get_sieve_script`         | cli      | none        | raw          |
| admin†        | `sieve.put`             | `put_sieve_script`         | cli      | blast       | raw          |
| admin†        | `sieve.activate`        | `activate_sieve_script`    | cli      | blast       | raw          |
| sync‡         | `sync.changes`          | `sync_changes`             | cli      | none        | raw          |
| sync‡         | `sync.query_changes`    | `sync_query_changes`       | cli      | none        | raw          |
| raw           | `raw.jmap`              | `jmap_call`                | mcp      | blast       | raw          |

† registered only when `ENABLE_ADMIN_TOOLS=true` (frontends filter by name prefix `admin.` /
`sieve.`). ‡ only when `ENABLE_SYNC_TOOLS=true` (prefix `sync.`).

Per-op shape highlights (traps, defaults, required description content) live in the design doc tool
tables and in each op module's header comment — treat those as part of this contract. Decisions
already made: `read_attachment` default `mode: "url"`; `organize_emails` is ONE tool; verb-first
mcpNames; CONFIRM_POLICY default `balanced` (deployment runs `minimal`).

## Cross-cutting conventions

- **Read envelope** (every list/read op): `{items, total?, not_found?, failed?, state?}` —
  `Envelope<T>` from `core/jmap/envelopes.ts`. Mutations return an envelope carrying the affected
  items (brief-projected) + `failed`. Never expose raw `{query, get}` pairs.
- **Two-phase flow**: when `effectiveGate()` says `two_phase` and no valid `confirm_token` arg is
  present, the handler returns a `ConfirmChallenge` (`core/safety.ts`) with a brief-projected
  preview. Repeat the identical call with `confirm_token` to execute. CLI: `--yes` for outward,
  `--confirm <token>` for destructive/blast.
- **Common args** (reads): `account_id?`, `projection` (brief default), `fields?`, `limit` (default
  25), `calculate_total?` (opt-in). Body args: `include_body?`, `body_as:
  text|markdown|html`
  (default text), `max_body_bytes` → `maxBodyValueBytes`.
- **Errors**: throw `Error` (or `JmapMethodError`) for hard failures; frontends map to
  `{isError, {error, details}}` / exit code 1. Per-item problems go in `failed`.

## Module contracts

### core/config.ts — ARCHITECT (done)

`type ConfirmPolicy = "strict"|"balanced"|"minimal"`;
`interface V2Config {stalwartBaseUrl,
confirmPolicy, confirmationSecret, enableAdminTools, enableSyncTools, sessionCacheTtlMs,
mailboxCacheTtlMs, fallbackBearer?, fallbackAuthorization?, allowEnvBearerFallback,
defaultAccountId?, transport, port}`;
`loadV2Config(): Promise<V2Config>`. Invariant: V2Config stays a structural superset of v1
`EnvConfig` (so `new CalDavClient(config,
auth)` works unchanged).

### core/ops/registry.ts — ARCHITECT (done)

`Surface`, `ConfirmClass`, `ProjectionKey`, `OpAnnotations`,
`Actor {authorization, bearer?,
source: "http"|"env"|"flag", fingerprint, requestId?}`,
`OpContext {config, actor, jmap, caldav,
provider, policy}`, `OpArgs<Shape>`, `OpDefinition<Shape>`,
`defineOp()`, `registerOps()`, `registeredOps()`, `opsForSurface()`, `opByName()`, `opByMcpName()`.
Registration validates dotted-name shape and global name/mcpName uniqueness (throws).

### core/ops/index.ts — ARCHITECT (done)

`allOps(): OpDefinition[]` — assembles the registry once from the 12 op modules. Op builders never
edit this file; export a populated `ops: OpDefinition[]` array from your module and it is picked up.

### core/jmap/session.ts — B1-jmap

Done (keep): `CAPABILITIES` map (core, mail, submission, vacationResponse, calendars,
calendarsParse, contacts, contactsParse, principals, principalsAvailability, principalsOwner, blob,
sieve, fileNode, stalwart), `USING` ready-made capability sets, `JmapSession`, `JmapAccount`,
`CoreLimits` types. Implement: `coreLimits(session)` (defaults per RFC 8620 suggested minimums when
absent); `SessionCache` (get/put/invalidate; TTL ctor arg; keyed by actor fingerprint, never by raw
credential).

### core/jmap/types.ts — B1-jmap

Pure types, already written: `Id`, `UTCDate`, `EmailAddress`, `EmailAddressGroup`, `EmailHeader`,
`EmailBodyPart`, `EmailBodyValue`, `Email`, `MailboxRights`, `MailboxRole`, `Mailbox`, `Thread`,
`Identity`, `SubmissionAddress`, `SubmissionEnvelope`, `UndoStatus`, `DeliveryStatus`,
`EmailSubmission`, `VacationResponse`, `Principal`, `ParticipantIdentity`. Extend freely; never
rename/narrow existing fields.

### core/jmap/envelopes.ts — B1-jmap

Types done: `SetError` (typed union + passthrough), `MethodError`, `JmapMethodError`, `Envelope<T>`,
`SetOutcome<T>`, `MethodResponse`. Implement: `envelopeFromGet<T>(response)`,
`envelopeFromQuery(response)`, `setOutcome<T>(response)` (merges notCreated/notUpdated/notDestroyed
→ `failed`; NEVER throws on per-item errors), `expectResponse(responses, method, callId)` (throws
`JmapMethodError` on `["error", …]`).

### core/jmap/client.ts — B1-jmap

`JmapAuth {authorization, fingerprint}` (registry `Actor` satisfies it); `MethodCall`;
`JmapRequestResult`; `AccountRef {accountId, session, apiUrl}`; `ref(resultOf, name, path)` (done —
RFC 8620 §3.7 ResultReference builder). Implement on `class JmapClient(config)`: `session(auth)`
(SessionCache, TTL `config.sessionCacheTtlMs`), `invalidateSession(auth)`,
`resolveAccount(auth, capability?,
accountId?)` (explicit > primaryAccounts[cap] >
config.defaultAccountId > first-with-cap; throws on missing capability — reuse v1 src/jmap.ts
logic), `request(auth, using, calls)` (forwards `authorization` verbatim; retry once after session
invalidation on 401), `call(auth, using, method, args)`, `getChunked(...)` / `setChunked(...)`
(invisible chunking to maxObjectsInGet/InSet, merged results),
`uploadBlob(auth, accountId, bytes, contentType)`,
`downloadUrlFor(session, accountId, blobId, name, type)` (URI Template level 1 expansion),
`downloadBlob(...)`. NEVER log `authorization`.

### core/schemas/common.ts — B2-schemas-mail

Done (keep; regexes verified against rfc-notes): `todoSchema<T>(what)`, `IdSchema`, `JmapIdSchema`,
`IdsSchema` (1..500), `UTC_DATETIME_RE`/`UtcDateTimeSchema`,
`LOCAL_DATETIME_RE`/`LocalDateTimeSchema`, `DURATION_RE`/`DurationSchema`,
`SIGNED_DURATION_RE`/`SignedDurationSchema`, `TimeZoneIdSchema`, `setOfTrue()`, `PatchObjectSchema`,
`ProjectionSchema` (default "brief"), `FieldsSchema`, `LimitSchema` (default 25), `AccountIdSchema`,
`ConfirmTokenSchema`. Add shared helpers here as needed.

### core/schemas/mail.ts — B2-schemas-mail

Types done: `AddressInput`, `EmailFilterCondition` (all 18 RFC 8621 conditions), `EmailFilter`
(recursive operator tree), `EmailComparator`, `AttachmentInput` (`{blob_id}|{content_base64}|{url}`
union), `ComposeEmailInput`. Replace todoSchema: `EmailFilterConditionSchema`, `EmailFilterSchema`
(z.lazy recursion; a FilterCondition MUST NOT carry an `operator` key), `EmailComparatorSchema`,
`AddressInputSchema`, `AttachmentInputSchema` (exactly-one-source union), `ComposeEmailInputSchema`,
`KeywordSchema` (charset per RFC 8621 §2.8). Done: `MarkSchema`, `MoveToSchema`.

### core/schemas/jscalendar.ts — B3-schemas-calendar

Types done (tolerant of the Stalwart hybrid): `NDay`, `RecurrenceRule`, `Participant`, `Location`,
`VirtualLocation`, `Link`, `AlertTrigger`, `Alert`, `TypedEvent`, `EventFilterCondition`. Replace
todoSchema: `NDaySchema`, `RecurrenceRuleSchema`, `ParticipantSchema`, `AlertSchema`,
`EventCreateSchema`, `EventPatchSchema`, `EventFilterConditionSchema`. superRefine invariants
(MUST): `count`⟂`until`; `recurrenceId`⟂`recurrenceRules/recurrenceOverrides` +
`recurrenceIdTimeZone` iff `recurrenceId`; `utcStart/utcEnd`⟂`start/duration`; roles/keywords etc.
as `setOfTrue()`; unknown participant-role keys accepted; passthrough (catchall) for spec-faithful
round-tripping; server-set props rejected in `EventCreateSchema`.

### core/schemas/jscontact.ts — B3-schemas-calendar

Types done: `CardName`, `ContactCard` (minimal typed slice + passthrough), `ContactFilterCondition`.
Replace todoSchema: `ContactCardSchema`, `ContactFilterConditionSchema`. Keep tolerant until the RFC
9553/9610 digest lands in rfc-notes/.

### core/projections.ts — B4-projections-query

Types done (these ARE the design's Output-economy table): `ProjectionMode`, `ProjectionContext`,
`BriefEmail`, `BriefEvent`, `BriefContact`, `BriefCalendar`, `BriefBusyPeriod`, `BriefPerson`;
`compactJson()` done. Implement: `projectEmail`, `projectEvent` (end COMPUTED via `computeEnd` — use
`Temporal` with the event zone; DST-correct), `projectMailbox`, `projectCalendar`, `projectContact`,
`projectPerson`, `projectBusyPeriod`, `project(kind, raw, mode, ctx)` dispatcher, `computeEnd`.
Rules: brief default; `fields` adds surgical extras; `raw` = untouched spec shape; preview ≤120
chars; addresses flattened `"Name <addr>"`; mailbox ids resolved via `ctx.mailboxes`; keywords →
`flags` string.

### core/safety.ts — B5-safety-compose

Types done: `Gate`, `ConfirmIntent`, `GateSignals`, `ConfirmChallenge`, `ConfirmVerdict`. Implement:
`effectiveGate(signals)` (pure; full policy matrix in the file header — unit-test it),
`mintConfirmToken(secret, intent, ttlMs=300000)` / `verifyConfirmToken(secret, token,
intent)`
(self-contained `ld2.<claims>.<hmac>` token, embedded expiry, actionable `diff` on mismatch — NOT a
bare "fingerprint mismatch"), `canonicalJson`, `hashJson`, `actorFingerprint(secret, credential)`
(v1 src/auth.ts construction, 24 base64url chars), `isReadOnlyJmapMethod(method)` (v1
`READ_ONLY_METHOD_RE` semantics: /get|/query|/changes|
/queryChanges|/parse|/lookup|Core/echo|Principal/getAvailability).

### core/compose.ts — B5-safety-compose

Types done: `EmailCreatePayload`, `ReplyOptions`, `ForwardOptions`, `SendPlan`. Implement:
`buildReply(parent, identity, ownAddresses, opts)` (inReplyTo = parent messageId; references =
parent references ?? inReplyTo, + messageId; recipients replyTo ?? from, reply-all minus self; base
subject preserved), `buildForward` (blobId reattach `message/rfc822` default), `buildCompose`,
`planAttachments` (blob_id passthrough; base64/url → RFC 9404 `Blob/upload` chained via
`#creationId` in the SAME request), `planSend` (EmailSubmission create + `onSuccessUpdateEmail`
drafts→sent, `keywords/$draft: null`; send_at → FUTURERELEASE), `htmlToText` / `htmlToMarkdown` (npm
`html-to-text` is mapped in deno.json; add `// @ts-types="npm:@types/html-to-text@^9"` above the
import if check complains; byte caps must be UTF-8-safe).

### core/query.ts — B4-projections-query

Types done: `GmailTranslation {filter, unsupported, mailboxRefs}`. Implement:
`translateGmailQuery(query)` (token grammar in the file header — from:/to:/cc:/bcc:/
subject:/in:/is:/has:/before:/after:/larger:/smaller:/label:, quoted phrases, `-` negation; unknown
operators land in `unsupported`, never guessed), `mergeFilters(gmail, typed)` (AND).
`before`/`after` translate to receivedAt bounds.

### core/provider/types.ts — B6-provider

Types done: `NormalizedOrganizer`, `NormalizedParticipantAddress`, `ShapeNormalizers` (event/
organizer/participantAddress/ownParticipant), `ProviderQuirks`,
`Provider {id, sessionUrl,
normalize, extensions, quirks}`. Extend, don't rename.

### core/provider/stalwart.ts — B6-provider

Implement: `stalwartProvider()` (hybrid normalizers —
`calendarAddress ?? sendTo.imip ?? first
sendTo value`; organizer from
`replyTo.imip ?? organizerCalendarAddress`; ownParticipant match via RFC 3986 §6.2.2-normalized
address equality; quirks all true; `extensions` = x:* admin + sieve op definitions consumed by
ops/admin.ts) and `genericProvider()` (spec-conservative fallback; core must work against
Fastmail/Cyrus through it).

### core/ops/* — B7/B8/B9/B10

Fill `ops: OpDefinition[]` per the inventory table above; each file's header comment lists its ops
with surfaces/confirm/projection. Handler recipe: validate cross-field invariants → resolve account
(`ctx.jmap.resolveAccount` with the right `USING` capability) → build method calls (back-refs via
`ref()`) → normalize via envelopes → provider-normalize shapes (calendar) → project items
(`project(op.projection, …)` honoring `projection`/`fields` args) → return Envelope; for mutations
consult `effectiveGate` first and return `ConfirmChallenge` when gated. Descriptions must carry the
documented traps (receivedAt semantics, after-vs-end/before-vs-start, send_invitations
both-directions warning, synthetic-instance-id mechanics, `#`-backref syntax for raw.jmap).

### src/mcp/server.ts — B11-frontends

Done: `SERVER_NAME = "letterdog"`, `SERVER_VERSION`, `startMcp(config)` dispatcher. Implement:
`createMcpServer(config)` (registerTool for each `opsForSurface("mcp")` op minus gated prefixes;
inputSchema = op.input + `confirm_token` where confirmClass ≠ none; annotations from op.annotations;
handler builds `Actor` from the request Authorization header — v1 src/auth.ts forwarding pattern,
env fallback only if `allowEnvBearerFallback` — assembles `OpContext` with shared `JmapClient`,
`new CalDavClient(config, actor.auth)`, `stalwartProvider()`; prints via `compactJson`),
`startHttp(config)` (stateless WebStandardStreamableHTTPServerTransport, `/healthz` `/readyz`, 401
without Authorization — v1 src/server/transports.ts pattern), `startStdio(config)`.

### src/cli/main.ts — B11-frontends

Done: `import.meta.main` bootstrap. Implement: `runCli(argv)` (dotted-name → command tree via
`@std/cli` parseArgs; flags derived from op.input — arrays as repeated/CSV; trailing positionals →
`ids`; `-` = ids from stdin; `--json[=full|raw]`, NDJSON for lists, human tables on TTY only;
`--url`/`--account`/STALWART_BEARER → `Actor{source:"env"|"flag"}`; `--yes`/`--confirm`/ `--dry-run`
per safety contract; admin/sieve/sync gating), `helpText(commandPath?)` (registry-driven; feeds
tool-mapping regeneration).

### v2.ts / deno.json — ARCHITECT (done)

Tasks: `dev:v2:http`, `dev:v2:stdio`, `cli` (`deno task cli -- mail search …`), `check:v2`. New
imports: `html-to-text` (npm 9.0.5), `@std/cli` (jsr ^1.0.0).
