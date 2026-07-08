# v2 Design: One PIM Core, Two Surfaces

Status: draft for review. Grounded in [rfc-notes/](rfc-notes/) (RFC 8620/8621/8984, RFC 9404,
RFC 9670, draft-ietf-jmap-calendars-26) and live probes against Stalwart v0.16.11.

## Architecture

One Deno codebase, one domain core, two frontends built together:

```
                    ┌──────────────────────────────┐
   claude.ai / ────▶│  MCP server (HTTP, deployed)  │──┐
   mobile / Cowork  │  ~22 curated everyday tools   │  │
                    └──────────────────────────────┘  │   ┌──────────────────┐
                                                      ├──▶│  domain core      │──▶ Stalwart
                    ┌──────────────────────────────┐  │   │  (typed client,   │    JMAP/CalDAV
   Claude Code / ──▶│  CLI (`stalwart`, local)      │──┘   │  schemas, safety, │
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
    jmap/client.ts     # request/call/batch + session cache (TTL 60s, per actor) + #backrefs
    jmap/envelopes.ts  # normalize /get,/query,/set; SetError discriminated union;
                       #   partial failures surfaced as failed: {id: {type, description, ...}}
    jmap/types.ts      # typed Email, Mailbox, Thread, Identity, Submission, Principal
    schemas/           # Zod: jscalendar.ts (RFC 8984+draft-26), jscontact.ts, mail.ts, common.ts
    safety.ts          # method classification (read/mutate/destructive) + confirm tokens
    compose.ts         # MIME assembly, reply building (RFC-correct threading), forward quoting
    query.ts           # Gmail-syntax → Email/query FilterCondition translation
    caldav.ts          # existing CalDAV client
  mcp/                 # MCP entry: tool registrations only (schema + description + core call)
  cli/                 # CLI entry: subcommand parsing only
```

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
- Compact JSON everywhere; email bodies truncated server-side via `maxBodyValueBytes`.

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
management (`create_mail_label` → CLI `stalwart mailbox create`).

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

## Surface 2: CLI — `stalwart` (working name)

Deno, same core, `deno compile` binary shipped via the plugin and the nix flake. Output: human
tables on TTY, `--json` (NDJSON for lists) otherwise — agents get stable JSON by default when
piped. Auth: `STALWART_BEARER` (already in launchctl env), `--url`, `--account`.

```
stalwart whoami
stalwart mail search 'from:klarna after:2026-06-01' [--json] [--limit N] [--ids-only]
stalwart mail read <id...> [--body] [--raw] [--save-dir DIR]
stalwart mail thread <id>
stalwart mail reply <id> [--all] [--body-file F | --body S] [--attach FILE...] [--draft | --yes]
stalwart mail send [--to ... --subject ... --body-file F] [--attach FILE...] [--at TIME] [--yes]
stalwart mail forward <id...> --to ... [--attach-original] [--yes]
stalwart mail label|mark|move <id...|-> ...       # ids via args or stdin (pipe from search)
stalwart mail delete <id...|-> [--permanent --confirm TOKEN]
stalwart mail import FILE... --mailbox inbox      # Email/import
stalwart mail export <id...> -o DIR               # raw .eml to disk
stalwart attachment save <email_id> [<blob_id>] -o PATH|DIR
stalwart mailbox list|create|rename|delete
stalwart draft list|create|update|delete
stalwart vacation get|set ...
stalwart cal list
stalwart event search --from T --to T [--calendar C] [--expand] [--query S]
stalwart event get|create|update|delete|rsvp ...  # --file event.json or typed flags
stalwart avail <address...> --from T --to T [--details]
stalwart contact search|get ...
stalwart people search S                          # contacts + principals
stalwart notify list|dismiss
stalwart alert ack|snooze <event_id> <alert_id> [--until T]
stalwart blob upload FILE | download <blob_id> -o PATH
stalwart dav discover|list|get|put|delete ...     # raw CalDAV, ETag-guarded
stalwart sieve list|get|put|activate ...
stalwart raw '<jmap request json>' [--allow-mutation --confirm TOKEN]
stalwart admin settings get|update ...
stalwart sync changes <Type> --since STATE        # the demoted sync primitives live here
```

Safety model: read commands just run. Mutating commands print a one-line effect summary; sends,
destroys, series-wide edits, shares, and admin changes additionally require `--yes` or
`--confirm <token>` (token printed by the dry run; same HMAC core as MCP). `--dry-run` everywhere
it's meaningful. The harness's own Bash permission prompt is the second gate.

## Skills (rewritten with v2)

- `stalwart-mail`, `stalwart-calendar` — mechanics of the new MCP surface **plus the routing
  rule** and CLI recipes (attach local file, save attachments, bulk label via pipeline).
- The four workflow skills slim to their deltas (triage rubric, slot-ranking, movable-event
  classification, prep-brief format) and reference the mechanics skills.
- Skill content absorbs what the v1 verb catalog over-encoded in schemas: reply etiquette,
  recurrence-scope mechanics, scheduling-message discipline.

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

- CLI name: `stalwart` collides with upstream's own binary name — `swm`? `pim`? `astr`?
- MCP `read_attachment` default mode: `url` (safe, tiny) vs `content` (convenient) — leaning url.
- Whether `organize_emails` (one tool) vs `label/mark/move` (three) reads better to models —
  decide by testing against real transcripts.
- JSContact digest scope: RFC 9553 Card is large; probably only Card-level props the PIM needs
  (names, emails, phones, addresses, organizations, notes, linked principals).
