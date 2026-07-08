# Letterdog v2 Design: One PIM Core, Two Surfaces

Status: draft for review. Grounded in [rfc-notes/](rfc-notes/) (RFC 8620/8621/8984, RFC 9404,
RFC 9670, draft-ietf-jmap-calendars-26) and live probes against Stalwart v0.16.11.

## Naming

**Letterdog** is the product: the MCP server, the CLI binary (`letterdog`), the plugin, the
skills. **Stalwart** appears only where it names the backend server software (provider adapter,
deployment internals, RFC-notes context). Every agent-facing description leads with the Letterdog
identity and what it fronts — *"Letterdog, the user's personal self-hosted mail/calendar/contacts
(JMAP)"* — because sessions routinely have Gmail/Google-Calendar connectors attached too, and the
description is what routes the model to the right provider. Infra identifiers (k8s deployment
name, image, `mcp.mail.astrius.ink` host, `STALWART_BEARER` env var) are renamed opportunistically
during the v2 rollout, not before.

## Architecture

One Deno codebase, one domain core, two frontends built together. The core targets **JMAP the
standard**, not Stalwart specifically — Stalwart is the first provider adapter (see "Beyond
Stalwart" below).

```
                    ┌──────────────────────────────┐
   claude.ai / ────▶│  MCP server (HTTP, deployed)  │──┐
   mobile / Cowork  │  ~22 curated everyday tools   │  │
                    └──────────────────────────────┘  │   ┌──────────────────┐
                                                      ├──▶│  domain core      │──▶ Stalwart
                    ┌──────────────────────────────┐  │   │  (typed client,   │    JMAP/CalDAV
   Claude Code / ──▶│  CLI (`letterdog`, local)     │──┘   │  schemas, safety, │
   Codex / human    │  full spec-faithful surface   │      │  compose, cache)  │
                    └──────────────────────────────┘      └──────────────────┘
```

**Division of labor** — the two surfaces deliberately do NOT mirror each other:

| Concern | MCP (easy) | CLI (powerful) |
|---|---|---|
| Audience | claude.ai, mobile, Cowork, quick local asks | local agents (Bash), bulk work, humans |
| Coverage | everyday mail/calendar/contacts verbs | 100%: raw JMAP, CalDAV, sieve, vacation, admin, sync, import/export, files |
| Blobs/attachments | URL/resource modes, inline for small | **files on disk** — attach from path, save to path; bytes never enter model context |
| Bulk operations | dry-run + confirm, bounded | pipelines: `--json` out, ids in via stdin/args |
| Semantics | curated, guard-railed | spec-faithful; the RFC notes are the manual |
| Auth | per-request bearer forwarding (multi-actor) | `STALWART_BEARER` env (launchctl), `--account` |

Skills teach the routing rule: *use MCP tools for reading, triage, replies, RSVPs, scheduling;
drop to the CLI via Bash when the task involves local files, more than ~20 mutations, raw
iCalendar/MIME fidelity, sieve/admin, or anything the MCP doesn't wrap.*

## Domain core (shared by both frontends)

```
src/
  core/
    ops/               # THE operation registry — single source for both frontends (see below)
    jmap/client.ts     # request/call/batch + session cache (TTL 60s, per actor) + #backrefs
    jmap/envelopes.ts  # normalize /get,/query,/set; SetError discriminated union;
                       #   partial failures surfaced as failed: {id: {type, description, ...}}
    jmap/types.ts      # typed Email, Mailbox, Thread, Identity, Submission, Principal
    schemas/           # Zod: jscalendar.ts (RFC 8984+draft-26), jscontact.ts, mail.ts, common.ts
    projections.ts     # brief/full/raw projections per object type (see "Output economy")
    safety.ts          # method classification (read/mutate/destructive) + confirm tokens
    compose.ts         # MIME assembly, reply building (RFC-correct threading), forward quoting
    query.ts           # Gmail-syntax → Email/query FilterCondition translation
    caldav.ts          # existing CalDAV client
    provider/          # provider adapters: stalwart.ts (hybrid shapes, x:* admin), generic.ts
  mcp/                 # MCP entry: compiles ops → tools (near-zero code of its own)
  cli/                 # CLI entry: compiles ops → subcommands + --help (ditto)
```

### Operation registry — define once, surface twice

Every capability is one **op definition**:

```ts
defineOp({
  name: "mail.search",              // CLI: `<bin> mail search`; MCP: `search_emails`
  description: "...",                // MCP description; CLI --help text
  input: SearchSchema,               // Zod: MCP inputSchema; CLI flags derived (arrays → repeat/CSV)
  annotations: { readOnly: true },   // MCP annotations; CLI safety gating (--yes/--confirm)
  projection: "email",               // which brief/full/raw projector applies
  surfaces: ["mcp", "cli"],          // curated MCP set = ops tagged "mcp"; CLI gets everything
  handler: (args, ctx) => ...,       // one implementation
})
```

The MCP frontend registers ops tagged `mcp`; the CLI exposes **all** ops. Division of labor is a
tag, not duplicated code — promoting an op to the MCP surface later is a one-word change. This is
also what makes the harness extractable for non-PIM connectors.

### Batch policy

**Batch-first is the default, because JMAP is.** `/get` takes id arrays and `/set` takes maps — a
batch op costs the same server round-trip as a singular one, and one tool call with 20 ids costs a
fraction of the tokens of 20 tool calls.

- Every id-taking read and every **uniform** mutation (same change applied to N objects) accepts
  `ids: string[]` — no singular/batch tool pairs anywhere. Singular use = array of one.
- Semantically singular verbs stay singular: `reply_email`, `respond_to_event`, `cancel_send`,
  `update_event` (one patch, one target).
- Bulk-with-distinct-payloads (N objects, N different patches) is CLI/`jmap_call` territory — the
  MCP schema stays simple.
- Batch results always use the per-item envelope: `{items/updated, failed: {id: SetError}}`;
  chunking to `maxObjectsInSet` happens in core, invisibly.
- Skills teach the pattern: accumulate ids from a search, then act once.

### Output economy

Raw JMAP/Stalwart output is a token sink (nested `EmailAddress` objects, mailbox ids requiring a
second lookup, `bodyStructure` trees, pretty-printed JSON). Every op response goes through a
**projection**; `brief` is the default everywhere.

| Object | `brief` projection (default) |
|---|---|
| Email | `{id, thread_id, from: "Name <addr>", to: ["..."], subject, received_at, preview (≤120 chars), flags: "unread flagged", mailboxes: ["inbox"], has_attachment}` — addresses flattened to strings, mailbox ids resolved to role/name, keywords collapsed to one field |
| Event | `{id, title, start, end (computed from duration — models don't do ISO-8601 arithmetic), time_zone, calendar: "name", location, virtual: url, participants: {count, own_status}, recurring: bool, status}` |
| Contact | `{id, name, emails: ["..."], phones, org}` |
| Calendar | `{id, name, role_hints, is_default, my_rights: "read write share"}` |
| BusyPeriod | `{start, end, status}` |

Rules:

- `projection: "brief" | "full" | "raw"` on every read op; `fields: [...]` for surgical extras.
  `raw` is the spec-shape passthrough (always available — faithfulness is one arg away).
- Bodies never by default. `include_body` + `body_as: "text" | "markdown" | "html"` — HTML is
  converted to text/markdown **server-side** (html-to-text), which routinely cuts email bodies
  5–20×. `max_body_bytes` maps to JMAP's UTF-8-safe `maxBodyValueBytes`.
- Compact JSON (no pretty-printing); lists as arrays of flat objects; `limit` defaults 25;
  `total` opt-in (`calculateTotal` is spec-optional and can be slow anyway).
- CLI mirrors this: human tables on TTY, `--json` = brief projection, `--json=full|raw` for more.

### Confirmation policy — lighter by default

v1 two-phases nearly every outward or destructive action. That double-gates: MCP clients already
show tool arguments in their own permission prompt, so most mutations pay **two tool calls, a
re-sent payload, and a reasoning round-trip for no added safety**. v2 reserves the two-phase flow
for actions that are *both* hard to reverse *and* high blast radius, controlled by a server-side
`CONFIRM_POLICY` (per deployment; the personal instance runs `minimal`).

| Action class | `strict` (v1-like) | `balanced` (default) | `minimal` (personal) |
|---|---|---|---|
| Reversible / low blast: labels, marks, moves **incl. trash**, archive, drafts, holds, event create/update without scheduling messages, alerts, dismissals, subscriptions | direct | direct | direct |
| Outward messaging: send/reply/forward, invitations, reschedule/cancel notices, RSVP replies | two-phase | direct when ≤3 recipients and not query-powered; two-phase otherwise | direct (client prompt + `cancel_send` undo window are the gates) |
| Irreversible destruction: permanent email destroy, calendar delete with events, mailbox delete with mail | two-phase | two-phase | two-phase |
| High blast radius: share ACL changes, `x:*` admin, raw JMAP mutations, query-powered bulk > 100 items | two-phase | two-phase | two-phase |

Notes:

- Trash moves drop out of confirmation entirely (they are reversible by definition — that's what
  Trash is for). Permanent destroy keeps the gate in every policy.
- Where two-phase remains, it gets cheaper: the preview uses the brief projection, the
  `confirm_token` embeds its own expiry (no `confirmExpiresAt` echo), and a token mismatch returns
  an actionable diff of what changed rather than a bare "fingerprint mismatch".
- CLI equivalents: class-2 = `--yes`; classes 3–4 = `--confirm <token>` from the dry run.
- Skills stop teaching ritual confirmation for routine actions; they describe only the two
  remaining gated classes.

Core rules carried over from the first draft (unchanged, they apply to both surfaces):

- Typed payloads with `.passthrough()`; cross-field invariants via `superRefine`
  (`count`⟂`until`, `recurrenceId`⟂`recurrenceRules/Overrides`, `utcStart/utcEnd`⟂`start/duration`).
- Sets-as-maps (`z.record(z.literal(true))`) for keywords/roles/features per RFC 8984.
- Participant/organizer address fields modeled as unions (Stalwart v0.16 serves an
  RFC 8984 / JSCalendar-bis hybrid — see rfc-notes §14).
- **No invented semantics.** `updateScope`/`destroyScope` removed everywhere; occurrence-scoped
  edits use synthetic instance ids from expanded queries; this-and-future = documented
  split-series pattern.
- Confirmation: self-contained signed `confirm_token` (HMAC over canonical intent — tool/command,
  account, operation, resource ids, payload hash — with embedded expiry + actor fingerprint).
  MCP: repeat the call with `confirm_token`. CLI: mutating commands print a preview and the token;
  re-run with `--confirm <token>` (destructive ops) or `--yes` (routine sends).

## Surface 1: MCP — the everyday PIM set (~22 tools)

Every tool: agent-facing description (when to use, the trap it avoids, follow-up tool),
`annotations` (readOnlyHint/destructiveHint/idempotentHint), normalized envelopes
(`{items, total?, not_found?, failed?, state}` — never raw `{query, get}`).

### Mail (10)

| Tool | Shape highlights |
|---|---|
| `search_emails` | Gmail-syntax `query` and/or typed RFC 8621 filter (all 18 conditions); `ids_only`, `collapse_threads`, `include_snippets` (SearchSnippet/get, `<mark>`-highlighted). Description: `before`/`after` = **receivedAt**; quoted phrases vs tokens. readOnly |
| `read_emails` | ids array; `include_body` (bounded via `maxBodyValueBytes`), `include_raw`. readOnly |
| `read_thread` | by `email_id` or `thread_id`. readOnly |
| `read_attachment` | email-membership verified; `mode: "content" \| "url"` (url = authenticated download URL + curl one-liner — the local-save path); `parse: true` for attached `.eml` via Email/parse. readOnly |
| `reply_email` | RFC-correct threading (`inReplyTo` = parent messageId; `references` = parent references + messageId), recipients from `replyTo` ?? `from` (+ all minus self for reply-all), base-subject preserved, `$answered` set via `onSuccessUpdateEmail`. `send: false` ⇒ draft. Send confirms. |
| `send_email` | compose+submit or send existing draft; attachments as `{blob_id} \| {content_base64} \| {url}` (server-side Blob/upload + `#creationId` chaining); `send_at` delayed send when supported; response carries `undo_status`. Confirms. |
| `cancel_send` | flips pending EmailSubmission `undoStatus` → canceled; surfaces `cannotUnsend`. |
| `forward_emails` | zero-copy original via `blobId` reattach (`message/rfc822`); HTML preserved in quote mode; `$forwarded` set. Confirms. |
| `organize_emails` | one tool: add/remove mailbox labels, add/remove keywords, plus sugar `mark: read\|unread\|flagged\|junk\|not_junk`, `move_to: archive\|trash\|inbox\|<mailbox_id>`. Trash/removals confirm. Explicit ids only. |
| `delete_emails` | trash default; `permanent: true` destroys. Confirms. destructive |

Dropped to CLI: draft CRUD beyond reply/send `send:false` (list via `search_emails is:draft`),
`bulk_label_matching` (CLI pipelines do it better), import/export, vacation response, mailbox
management (`create_mail_label` → CLI `letterdog mailbox create`).

### Calendar (8)

| Tool | Shape highlights |
|---|---|
| `list_calendars` | direct `Calendar/get ids:null`; typed objects incl. `myRights`, `isDefault`, `includeInAvailability`. Notes freeBusy-only shares are invisible. readOnly |
| `search_events` | typed draft-26 filter (`in_calendar` singular; `after` vs event **end**, `before` vs event **start**, LocalDateTime in `time_zone` arg); `expand: true` requires both bounds (schema-enforced) and returns synthetic per-instance ids + `utcStart/utcEnd`. readOnly |
| `read_events` | ids array (base or instance ids); `recurrence_overrides_before/after`, `reduce_participants`, `time_zone`. readOnly |
| `create_events` | TypedEvent (full RFC 8984 schema, server-set fields excluded); `send_invitations` (default false — description warns both directions); `is_draft`. Confirms only when inviting. |
| `update_event` | base **or synthetic instance id** (= "just this occurrence"); typed patch or raw PatchObject with pointer rules stated; `send_updates`. Confirms when messaging. |
| `delete_events` | base or instance ids (instance = exclude occurrence); `send_cancellations`. Confirms. destructive |
| `respond_to_event` | RSVP via own-participant match (ParticipantIdentity `calendarAddress`, hybrid-tolerant); `occurrence_id` for per-instance; `notify_organizer` default true. Confirms when notifying. |
| `get_availability` | addresses or principal ids; `utc_start/end`, `show_details`; normalized BusyPeriods with the confirmed>unavailable>tentative precedence documented. readOnly |

Dropped to CLI: calendar CRUD/sharing/default, participant-identity management, event
notifications, alert ack/snooze, CalDAV raw, admin settings, all sync primitives.

### People, session, escape hatch (4)

| Tool | Shape highlights |
|---|---|
| `search_people` | **New — completes the PIM.** One search over JSContact contacts (RFC 9553/9610 — Stalwart advertises `urn:ietf:params:jmap:contacts`) *and* RFC 9670 principals; returns names, emails, `calendarAddress`, principal type. "Invite Daria" / "mail Ivan" resolves here. readOnly |
| `read_contacts` | full JSContact cards by id. readOnly |
| `whoami` | session, accounts, capabilities + limits, mail identities, participant identities, default calendar. readOnly |
| `jmap_call` | kept: read-only unless `allow_mutation`, confirmation on mutations, documents `#`/`*` back-reference syntax. The MCP-side bridge to everything the CLI covers. |

Contacts schema work (JSContact Card) gets the same RFC-digest treatment before implementation —
one more reader pass over RFC 9553 + RFC 9610 into `rfc-notes/`.

## Surface 2: CLI — `letterdog`

Deno, same core, `deno compile` binary shipped via the plugin and the nix flake. Output: human
tables on TTY, `--json` (NDJSON for lists) otherwise — agents get stable JSON by default when
piped. Auth: `STALWART_BEARER` (already in launchctl env), `--url`, `--account`.

```
letterdog whoami
letterdog mail search 'from:klarna after:2026-06-01' [--json] [--limit N] [--ids-only]
letterdog mail read <id...> [--body] [--raw] [--save-dir DIR]
letterdog mail thread <id>
letterdog mail reply <id> [--all] [--body-file F | --body S] [--attach FILE...] [--draft | --yes]
letterdog mail send [--to ... --subject ... --body-file F] [--attach FILE...] [--at TIME] [--yes]
letterdog mail forward <id...> --to ... [--attach-original] [--yes]
letterdog mail label|mark|move <id...|-> ...       # ids via args or stdin (pipe from search)
letterdog mail delete <id...|-> [--permanent --confirm TOKEN]
letterdog mail import FILE... --mailbox inbox      # Email/import
letterdog mail export <id...> -o DIR               # raw .eml to disk
letterdog attachment save <email_id> [<blob_id>] -o PATH|DIR
letterdog mailbox list|create|rename|delete
letterdog draft list|create|update|delete
letterdog vacation get|set ...
letterdog cal list
letterdog event search --from T --to T [--calendar C] [--expand] [--query S]
letterdog event get|create|update|delete|rsvp ...  # --file event.json or typed flags
letterdog avail <address...> --from T --to T [--details]
letterdog contact search|get ...
letterdog people search S                          # contacts + principals
letterdog notify list|dismiss
letterdog alert ack|snooze <event_id> <alert_id> [--until T]
letterdog blob upload FILE | download <blob_id> -o PATH
letterdog dav discover|list|get|put|delete ...     # raw CalDAV, ETag-guarded
letterdog sieve list|get|put|activate ...
letterdog raw '<jmap request json>' [--allow-mutation --confirm TOKEN]
letterdog admin settings get|update ...
letterdog sync changes <Type> --since STATE        # the demoted sync primitives live here
```

Safety model: read commands just run. Mutating commands print a one-line effect summary; sends,
destroys, series-wide edits, shares, and admin changes additionally require `--yes` or
`--confirm <token>` (token printed by the dry run; same HMAC core as MCP). `--dry-run` everywhere
it's meaningful. The harness's own Bash permission prompt is the second gate.

## Skills (rewritten with v2)

- `letterdog-mail`, `letterdog-calendar` — mechanics of the new MCP surface **plus the routing
  rule** and CLI recipes (attach local file, save attachments, bulk label via pipeline).
- The four workflow skills slim to their deltas (triage rubric, slot-ranking, movable-event
  classification, prep-brief format) and reference the mechanics skills.
- Skill content absorbs what the v1 verb catalog over-encoded in schemas: reply etiquette,
  recurrence-scope mechanics, scheduling-message discipline.

## Beyond Stalwart

Two levels of generalization, both deliberate:

**1. The PIM core targets JMAP-the-standard.** Everything spec-defined lives in `core/`; anything
implementation-specific goes through a provider adapter:

```ts
interface Provider {
  session(auth): Session;              // endpoint discovery, auth shaping
  normalize: ShapeNormalizers;         // e.g. Stalwart's 8984/bis hybrid → canonical internal shape
  extensions: OpDefinition[];          // e.g. Stalwart x:* admin ops, sieve specifics
  quirks: Quirks;                      // e.g. "expandRecurrences requires both bounds"
}
```

The Stalwart adapter is the first and only one for now, but the core must compile without it — a
Fastmail or Cyrus JMAP account should work by pointing the session URL at it. CalDAV stays the
raw-fidelity escape hatch either way.

**2. The harness is extractable.** The op registry + dual-frontend compilation + confirm tokens +
envelopes/projections have nothing PIM-specific in them. Other connectors in the fleet (ebag,
annas, spotify) reinvent exactly this. Plan: build it **in-repo** under `core/ops/` with zero
Stalwart imports, and extract to a standalone `connector-kit` module only when a second consumer
actually adopts it — no speculative framework building, but no accidental coupling either.

## Packaging

- `.claude-plugin/` plugin: skills + `.mcp.json` (deployed URL, `Authorization: Bearer
  ${STALWART_BEARER}`) + CLI install hook; marketplace entry for one-command install.
- Codex: MCP already registered in `~/.codex/config.toml`; install script symlinks skills and
  places the CLI on PATH (nix flake gets the compiled binary as a package).
- `docs/tool-mapping.md` regenerated from the registry (both surfaces), not hand-maintained.

## Migration order

1. **Hotfix (shipped independently):** remove phantom `updateScope`/`destroyScope`; fix the two
   skills that instruct using them (task chip filed).
2. Core extraction: `core/` layout, typed envelopes, session cache, confirm tokens, schemas
   (JSCalendar first, JSContact after its RFC digest).
3. Both frontends in one sweep on top of the core; MCP tool count 60 → ~22; CLI at full coverage;
   skills + tool-mapping regenerated in the same change.
4. Plugin packaging.

## Open questions

- MCP `read_attachment` default mode: `url` (safe, tiny) vs `content` (convenient) — leaning url.
- Whether `organize_emails` (one tool) vs `label/mark/move` (three) reads better to models —
  decide by testing against real transcripts.
- JSContact digest scope: RFC 9553 Card is large; probably only Card-level props the PIM needs
  (names, emails, phones, addresses, organizations, notes, linked principals).
- Brief-projection field sets: validate against real transcripts (which fields do agents actually
  read?) before freezing; `fields` opt-in makes wrong guesses cheap to correct.
- Op-name ↔ MCP-tool-name mapping convention (`mail.search` → `search_emails` vs mechanical
  `mail_search`) — mechanical is simpler for the registry, verb-first reads better to models.
