---
name: letterdog-mail
description: "Letterdog — the user's personal self-hosted mail/calendar/contacts (JMAP; addresses on danielsol.dev, astrius.ink, ashbornlabs.com, and other own domains). Use when the user wants to inspect, search, or summarize mail, triage inbox/junk/marketing, read attachments, draft or send replies, forward, archive, delete, or apply labels/keywords on their own mail server — not Gmail or other hosted accounts."
---

# Letterdog Mail

## Tool Surface

MCP tools for mail: `whoami`, `search_emails`, `read_emails`, `read_thread`, `read_attachment`,
`reply_email`, `send_email`, `cancel_send`, `forward_emails`, `organize_emails`, `delete_emails`,
`search_people`, `read_contacts`, and the escape hatch `jmap_call`. If these are missing, report
that the Letterdog MCP server is not connected before trying another mailbox surface.

Conventions that apply everywhere:

- Batch-first. Every id-taking read and uniform mutation takes `ids: string[]` — one call with 20
  ids, never 20 calls. Singular use = array of one. Accumulate ids from a search, then act once.
- Every list/read returns the envelope `{items, failed?, not_found?, state?, total?}`. Per-item
  problems land in `failed: {id: error}` — the call does not throw; check `failed` and `not_found`
  instead of assuming all-or-nothing.
- Every read takes `projection: "brief" | "full" | "raw"` (default brief) and `fields: [...]` for
  surgical extras. Brief is enough for triage; `raw` is the untouched spec shape.
- Bodies are never included by default. Pass `include_body: true` with
  `body_as: "text" | "markdown" | "html"` (default text; HTML is converted server-side, 5-20x
  smaller) and `max_body_bytes` to bound it.
- `whoami` first when the from-address, identities, capabilities, or account id matter. Pass
  `account_id` only when the user names one; otherwise the session resolves it.

## Search And Reading

`search_emails` takes a Gmail-syntax `query` (from:/to:/cc:/bcc:/subject:/body:/in:/label:/
is:unread|flagged|draft/has:attachment/before:/after:/larger:/smaller:/header:; quoted "phrases"
match as phrases, bare words are all-required tokens, leading `-` negates) and/or a typed RFC 8621
`filter` — both are AND-merged. TRAP: `before:`/`after:` filter on receivedAt (server arrival time),
not the Date: header; after: inclusive, before: exclusive.

- `ids_only: true` when the next step is a mutation or batch read — accumulate then act.
- `collapse_threads: true` for inbox-style views (one email per thread).
- `include_snippets: true` for `<mark>`-highlighted match context instead of reading bodies.
- `limit` defaults 25 (max 200); `calculate_total` is opt-in and can be slow.
- Unsupported query operators are surfaced, not guessed — refine with supported ones.

`read_emails` for metadata/bodies by ids. `read_thread` (by `email_id` or `thread_ids`) resolves a
whole conversation in one round-trip — use it before replying. `read_attachment` by `email_id` +
`blob_id` or `part_id` (membership verified): default `mode: "url"` returns an authenticated
download URL + curl one-liner (bytes never enter context); `mode: "content"` inlines base64 (guard
with `max_bytes`); `parse: true` parses an attached `.eml`.

## People

`search_people` resolves a name/email into addresses across the address book AND the principals
directory — the lookup step before mailing someone ("mail Ivan" resolves here). `read_contacts`
fetches full JSContact cards by id when phones/orgs/notes matter.

## Compose And Send

- `reply_email`: RFC-correct threading is handled (In-Reply-To, References, base subject, parent
  marked `$answered`). `send: false` (default) drafts; `send: true` submits. `reply_all` adds the
  parent's To+Cc minus the user's own addresses — choose deliberately, not by default.
- `send_email`: new mail or submit an existing draft (`draft_id`). Attachments accept
  `{blob_id} | {content_base64, name, type} | {url} | {text, name}`. `send_at` schedules a delayed
  send; the response carries `submission_id` + `undo_status`.
- `cancel_send`: flips a still-pending submission to canceled within the undo window; after the
  message leaves the server it fails with `cannotUnsend` — no recall.
- `forward_emails`: batch email_ids to new recipients; originals reattached zero-copy as
  message/rfc822 (full MIME fidelity) unless `attach_original: false` (inline quote).

Read the latest message and enough thread context before drafting. If the user asks to reply but not
explicitly to send, draft (`send: false`). Local files cannot be attached through MCP — route to the
CLI (below).

