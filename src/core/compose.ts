/**
 * MIME assembly, RFC-correct reply threading, forward quoting, HTML→text/markdown downshift.
 * Builders produce Email/set create payloads (spec camelCase, wire shape) plus the method-call
 * plans EmailSubmission needs. Pure functions where possible; planAttachments is async only because
 * it may fetch a `url` source before base64-inlining it.
 *
 * Grounded in docs/rfc-notes/rfc8620-8621-jmap-core-mail.md §2.9 (create constraints),
 * §2.13 (submission + onSuccessUpdateEmail + FUTURERELEASE), §2.15 (reply/forward building),
 * §1.3 (#creationId chaining), §1.7 (blob upload/reuse).
 *
 * RFC 8621 §2.9 body constraints honored by the structure builders:
 *   - No top-level `headers` property; only `header:<Name>` convenience props (In-Reply-To,
 *     References, and caller extras) are emitted.
 *   - `bodyStructure` XOR (`textBody`/`htmlBody`/`attachments`) — we always use `bodyStructure`.
 *   - Each inline body part uses `partId` (present in `bodyValues`); `charset`/`size` omitted with
 *     partId. Attachment parts use `blobId`, never partId.
 *   - text/plain body = exactly one part; text/html body = exactly one part; when both are present
 *     they nest in multipart/alternative; attachments wrap the whole thing in multipart/mixed.
 */
import { convert } from "html-to-text";
import type { Email, EmailAddress, Id, Identity } from "./jmap/types.ts";
import type { AddressInput, AttachmentInput, ComposeEmailInput } from "./schemas/mail.ts";
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
  /** Quote the parent body (plain "> " for text, blockquote for HTML). Default true. */
  quote?: boolean;
  /** Override the From header (must align with the chosen identity's domain). */
  from?: AddressInput;
  /** Replace the auto-derived To (parent Reply-To/From) entirely. */
  to?: AddressInput[];
  /** Replace the reply_all-derived Cc entirely. */
  cc?: AddressInput[];
  /** Add Bcc recipients (parents carry none to derive). */
  bcc?: AddressInput[];
  /** Override the reply Reply-To header (else the identity's). */
  reply_to?: AddressInput[];
  /** Override the subject (else the parent's, with a single "Re: "). */
  subject?: string;
  /** Extra raw headers, emitted as header:<Name> convenience props. */
  headers?: Record<string, string>;
  /** Extra keywords to set on the drafted/sent message. */
  keywords?: string[];
}

/**
 * Build a reply create payload. MUST (RFC 8621 §2.15): inReplyTo = parent messageId; references =
 * parent references (?? parent inReplyTo) + parent messageId; recipients from replyTo ?? from
 * (+ parent to/cc minus self for reply-all); base subject preserved with a single "Re: "; From from
 * the chosen Identity. Caller sets $answered on the parent via onSuccessUpdateEmail.
 */
