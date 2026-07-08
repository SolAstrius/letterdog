/**
 * mail compose/send ops — TODO(builder: B8-ops-mail-write)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - mail.reply → reply_email           [mcp, cli]  outward  projection: email
 *   RFC-correct threading via core/compose.ts buildReply(); send:false ⇒ draft; $answered via
 *   onSuccessUpdateEmail.
 * - mail.send → send_email             [mcp, cli]  outward  projection: email
 *   compose+submit or send existing draft; attachments {blob_id}|{content_base64}|{url}
 *   (Blob/upload + #creationId chaining); send_at delayed send; response carries undo_status.
 * - mail.cancel_send → cancel_send     [mcp, cli]  none     projection: raw
 *   flip pending EmailSubmission undoStatus → canceled; surface cannotUnsend.
 * - mail.forward → forward_emails      [mcp, cli]  outward  projection: email
 *   zero-copy original via blobId reattach (message/rfc822); $forwarded set.
 * - draft.list → list_drafts           [cli]       none     readOnly
 * - draft.create → create_draft        [cli]       none
 * - draft.update → update_draft        [cli]       none
 * - draft.delete → delete_draft        [cli]       none   (drafts are reversible-class)
 * - vacation.get → get_vacation        [cli]       none     readOnly
 * - vacation.set → set_vacation        [cli]       outward  (auto-replies go to other humans)
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