## Organize And Delete

`organize_emails` is the one mutation tool for labels/keywords/marks/moves. Explicit ids only —
never query-powered. Semantics:

- `add_labels`/`remove_labels`: mailbox labels by name, id, or role; additive/subtractive.
- `add_keywords`/`remove_keywords`: JMAP keywords ($flagged, custom tags).
- `mark`: sugar for read|unread|flagged|unflagged|junk|not_junk.
- `move_to`: archive|trash|inbox|<mailbox_id>. REPLACES current mailboxes unless
  `keep_in_current: true`.

`delete_emails` defaults to a reversible Trash move. `permanent: true` destroys irrecoverably and is
always two-phase. Sample actual messages before bulk labeling/deleting a broad match set.

## Confirmation

Most actions run directly: labels, marks, moves INCLUDING trash, archive, drafts. Do not ask the
user for ritual confirmation on these — the client's own tool prompt is the gate.

Only these are two-phase: permanent email destroy, deleting a mailbox that still has mail, share/ACL
changes, admin/sieve, raw JMAP mutations (`jmap_call` with `allow_mutation`), and query-powered bulk
over 100 items. Two-phase means the tool returns `confirmation_required: true` + `confirm_token` + a
brief preview instead of executing; show the preview, then repeat the IDENTICAL call with
`confirm_token` added. Outward sends (send/reply/forward) may return the same challenge under
stricter server policies — handle it the same way. Never invent or persist tokens; a mismatch
returns a diff of what changed.

## MCP vs CLI Routing

Use the MCP tools for reading, triage, replies, and organization. Drop to the CLI binary `letterdog`
via Bash when the task involves:

- local files — attach from a path, save attachments/raw messages to a path;
- more than ~20 mutations (pipelines beat repeated tool calls);
- raw MIME fidelity (export/import .eml);
- mailbox management, drafts CRUD, vacation response, sieve, admin;
- anything the MCP surface doesn't wrap.

CLI auth comes from `STALWART_BEARER` in the environment (launchctl-set on this machine). Shape:
`letterdog <group> <command> [flags] [ids…|-]` — trailing ids pipeable via stdin (`-`), `--json` for
NDJSON list output (`--json=full|raw` for deeper projections), `--dry-run` to preview a gated op and
get its confirm token, `--yes` for outward sends, `--confirm <token>` for destructive/blast. During
development invoke it as `deno task cli -- <group> <command> …` from the repo.
`letterdog <group> --help` / `<command> --help` lists real flags.

Recipes (real flags — address flags take JSON objects, not bare emails):

```sh
# Attach a local file: upload the bytes, then reference the blob_id.
blob_id=$(letterdog blob upload --content-base64 "$(base64 -i report.pdf)" \
  --content-type application/pdf --json | jq -r .blob_id)
letterdog mail send --to '{"email":"a@b.example"}' --subject "Report" \
  --body-text "$(cat body.md)" \
  --attachments "{\"blob_id\":\"$blob_id\",\"name\":\"report.pdf\",\"type\":\"application/pdf\"}" \
  --yes

# Save attachments to disk (one: add --blob-id; all: just the email).
letterdog attachment save --email-id <email_id> --out-path ~/Downloads/

# Bulk-label pipeline: `-` reads ids from stdin (bare or JSON-quoted lines both work).
letterdog mail search 'from:newsletter@x.example' --ids-only --limit 200 --json \
  | letterdog mail organize - --add-labels <mailbox>

# Raw fidelity: export .eml to disk / import into a mailbox.
letterdog mail export --ids <id1>,<id2> --out-dir ./eml/
letterdog mail import ... --mailbox inbox   # see letterdog mail import --help
```

## Escape Hatch

`jmap_call` runs arbitrary JMAP `[method, args, callId]` triples with `#`-back-reference chaining
(`{"#ids": {resultOf, name, path}}`, `/*` maps over arrays). Read-only by default; mutations need
`allow_mutation: true` plus two-phase confirmation. Prefer the typed tools; use this for diagnostics
and gaps.

## Response Style

Lead with the latest status, then decisions, open questions, action items. For triage buckets
(Urgent / Needs reply soon / Waiting / FYI) include sender, subject, why bucketed, and next action.
State search scope and confidence — no absolute claims a sampled search cannot support. For writes,
state target ids, the exact change, and whether a confirmation is pending. Letterdog ids are JMAP
ids — never feed Gmail URLs or webmail links into these tools.