export function buildReply(
  parent: Email,
  identity: Identity,
  ownAddresses: string[],
  opts: ReplyOptions,
): EmailCreatePayload {
  const own = normalizeAddressSet(ownAddresses);
  const replyTargets = nonEmptyAddresses(parent.replyTo) ?? nonEmptyAddresses(parent.from) ?? [];
  // Explicit `to` replaces the auto-derived recipients entirely; otherwise reply to the sender.
  const to = opts.to ? opts.to.map(addressOut) : replyTargets;
  let cc: EmailAddress[] = [];
  if (opts.cc) {
    // Explicit cc wins over any reply_all derivation.
    cc = opts.cc.map(addressOut);
  } else if (opts.reply_all) {
    // Reply-all adds parent To+Cc minus self and minus anyone already in `to`.
    const already = new Set(to.map((a) => normalizeAddress(a.email)));
    const pool = [...(nonEmptyAddresses(parent.to) ?? []), ...(nonEmptyAddresses(parent.cc) ?? [])];
    cc = dedupeAddresses(pool).filter((a) => {
      const norm = normalizeAddress(a.email);
      return !own.has(norm) && !already.has(norm);
    });
  }
  const bcc = opts.bcc ? opts.bcc.map(addressOut) : [];

  const inReplyTo = nonEmptyStrings(parent.messageId);
  const parentRefs = nonEmptyStrings(parent.references) ?? nonEmptyStrings(parent.inReplyTo) ?? [];
  const references = [...parentRefs, ...(inReplyTo ?? [])];

  const quote = opts.quote !== false;
  const bodyText = composeBodyText(
    opts.body_text,
    quote ? quotePlain(parentPlainBody(parent)) : "",
  );
  const bodyHtml = opts.body_html !== undefined
    ? composeBodyHtml(opts.body_html, quote ? quoteHtml(parentHtmlBody(parent)) : "")
    : undefined;

  const replyTo = opts.reply_to ? opts.reply_to.map(addressOut) : identity.replyTo;
  const headers = Object.entries(opts.headers ?? {});
  return {
    from: opts.from ? [addressOut(opts.from)] : [identityAddress(identity)],
    ...(replyTo ? { replyTo } : {}),
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: opts.subject ?? replySubject(parent.subject ?? undefined),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    ...(opts.keywords?.length
      ? { keywords: Object.fromEntries(opts.keywords.map((k) => [k, true])) }
      : {}),
    ...Object.fromEntries(headers.map(([name, value]) => [`header:${name}`, value])),
    ...bodyStructureCreate(bodyText, bodyHtml, []),
  };
}

export interface ForwardOptions {
  to: AddressInput[];
  cc?: AddressInput[];
  body_text?: string;
  body_html?: string;
  identity_id?: string;
  /** true (default): zero-copy reattach original via its blobId as message/rfc822. */
  attach_original?: boolean;
  /** Override the From header (must align with the chosen identity's domain). */
  from?: AddressInput;
  /** Blind recipients. */
  bcc?: AddressInput[];
  /** Override the Reply-To header (else the identity's). */
  reply_to?: AddressInput[];
  /** Override the subject (else the original's, with a single "Fwd: "). */
  subject?: string;
  /** Extra raw headers, emitted as header:<Name> convenience props. */
  headers?: Record<string, string>;
  /** Extra keywords to set on the forwarded message. */
  keywords?: string[];
}

/**
 * Build a forward payload for ONE original. HTML is preserved in quote mode (a quoted HTML block is
 * emitted alongside the plain quote). When attach_original is true (default) the original message is
 * reattached zero-copy by referencing its blobId as a message/rfc822 body part — no download/upload.
 * Caller sets $forwarded on the original via onSuccessUpdateEmail.
 */
export function buildForward(
  original: Email,
  identity: Identity,
  opts: ForwardOptions,
): EmailCreatePayload {
  const attach = opts.attach_original !== false;
  const header = forwardHeaderBlock(original);
  const quotedText = attach ? "" : `${header}\n\n${parentPlainBody(original)}`;
  const bodyText = composeBodyText(opts.body_text, quotedText);

  let bodyHtml: string | undefined;
  if (opts.body_html !== undefined || (!attach && parentHtmlBody(original))) {
    const quotedHtml = attach ? "" : forwardHtmlBlock(original);
    bodyHtml = composeBodyHtml(opts.body_html ?? "", quotedHtml);
  }

  const attachments: AttachmentBodyPart[] = attach && typeof original.blobId === "string"
    ? [{
      blobId: original.blobId,
      type: "message/rfc822",
      name: `${safeFilename(original.subject ?? "forwarded")}.eml`,
      disposition: "attachment",
    }]
    : [];

  const replyTo = opts.reply_to ? opts.reply_to.map(addressOut) : identity.replyTo;
  const cc = opts.cc?.map(addressOut) ?? [];
  const bcc = opts.bcc?.map(addressOut) ?? [];
  const headers = Object.entries(opts.headers ?? {});
  return {
    from: opts.from ? [addressOut(opts.from)] : [identityAddress(identity)],
    ...(replyTo ? { replyTo } : {}),
    to: opts.to.map(addressOut),
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: opts.subject ?? forwardSubject(original.subject ?? undefined),
    ...(opts.keywords?.length
      ? { keywords: Object.fromEntries(opts.keywords.map((k) => [k, true])) }
      : {}),
    ...Object.fromEntries(headers.map(([name, value]) => [`header:${name}`, value])),
    ...bodyStructureCreate(bodyText, bodyHtml, attachments),
  };
}

