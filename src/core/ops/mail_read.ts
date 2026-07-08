/**
 * mail read ops — TODO(builder: B7-ops-mail-read)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - mail.search → search_emails        [mcp, cli]  none  readOnly  projection: email
 *   Gmail-syntax `query` (core/query.ts) and/or typed RFC 8621 filter (all 18 conditions);
 *   `ids_only`, `collapse_threads`, `include_snippets` (SearchSnippet/get). Description MUST
 *   state before/after filter on receivedAt, and quoted-phrase vs token matching.
 * - mail.read → read_emails            [mcp, cli]  none  readOnly  projection: email
 *   ids array; include_body + body_as text|markdown|html (html-to-text server-side),
 *   max_body_bytes → maxBodyValueBytes; include_raw.
 * - mail.thread → read_thread          [mcp, cli]  none  readOnly  projection: email
 *   by email_id or thread_id; canonical back-ref chain (rfc-notes 8620 §1.3).
 * - attachment.read → read_attachment  [mcp, cli]  none  readOnly  projection: blob
 *   email-membership verified; mode "url" (DEFAULT — authed download URL + curl one-liner) |
 *   "content"; parse:true for attached .eml via Email/parse.
 * - attachment.save → save_attachment  [cli]       none  readOnly
 *   write blob(s) to disk path/dir; bytes never enter model context.
 * - mail.export → export_emails        [cli]       none  readOnly
 *   raw .eml blobs to a directory.
 * - mail.import → import_emails        [cli]       none  (mutating but local-scope)
 *   Email/import from files; mailbox required; per-item failures surfaced.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
