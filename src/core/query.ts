/**
 * Gmail-syntax → RFC 8621 Email/query FilterCondition translation.
 * CONTRACT STUB — TODO(builder: B4-projections-query). Signatures normative; bodies throw.
 *
 * Supported syntax (document VERBATIM in search_emails description):
 *   from: to: cc: bcc: subject:  → header text conditions
 *   in:<mailbox-name-or-role>    → inMailbox (resolved via mailbox map)
 *   is:unread|read|flagged|answered|draft → hasKeyword/notKeyword ($seen, $flagged, …)
 *   has:attachment               → hasAttachment:true
 *   before:YYYY-MM-DD after:YYYY-MM-DD → UTCDate bounds on receivedAt (NOT sentAt)
 *   larger:1M smaller:500K       → minSize/maxSize
 *   label:<keyword>              → hasKeyword
 *   "quoted phrase"              → phrase match; bare tokens → all-required text match
 *   -token / -field:value        → NOT-wrapped condition
 * Unknown operators land in `unsupported` (op surfaces them in the response, never guesses).
 */
import type { EmailFilter } from "./schemas/mail.ts";

export interface GmailTranslation {
  /** null when the query contributes no conditions. */
  filter: EmailFilter | null;
  /** Operators/tokens that could not be translated — surfaced to the caller. */
  unsupported: string[];
  /** Mailbox names still to resolve to ids (in:… tokens), lowercased. */
  mailboxRefs: string[];
}

export function translateGmailQuery(_query: string): GmailTranslation {
  throw new Error("not implemented: core/query translateGmailQuery");
}

/** AND-merge the Gmail-derived filter with a typed filter arg (either may be null). */
export function mergeFilters(
  _gmail: EmailFilter | null,
  _typed: EmailFilter | null,
): EmailFilter | null {
  throw new Error("not implemented: core/query mergeFilters");
}