/** Assemble a fresh compose (mail.send) into an Email/set create payload. */
export function buildCompose(
  input: ComposeEmailInput,
  identity: Identity | undefined,
): EmailCreatePayload {
  const from = input.from
    ? [{ ...(input.from.name ? { name: input.from.name } : {}), email: input.from.email }]
    : identity
    ? [identityAddress(identity)]
    : undefined;
  if (!from) throw new Error("compose requires a from address or an identity");

  const headers = Object.entries(input.headers ?? {});
  return {
    from,
    ...(input.reply_to ? { replyTo: input.reply_to.map(addressOut) } : undefined),
    ...(input.to ? { to: input.to.map(addressOut) } : {}),
    ...(input.cc ? { cc: input.cc.map(addressOut) } : {}),
    ...(input.bcc ? { bcc: input.bcc.map(addressOut) } : {}),
    subject: input.subject,
    ...(input.keywords?.length
      ? { keywords: Object.fromEntries(input.keywords.map((k) => [k, true])) }
      : {}),
    ...Object.fromEntries(headers.map(([name, value]) => [`header:${name}`, value])),
    ...bodyStructureCreate(input.body_text ?? "", input.body_html, []),
  };
}

/**
 * Plan attachment ingestion (RFC 9404 / RFC 8620 §1.7). {blob_id} → referenced as-is; {url} is
 * fetched and {content_base64}/{url}-fetched bytes are uploaded to the blob endpoint by the caller
 * — but for payloads within maxSizeRequest we CANNOT inline binary in a JSON /set create, so this
 * returns the pre-computed EmailBodyParts for blob-id sources and the *raw bytes* the caller must
 * upload for the rest, keyed so it can rewrite the parts after upload.
 *
 * NOTE: JMAP has no in-request base64 blob creation — Blob/upload is a separate HTTP endpoint, not
 * a method. So `preCalls` is always empty (kept for signature compatibility); base64/url sources
 * surface as `uploads` the caller resolves via JmapClient.uploadBlob before building the Email.
 */
export function planAttachments(
  inputs: AttachmentInput[],
  _accountId: Id,
): {
  preCalls: MethodCall[];
  bodyParts: AttachmentBodyPart[];
  uploads: PendingUpload[];
} {
  const bodyParts: AttachmentBodyPart[] = [];
  const uploads: PendingUpload[] = [];
  for (const [index, input] of inputs.entries()) {
    if ("blob_id" in input) {
      bodyParts.push(attachmentPart(input.blob_id, input));
      continue;
    }
    if ("url" in input) {
      // SSRF discipline: raw url sources must be pre-fetched via the guarded url-attachment
      // path (https-only, same-origin redirects, 25MB cap — ops/mail_compose.ts) and arrive
      // here as content_base64. Never fetch arbitrary URLs from this layer.
      throw new Error(
        "planAttachments does not fetch url sources; pre-fetch via the guarded url-attachment " +
          "path and pass content_base64.",
      );
    }
    const bytes = base64ToBytes(input.content_base64);
    const type = input.type ?? "application/octet-stream";
    const name = input.name ?? `attachment${index}`;
    uploads.push({ index, bytes, type, name, cid: input.cid, inline: input.inline });
  }
  return { preCalls: [], bodyParts, uploads };
}

/**
 * After the caller uploads a PendingUpload's bytes, it calls this to turn the returned blobId into
 * the matching EmailBodyPart. Keeps upload/part construction consistent with blob-id sources.
 */
export function uploadedAttachmentPart(upload: PendingUpload, blobId: string): AttachmentBodyPart {
  return attachmentPart(blobId, {
    name: upload.name,
    type: upload.type,
    cid: upload.cid,
    inline: upload.inline,
  });
}

