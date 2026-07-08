/**
 * MIME assembly, RFC-correct reply threading, forward quoting, HTML→text/markdown downshift.
 * CONTRACT STUB — TODO(builder: B5-safety-compose). Signatures normative; bodies throw.
 * Grounded in docs/rfc-notes/rfc8620-8621-jmap-core-mail.md §2.9 (create constraints), §2.13
 * (submission + onSuccessUpdateEmail), §2.15 (reply building).
 *
 * html-to-text note: `import { convert } from "html-to-text";` ships no types — add
 * `// @ts-types="npm:@types/html-to-text@^9"` above the import if deno check complains.
 */
import type { Email, Id, Identity } from "./jmap/types.ts";
import type { AttachmentInput, ComposeEmailInput } from "./schemas/mail.ts";
import type { MethodCall } from "./jmap/client.ts";

/** The Email/set create payload compose functions produce (spec camelCase, wire shape). */
export type EmailCreatePayload = Record<string, unknown>;

export interface ReplyOptions {
  /** Reply-all: parent to+cc minus own addresses; else replyTo ?? from only. */
  reply_all?: boolean;
  body_text?: string;
  body_html?: string;
  attachments?: AttachmentInput[];
  identity_id?: string;
  /** Quote the parent body (plain "> " for text, blockquote for HTML). */
  quote?: boolean;
}

/**
 * Build a reply create payload. MUST: inReplyTo = parent messageId; references = parent
 * references (?? parent inReplyTo) + parent messageId; recipients from replyTo ?? from
 * (+ to/cc minus self for reply-all); base subject preserved with a single "Re: "; From from
 * the chosen Identity. Caller sets $answered on the parent via onSuccessUpdateEmail.
 */
export function buildReply(
  _parent: Email,
  _identity: Identity,
  _ownAddresses: string[],
  _opts: ReplyOptions,
): EmailCreatePayload {
  throw new Error("not implemented: core/compose buildReply");
}

export interface ForwardOptions {
  to: { name?: string; email: string }[];
  cc?: { name?: string; email: string }[];
  body_text?: string;
  body_html?: string;
  identity_id?: string;
  /** true (default): zero-copy reattach original via its blobId as message/rfc822. */
  attach_original?: boolean;
}

/** Build forward payload(s); HTML preserved in quote mode; caller sets $forwarded. */
export function buildForward(
  _originals: Email[],
  _identity: Identity,
  _opts: ForwardOptions,
): EmailCreatePayload {
  throw new Error("not implemented: core/compose buildForward");
}

/** Assemble a fresh compose (mail.send) into an Email/set create payload. */
export function buildCompose(
  _input: ComposeEmailInput,
  _identity: Identity | undefined,
): EmailCreatePayload {
  throw new Error("not implemented: core/compose buildCompose");
}

/**
 * Plan attachment ingestion: {blob_id} → reference as-is; {content_base64}/{url} → Blob/upload
 * DataSourceObjects (RFC 9404) chained via #creationId in the SAME request (no HTTP upload
 * round-trip for payloads within maxSizeRequest). Returns extra method calls to prepend plus
 * the EmailBodyPart list referencing them.
 */
export function planAttachments(
  _inputs: AttachmentInput[],
  _accountId: Id,
): Promise<{ preCalls: MethodCall[]; bodyParts: Record<string, unknown>[] }> {
  throw new Error("not implemented: core/compose planAttachments");
}

export interface SendPlan {
  /** Full method-call list: (Blob/upload…,) Email/set?, EmailSubmission/set. */
  calls: MethodCall[];
  using: string[];
}

/**
 * Build the canonical send request: create/derive the Email, create the EmailSubmission with
 * onSuccessUpdateEmail moving drafts→sent and clearing $draft; send_at → FUTURERELEASE
 * envelope params (requires submissionExtensions FUTURERELEASE + maxDelayedSend > 0).
 */
export function planSend(_args: {
  accountId: Id;
  identity: Identity;
  create?: EmailCreatePayload;
  existingEmailId?: Id;
  sendAt?: string;
  draftsMailboxId?: Id;
  sentMailboxId?: Id;
}): SendPlan {
  throw new Error("not implemented: core/compose planSend");
}

/** HTML → readable plain text (html-to-text), UTF-8-safe byte cap. Cuts bodies 5–20×. */
export function htmlToText(_html: string, _maxBytes?: number): string {
  throw new Error("not implemented: core/compose htmlToText");
}

/** HTML → markdown-ish text (links/emphasis preserved) for body_as: "markdown". */
export function htmlToMarkdown(_html: string, _maxBytes?: number): string {
  throw new Error("not implemented: core/compose htmlToMarkdown");
}
