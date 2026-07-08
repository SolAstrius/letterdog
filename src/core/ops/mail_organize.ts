/**
 * mail organize/destroy + mailbox ops — TODO(builder: B8-ops-mail-write)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - mail.organize → organize_emails    [mcp, cli]  none  projection: email
 *   ONE tool (decided): add/remove mailbox labels, add/remove keywords, sugar
 *   mark: read|unread|flagged|junk|not_junk, move_to: archive|trash|inbox|<mailbox_id>.
 *   Explicit ids only (never query-powered). Trash moves are direct under every policy.
 * - mail.delete → delete_emails        [mcp, cli]  destructive  projection: email
 *   trash by default (effective gate "none"); permanent:true destroys (two-phase always).
 * - mailbox.list → list_mailboxes      [cli]  none  readOnly  projection: mailbox
 * - mailbox.create → create_mailbox    [cli]  none
 * - mailbox.rename → rename_mailbox    [cli]  none  (also reparent/sortOrder)
 * - mailbox.delete → delete_mailbox    [cli]  destructive
 *   onDestroyRemoveEmails:true is the destructive branch; without it surface
 *   mailboxHasEmail/mailboxHasChild SetErrors.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