export interface PendingUpload {
  index: number;
  bytes: Uint8Array;
  type: string;
  name: string;
  cid?: string;
  inline?: boolean;
}

export interface AttachmentBodyPart {
  blobId: string;
  type: string;
  name?: string;
  cid?: string;
  disposition: "attachment" | "inline";
}

export interface SendPlan {
  /** Full method-call list: Email/set (create/existing) then EmailSubmission/set. */
  calls: MethodCall[];
  using: string[];
}

/**
 * Build the canonical send request (RFC 8621 §2.13). When `create` is given it is the Email/set
 * create body under creation id "email"; the submission references it via #creationId. When
 * `existingEmailId` is given, no Email/set is emitted and the submission targets it directly.
 * onSuccessUpdateEmail moves drafts→sent and clears $draft. send_at → FUTURERELEASE HOLDUNTIL
 * envelope param (requires the submissionExtensions FUTURERELEASE capability + maxDelayedSend > 0).
 */
export function planSend(args: {
  accountId: Id;
  identity: Identity;
  create?: EmailCreatePayload;
  existingEmailId?: Id;
  sendAt?: string;
  draftsMailboxId?: Id;
  sentMailboxId?: Id;
  submissionUsing: string[];
}): SendPlan {
  if (!args.create && !args.existingEmailId) {
    throw new Error("planSend requires either create or existingEmailId");
  }
  const creationId = "email";
  const calls: MethodCall[] = [];

  const onSuccessPatch = sentEmailPatch(args.draftsMailboxId, args.sentMailboxId);
  const envelope = args.sendAt ? futureReleaseEnvelope(args) : undefined;

  if (args.create) {
    calls.push([
      "Email/set",
      {
        accountId: args.accountId,
        create: { [creationId]: withDraftMailbox(args.create, args.draftsMailboxId) },
      },
      "emailSet",
    ]);
    calls.push([
      "EmailSubmission/set",
      {
        accountId: args.accountId,
        create: {
          send: {
            // RFC 8620 §5.3 creation-id reference — ResultReferences are top-level-argument
            // only; Stalwart rejects `#emailId` inside a create object.
            emailId: `#${creationId}`,
            identityId: args.identity.id,
            ...(envelope ? { envelope } : {}),
          },
        },
        // RFC 8621 §7.5: `#` keys name the EmailSubmission creation id, not the Email's.
        onSuccessUpdateEmail: { "#send": onSuccessPatch },
      },
      "submissionSet",
    ]);
  } else {
    calls.push([
      "EmailSubmission/set",
      {
        accountId: args.accountId,
        create: {
          send: {
            emailId: args.existingEmailId,
            identityId: args.identity.id,
            ...(envelope ? { envelope } : {}),
          },
        },
        onSuccessUpdateEmail: { [args.existingEmailId as string]: onSuccessPatch },
      },
      "submissionSet",
    ]);
  }
  return { calls, using: args.submissionUsing };
}

/** HTML → readable plain text (html-to-text), UTF-8-safe byte cap. Cuts bodies 5–20×. */
export function htmlToText(html: string, maxBytes?: number): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [{ selector: "img", format: "skip" }],
  });
  return capUtf8(text, maxBytes);
}

/** HTML → markdown-ish text (links/emphasis preserved) for body_as: "markdown". */
export function htmlToMarkdown(html: string, maxBytes?: number): string {
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { linkBrackets: false, hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
      { selector: "h1", options: { uppercase: false, prefix: "# " } },
      { selector: "h2", options: { uppercase: false, prefix: "## " } },
      { selector: "h3", options: { uppercase: false, prefix: "### " } },
    ],
  });
  return capUtf8(text, maxBytes);
}

// ── Body structure ────────────────────────────────────────────────────────────────────────────

/**
 * Emit the RFC 8621 §2.9 body props: exactly-one text/plain part, optional exactly-one text/html
 * part (nested in multipart/alternative), attachments wrapping the whole in multipart/mixed.
 * Returns { bodyStructure, bodyValues } — never a top-level `headers`.
 */
export function bodyStructureCreate(
  text: string,
  html: string | undefined,
  attachments: AttachmentBodyPart[],
): { bodyStructure: Record<string, unknown>; bodyValues: Record<string, unknown> } {
  const bodyValues: Record<string, unknown> = {};
  const inlineParts: Record<string, unknown>[] = [];

  bodyValues.text = { value: text };
  inlineParts.push({ partId: "text", type: "text/plain" });
  if (html !== undefined) {
    bodyValues.html = { value: html };
    inlineParts.push({ partId: "html", type: "text/html" });
  }

  const messageBody = inlineParts.length === 1
    ? inlineParts[0]
    : { type: "multipart/alternative", subParts: inlineParts };

  const attachmentParts = attachments.map((att) => ({
    blobId: att.blobId,
    type: att.type,
    ...(att.name ? { name: att.name } : {}),
    ...(att.cid ? { cid: att.cid } : {}),
    disposition: att.disposition,
  }));

  const bodyStructure = attachmentParts.length
    ? { type: "multipart/mixed", subParts: [messageBody, ...attachmentParts] }
    : messageBody;

  return { bodyStructure, bodyValues };
}

function attachmentPart(
  blobId: string,
  meta: { name?: string; type?: string; cid?: string; inline?: boolean },
): AttachmentBodyPart {
  return {
    blobId,
    type: meta.type ?? "application/octet-stream",
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.cid ? { cid: meta.cid } : {}),
    disposition: meta.inline ? "inline" : "attachment",
  };
}

// ── Subjects ──────────────────────────────────────────────────────────────────────────────────

/** RFC 5256 base subject: strip leading Re:/Fwd:/[tag] runs case-insensitively. */
export function baseSubject(subject: string | undefined): string {
  let s = (subject ?? "").trim();
  // Repeatedly peel leading list-tags "[...]" and reply/forward prefixes.
  for (;;) {
    const next = s
      .replace(/^\[[^\]]*\]\s*/, "")
      .replace(/^(re|fwd|fw)\s*(\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

export function replySubject(subject: string | undefined): string {
  const base = baseSubject(subject);
  return base ? `Re: ${base}` : "Re:";
}

export function forwardSubject(subject: string | undefined): string {
  const base = baseSubject(subject);
  return base ? `Fwd: ${base}` : "Fwd:";
}

// ── Quoting ───────────────────────────────────────────────────────────────────────────────────

function composeBodyText(userText: string | undefined, quoted: string): string {
  const parts = [userText ?? ""];
  if (quoted.trim()) parts.push(quoted);
  return parts.filter((p) => p !== "").join("\n\n");
}

function composeBodyHtml(userHtml: string, quoted: string): string {
  const parts = [userHtml];
  if (quoted.trim()) parts.push(quoted);
  return parts.filter((p) => p !== "").join("\n");
}

function quotePlain(body: string): string {
  if (!body.trim()) return "";
  return body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
}

function quoteHtml(html: string): string {
  if (!html.trim()) return "";
  return `<blockquote type="cite">${html}</blockquote>`;
}

function forwardHeaderBlock(original: Email): string {
  const from = flattenAddresses(original.from);
  const to = flattenAddresses(original.to);
  return [
    "---------- Forwarded message ---------",
    from ? `From: ${from}` : undefined,
    original.sentAt ? `Date: ${original.sentAt}` : undefined,
    original.subject ? `Subject: ${original.subject}` : undefined,
    to ? `To: ${to}` : undefined,
  ].filter((l): l is string => l !== undefined).join("\n");
}

function forwardHtmlBlock(original: Email): string {
  const header = forwardHeaderBlock(original).replace(/\n/g, "<br>");
  const body = parentHtmlBody(original) ||
    escapeHtml(parentPlainBody(original)).replace(/\n/g, "<br>");
  return `<div>${header}<br><br>${body}</div>`;
}

// ── Parent body extraction ──────────────────────────────────────────────────────────────────────

function parentPlainBody(email: Email): string {
  return bodyValueFor(email, email.textBody) ?? email.preview ?? "";
}

function parentHtmlBody(email: Email): string {
  return bodyValueFor(email, email.htmlBody) ?? "";
}

function bodyValueFor(email: Email, parts: Email["textBody"]): string | undefined {
  if (!email.bodyValues || !parts) return undefined;
  for (const part of parts) {
    const partId = typeof part.partId === "string" ? part.partId : undefined;
    if (!partId) continue;
    const value = email.bodyValues[partId];
    if (value && typeof value.value === "string") return value.value;
  }
  return undefined;
}

// ── Address helpers ──────────────────────────────────────────────────────────────────────────

function identityAddress(identity: Identity): EmailAddress {
  return { ...(identity.name ? { name: identity.name } : {}), email: identity.email };
}

function addressOut(a: { name?: string; email: string }): EmailAddress {
  return { ...(a.name ? { name: a.name } : {}), email: a.email };
}

function nonEmptyAddresses(value: EmailAddress[] | null | undefined): EmailAddress[] | undefined {
  return value && value.length ? value : undefined;
}

function nonEmptyStrings(value: string[] | null | undefined): string[] | undefined {
  return value && value.length ? value : undefined;
}

function dedupeAddresses(addrs: EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of addrs) {
    const key = normalizeAddress(a.email);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function normalizeAddressSet(addresses: string[]): Set<string> {
  return new Set(addresses.map(normalizeAddress));
}

/** Case-fold the address for self/dup comparison (mailbox part case is host-dependent, but the
 * pragmatic choice matching v1 and mail clients is a full lowercase). */
export function normalizeAddress(email: string): string {
  return email.trim().toLowerCase();
}

function flattenAddresses(value: EmailAddress[] | null | undefined): string | undefined {
  if (!value || !value.length) return undefined;
  return value
    .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
    .join(", ");
}

// ── Submission helpers ─────────────────────────────────────────────────────────────────────────

function sentEmailPatch(draftsId: Id | undefined, sentId: Id | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = { "keywords/$draft": null, "keywords/$seen": true };
  if (draftsId) patch[`mailboxIds/${draftsId}`] = null;
  if (sentId) patch[`mailboxIds/${sentId}`] = true;
  return patch;
}

function withDraftMailbox(
  create: EmailCreatePayload,
  draftsId: Id | undefined,
): EmailCreatePayload {
  // The submission's onSuccessUpdateEmail moves the message out of drafts; give it a mailbox to
  // live in until then. Caller may already have set mailboxIds — respect that.
  if (create.mailboxIds || !draftsId) {
    return { ...create, keywords: mergeDraftKeywords(create.keywords) };
  }
  return {
    ...create,
    mailboxIds: { [draftsId]: true },
    keywords: mergeDraftKeywords(create.keywords),
  };
}

function mergeDraftKeywords(existing: unknown): Record<string, boolean> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, boolean>
    : {};
  return { ...base, "$draft": true, "$seen": true };
}

function futureReleaseEnvelope(args: {
  identity: Identity;
  sendAt?: string;
}): Record<string, unknown> {
  // FUTURERELEASE HOLDUNTIL takes an RFC 3339 instant; rcptTo is derived server-side when omitted,
  // but the envelope must be complete, so we leave rcptTo to the caller/server default by supplying
  // only mailFrom with the hold parameter. Stalwart derives rcptTo from To+Cc+Bcc when rcptTo is
  // empty — but the spec requires rcptTo, so callers using send_at MUST pass recipients; here we
  // encode the hold on mailFrom and let the op layer fill rcptTo.
  return {
    mailFrom: {
      email: args.identity.email,
      parameters: { HOLDUNTIL: args.sendAt },
    },
    rcptTo: [],
  };
}

// ── Byte/utf-8 helpers ─────────────────────────────────────────────────────────────────────────

/** Truncate to at most maxBytes UTF-8 octets without splitting a codepoint. */
export function capUtf8(text: string, maxBytes?: number): string {
  if (!maxBytes) return text;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  // TextDecoder with fatal:false trims a trailing partial sequence to U+FFFD; strip it.
  const decoded = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return decoded.endsWith("�") ? decoded.slice(0, -1) : decoded;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) ||
    "forwarded";
}
