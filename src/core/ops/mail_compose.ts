/**
 * mail compose/send ops — builder B8-ops-mail-write (this file).
 *
 * Ops (see docs/v2-contracts.md §op inventory):
 * - mail.reply → reply_email           [mcp, cli]  outward  projection: email
 *     RFC-correct threading via core/compose.buildReply(); send:false ⇒ draft in Drafts with
 *     $draft; send:true ⇒ batched Email/set create + EmailSubmission/set with onSuccessUpdateEmail
 *     drafts→sent AND $answered set on the PARENT via onSuccessUpdateEmail. confirmClass outward.
 * - mail.send → send_email             [mcp, cli]  outward  projection: email
 *     compose+submit OR send an existing draft_id; attachment sources
 *     {blob_id}|{content_base64}|{url}|{text} — small (<256KB) inline via in-request Blob/upload +
 *     #creationId chaining, else the HTTP upload endpoint; url source SSRF-guarded (https-only, no
 *     cross-origin redirect, 25MB cap); send_at delayed send via FUTURERELEASE HOLDUNTIL when the
 *     submission capability advertises maxDelayedSend > 0; response carries undo_status.
 *     confirmClass outward.
 * - mail.cancel_send → cancel_send     [mcp, cli]  none     projection: raw
 *     flip a pending EmailSubmission undoStatus → canceled; surface cannotUnsend clearly.
 * - mail.forward → forward_emails      [mcp, cli]  outward  projection: email
 *     zero-copy original via blobId reattach (message/rfc822); $forwarded set on each original via
 *     onSuccessUpdateEmail. confirmClass outward.
 * - draft.list → list_drafts           [cli]       none     readOnly  projection: email
 * - draft.create → create_draft        [cli]       none     projection: email
 * - draft.update → update_draft        [cli]       none     projection: email
 *     JMAP Email objects are largely immutable; "update" = create replacement + destroy old, so the
 *     returned id CHANGES (documented in the description and echoed as replaced_id).
 * - draft.delete → delete_draft        [cli]       none     projection: email
 * - vacation.get → get_vacation        [cli]       none     readOnly  projection: raw
 * - vacation.set → set_vacation        [cli]       outward  projection: raw
 *     auto-replies go to other humans (RFC 3834) → outward.
 *
 * Handler recipe: validate cross-field invariants → resolve account (submission/mail/vacation
 * capability) → build method calls (back-refs via ref()) → normalize via envelopes → project via
 * project("email", …). For gated mutations consult effectiveGate() first and return a
 * ConfirmChallenge when two-phase.
 */
import { z } from "zod";
import { defineOp, type OpContext, type OpDefinition } from "./registry.ts";
import { CAPABILITIES, USING } from "../jmap/session.ts";
import { ref } from "../jmap/client.ts";
import type { JmapClient, MethodCall } from "../jmap/client.ts";
import type { AccountRef } from "../jmap/client.ts";
import { type Envelope, expectResponse, type SetError, setOutcome } from "../jmap/envelopes.ts";
import type { Email, Id, Identity, Mailbox } from "../jmap/types.ts";
import { mailboxRoleMap } from "../jmap/types.ts";
import {
  buildCompose,
  buildForward,
  buildReply,
  type EmailCreatePayload,
  normalizeAddress,
  planAttachments,
  uploadedAttachmentPart,
} from "../compose.ts";
import type { AttachmentBodyPart, PendingUpload } from "../compose.ts";
import type { AttachmentInput, ComposeEmailInput } from "../schemas/mail.ts";
import { AddressInputSchema, AttachmentInputSchema, KeywordSchema } from "../schemas/mail.ts";
import {
  AccountIdSchema,
  ConfirmTokenSchema,
  FieldsSchema,
  JmapIdSchema,
  LimitSchema,
  ProjectionSchema,
} from "../schemas/common.ts";
import {
  type ConfirmChallenge,
  type ConfirmIntent,
  effectiveGate,
  mintConfirmToken,
  verifyConfirmToken,
} from "../safety.ts";
import { project, type ProjectionContext, type ProjectionMode } from "../projections.ts";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/** Below this combined size we inline attachment bytes via in-request Blob/upload (#creationId
 * chaining, no extra round-trip); at/above it we POST to the HTTP upload endpoint. */
const INLINE_BLOB_MAX_BYTES = 256 * 1024;
/** SSRF guard: hard cap on bytes fetched from a `url` attachment source. */
const URL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

// ────────────────────────────────────────────────────────────────────────────
// Shared arg fragments
// ────────────────────────────────────────────────────────────────────────────

const bodyReadArgs = {
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

/** Attachment schema shared across reply/send/forward. Adds a plain-text source on top of the
 * three schema union sources (blob_id / content_base64 / url) as a convenience for agents. */
const AttachmentArgSchema = z.union([
  AttachmentInputSchema,
  z.object({
    text: z.string(),
    name: z.string().min(1),
    type: z.string().optional(),
    cid: z.string().optional(),
    inline: z.boolean().optional(),
  }).strict(),
]);
type AttachmentArg = z.infer<typeof AttachmentArgSchema>;

// ────────────────────────────────────────────────────────────────────────────
// Account / identity / mailbox resolution
// ────────────────────────────────────────────────────────────────────────────

/** Fetch this account's identities (Identity/get ids:null is allowed for the small type). */
async function fetchIdentities(
  jmap: JmapClient,
  auth: OpContext["actor"],
  account: AccountRef,
): Promise<Identity[]> {
  const res = await jmap.call(auth, using(USING.submission), "Identity/get", {
    accountId: account.accountId,
    ids: null,
  });
  return Array.isArray(res.list) ? res.list as Identity[] : [];
}

/** Choose an Identity: explicit id → From-address match → first. Throws when none exist. */
function pickIdentity(
  identities: Identity[],
  opts: { identityId?: string; fromEmail?: string },
): Identity {
  if (identities.length === 0) {
    throw new Error("account has no send identities (Identity/get returned none)");
  }
  if (opts.identityId) {
    const byId = identities.find((i) => i.id === opts.identityId);
    if (!byId) throw new Error(`identity_id "${opts.identityId}" not found`);
    return byId;
  }
  if (opts.fromEmail) {
    const wanted = normalizeAddress(opts.fromEmail);
    const byAddr = identities.find((i) => normalizeAddress(i.email) === wanted);
    if (byAddr) return byAddr;
  }
  return identities[0];
}

/** The caller's own addresses (identity emails, lowercased) — used for reply-all self-exclusion. */
function ownAddresses(identities: Identity[]): string[] {
  return identities.map((i) => normalizeAddress(i.email));
}

interface MailboxIndex {
  byRole: Record<string, Id>;
  /** id → {name, role} for projection. */
  map: Map<string, { name: string; role?: string | null }>;
}

/** Fetch all mailboxes once (Mailbox/get ids:null); build role→id + projection maps. */
async function fetchMailboxIndex(
  jmap: JmapClient,
  auth: OpContext["actor"],
  account: AccountRef,
): Promise<MailboxIndex> {
  const res = await jmap.call(auth, using(USING.mail), "Mailbox/get", {
    accountId: account.accountId,
    ids: null,
    properties: ["id", "name", "role"],
  });
  const list = Array.isArray(res.list) ? res.list as Mailbox[] : [];
  const map = new Map<string, { name: string; role?: string | null }>();
  for (const mb of list) map.set(mb.id, { name: mb.name, role: mb.role ?? null });
  return { byRole: mailboxRoleMap(list), map };
}

// ────────────────────────────────────────────────────────────────────────────
// Attachment planning (in-request Blob/upload for small, HTTP upload for large)
// ────────────────────────────────────────────────────────────────────────────

interface AttachmentPlan {
  /** Method calls to prepend (Blob/upload for the inlined sources), keyed callId "blobUpload". */
  preCalls: MethodCall[];
  /** Resolved body parts (blob_id sources + already-uploaded HTTP-endpoint sources). */
  bodyParts: AttachmentBodyPart[];
  /** Pending in-request uploads: creationId → its eventual body part metadata. */
  inlineParts: { creationId: string; meta: PendingUpload }[];
}

/** Normalize a text-source attachment arg into the base64 form planAttachments understands. */
function coerceAttachment(input: AttachmentArg): AttachmentInput {
  if ("text" in input) {
    const bytes = new TextEncoder().encode(input.text);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return {
      content_base64: btoa(binary),
      name: input.name,
      type: input.type ?? "text/plain",
      ...(input.cid ? { cid: input.cid } : {}),
      ...(input.inline !== undefined ? { inline: input.inline } : {}),
    };
  }
  return input;
}

/**
 * Guarded fetch for a `url` attachment source: https only, no cross-origin redirect, 25MB cap.
 * Returns the bytes and the resolved content type/name.
 */
async function fetchUrlAttachment(
  rawUrl: string,
): Promise<{ bytes: Uint8Array; type?: string }> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error(`url attachment must be https (got ${url.protocol})`);
  }
  const origin = url.origin;
  const response = await fetch(url, {
    redirect: "manual",
    headers: { Accept: "*/*" },
  });
  // Manual redirect: reject any redirect that leaves the original origin (SSRF pivot guard).
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("url attachment redirect had no Location");
    const target = new URL(location, url);
    if (target.origin !== origin) {
      await response.body?.cancel();
      throw new Error("url attachment cross-origin redirect refused (SSRF guard)");
    }
    // Same-origin redirect: follow once explicitly, still guarded.
    await response.body?.cancel();
    return fetchUrlAttachment(target.toString());
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`url attachment fetch failed: HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > URL_ATTACHMENT_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(`url attachment exceeds ${URL_ATTACHMENT_MAX_BYTES} byte cap`);
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.byteLength > URL_ATTACHMENT_MAX_BYTES) {
    throw new Error(`url attachment exceeds ${URL_ATTACHMENT_MAX_BYTES} byte cap`);
  }
  return { bytes: buf, type: response.headers.get("content-type") ?? undefined };
}

/**
 * Plan all attachment sources for one message. blob_id sources pass through; content_base64/text
 * and url sources become raw bytes, then split by size: small ones ride an in-request Blob/upload
 * (chained via #creationId, no extra HTTP round-trip), large ones POST to the upload endpoint now.
 */
async function planMessageAttachments(
  ctx: OpContext,
  account: AccountRef,
  inputs: AttachmentArg[] | undefined,
): Promise<AttachmentPlan> {
  const plan: AttachmentPlan = { preCalls: [], bodyParts: [], inlineParts: [] };
  if (!inputs || inputs.length === 0) return plan;

  // Pre-fetch url sources (guarded) so planAttachments sees concrete bytes.
  const coerced: AttachmentInput[] = [];
  for (const raw of inputs) {
    const input = coerceAttachment(raw);
    if ("url" in input) {
      const fetched = await fetchUrlAttachment(input.url);
      let binary = "";
      for (const b of fetched.bytes) binary += String.fromCharCode(b);
      coerced.push({
        content_base64: btoa(binary),
        name: input.name ?? filenameFromUrl(input.url),
        type: input.type ?? fetched.type ?? "application/octet-stream",
        ...(input.cid ? { cid: input.cid } : {}),
        ...(input.inline !== undefined ? { inline: input.inline } : {}),
      });
    } else {
      coerced.push(input);
    }
  }

  const { bodyParts, uploads } = await planAttachments(coerced, account.accountId);
  plan.bodyParts.push(...bodyParts);

  const inlineCreates: Record<string, unknown> = {};
  let inlineIndex = 0;
  for (const upload of uploads) {
    if (upload.bytes.byteLength < INLINE_BLOB_MAX_BYTES) {
      // In-request Blob/upload create (RFC 9404): base64 data source, chained via #creationId.
      const creationId = `att${inlineIndex++}`;
      let binary = "";
      for (const b of upload.bytes) binary += String.fromCharCode(b);
      inlineCreates[creationId] = {
        data: [{ "data:asBase64": btoa(binary) }],
        type: upload.type,
      };
      plan.inlineParts.push({ creationId, meta: upload });
    } else {
      // Too large for the request budget — HTTP upload endpoint now.
      const uploaded = await ctx.jmap.uploadBlob(
        ctx.actor,
        account.accountId,
        upload.bytes,
        upload.type,
      );
      plan.bodyParts.push(uploadedAttachmentPart(upload, uploaded.blobId));
    }
  }

  if (Object.keys(inlineCreates).length > 0) {
    plan.preCalls.push([
      "Blob/upload",
      { accountId: account.accountId, create: inlineCreates },
      "blobUpload",
    ]);
  }
  return plan;
}

function filenameFromUrl(url: string): string {
  const last = url.split("?")[0].split("/").pop();
  return last && last.length ? decodeURIComponent(last) : "attachment";
}

/** Merge the in-request-uploaded parts (referencing #creationId blobIds) onto a create payload. */
function withInlineAttachments(
  create: EmailCreatePayload,
  plan: AttachmentPlan,
): EmailCreatePayload {
  const extraParts: AttachmentBodyPart[] = plan.inlineParts.map(({ creationId, meta }) =>
    uploadedAttachmentPart(meta, `#${creationId}`)
  );
  if (extraParts.length === 0 && plan.bodyParts.length === 0) return create;
  return mergeAttachmentsIntoStructure(create, [...plan.bodyParts, ...extraParts]);
}

/**
 * Fold additional attachment parts into an already-built bodyStructure. If the existing structure
 * is a multipart/mixed we append; otherwise we wrap the message body in a new multipart/mixed.
 */
function mergeAttachmentsIntoStructure(
  create: EmailCreatePayload,
  parts: AttachmentBodyPart[],
): EmailCreatePayload {
  if (parts.length === 0) return create;
  const structure = create.bodyStructure as Record<string, unknown> | undefined;
  const attachmentParts = parts.map((att) => ({
    blobId: att.blobId,
    type: att.type,
    ...(att.name ? { name: att.name } : {}),
    ...(att.cid ? { cid: att.cid } : {}),
    disposition: att.disposition,
  }));
  if (!structure) return create;
  if (structure.type === "multipart/mixed" && Array.isArray(structure.subParts)) {
    return {
      ...create,
      bodyStructure: {
        ...structure,
        subParts: [...structure.subParts, ...attachmentParts],
      },
    };
  }
  return {
    ...create,
    bodyStructure: {
      type: "multipart/mixed",
      subParts: [structure, ...attachmentParts],
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Confirmation helpers
// ────────────────────────────────────────────────────────────────────────────

/** Count distinct outward recipients (to+cc+bcc) on a create payload, for the gate signal. */
function countRecipients(create: EmailCreatePayload): number {
  const emails = new Set<string>();
  for (const key of ["to", "cc", "bcc"] as const) {
    const list = create[key];
    if (Array.isArray(list)) {
      for (const a of list) {
        const email = (a as { email?: string }).email;
        if (email) emails.add(normalizeAddress(email));
      }
    }
  }
  return emails.size;
}

/**
 * Two-phase gate: build the ConfirmIntent, check for a valid token, else mint a challenge.
 * Returns `{ challenge }` when the caller must re-invoke with a confirm_token, or `{ ok: true }`
 * when execution may proceed. Throws (actionable) on a drifted/expired token.
 */
async function gate(
  ctx: OpContext,
  args: {
    op: string;
    accountId: string;
    resourceIds: string[];
    payload: unknown;
    recipientCount?: number;
    queryPowered?: boolean;
    itemCount?: number;
    confirmClass: "outward" | "destructive" | "blast";
    confirmToken?: string;
    summary: string;
    preview?: unknown;
  },
): Promise<{ challenge: ConfirmChallenge } | { ok: true }> {
  const decision = effectiveGate({
    confirmClass: args.confirmClass,
    policy: ctx.policy,
    recipientCount: args.recipientCount,
    queryPowered: args.queryPowered,
    itemCount: args.itemCount,
  });
  if (decision === "direct") return { ok: true };

  const intent: ConfirmIntent = {
    op: args.op,
    account_id: args.accountId,
    resource_ids: [...args.resourceIds].sort(),
    payload: args.payload,
    actor_fingerprint: ctx.actor.fingerprint,
  };

  if (args.confirmToken) {
    const verdict = await verifyConfirmToken(
      ctx.config.confirmationSecret,
      args.confirmToken,
      intent,
    );
    if (verdict.ok) return { ok: true };
    const detail = verdict.reason === "mismatch" && verdict.diff
      ? ` (${JSON.stringify(verdict.diff)})`
      : "";
    throw new Error(`confirm_token ${verdict.reason}${detail}; re-run to obtain a fresh token`);
  }

  const token = await mintConfirmToken(ctx.config.confirmationSecret, intent);
  const challenge: ConfirmChallenge = {
    confirmation_required: true,
    summary: args.summary,
    ...(args.preview !== undefined ? { preview: args.preview } : {}),
    confirm_token: token,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  return { challenge };
}

// ────────────────────────────────────────────────────────────────────────────
// Submission plan assembly (create + submit + onSuccessUpdateEmail)
// ────────────────────────────────────────────────────────────────────────────

/** Detect FUTURERELEASE support from the submission capability's submissionExtensions. */
function futureReleaseSupported(account: AccountRef): boolean {
  const cap = account.session.capabilities?.[CAPABILITIES.submission] as
    | { maxDelayedSend?: number; submissionExtensions?: Record<string, unknown> }
    | undefined;
  if (!cap) return false;
  const maxDelay = typeof cap.maxDelayedSend === "number" ? cap.maxDelayedSend : 0;
  const hasExt = !!cap.submissionExtensions &&
    Object.keys(cap.submissionExtensions).some((k) => k.toUpperCase() === "FUTURERELEASE");
  return maxDelay > 0 || hasExt;
}

/** Recipients for the submission envelope (used only when send_at forces an explicit envelope). */
function envelopeRecipients(create: EmailCreatePayload): { email: string }[] {
  const out: { email: string }[] = [];
  const seen = new Set<string>();
  for (const key of ["to", "cc", "bcc"] as const) {
    const list = create[key];
    if (Array.isArray(list)) {
      for (const a of list) {
        const email = (a as { email?: string }).email;
        if (email && !seen.has(normalizeAddress(email))) {
          seen.add(normalizeAddress(email));
          out.push({ email });
        }
      }
    }
  }
  return out;
}

interface BuiltSend {
  calls: MethodCall[];
  using: string[];
  /** The Email/set create call id, when a new email is created (undefined for existing-draft). */
  emailCallId?: string;
  submissionCallId: string;
  /** The existing draft id being submitted, when no new email is created. */
  existingEmailId?: Id;
}

/** Copy a readonly USING tuple into the mutable string[] the client expects. */
function using(set: readonly string[]): string[] {
  return [...set];
}

/**
 * Build the full method-call list for a send: optional Blob/upload preCalls, an Email/set create
 * (with attachments folded in and $answered/$forwarded patches on other emails passed through the
 * submission's onSuccessUpdateEmail), then EmailSubmission/set. When `existingEmailId` is given no
 * Email/set is emitted. `extraOnSuccess` patches OTHER emails (e.g. the reply parent's $answered).
 */
function buildSend(args: {
  account: AccountRef;
  identity: Identity;
  create?: EmailCreatePayload;
  attachmentPlan?: AttachmentPlan;
  existingEmailId?: Id;
  sendAt?: string;
  draftsId?: Id;
  sentId?: Id;
  extraOnSuccess?: Record<string, Record<string, unknown>>;
}): BuiltSend {
  const calls: MethodCall[] = [];
  if (args.attachmentPlan) calls.push(...args.attachmentPlan.preCalls);

  const creationId = "email";
  const onSuccess: Record<string, Record<string, unknown>> = { ...(args.extraOnSuccess ?? {}) };

  const envelope = args.sendAt
    ? {
      mailFrom: {
        email: args.identity.email,
        parameters: { HOLDUNTIL: args.sendAt },
      },
      rcptTo: args.create ? envelopeRecipients(args.create) : [],
    }
    : undefined;

  if (args.create) {
    const withAtt = args.attachmentPlan
      ? withInlineAttachments(args.create, args.attachmentPlan)
      : args.create;
    const create = draftMailbox(withAtt, args.draftsId);
    calls.push(["Email/set", {
      accountId: args.account.accountId,
      create: { [creationId]: create },
    }, "emailSet"]);
    onSuccess[`#${creationId}`] = sentPatch(args.draftsId, args.sentId);
    calls.push([
      "EmailSubmission/set",
      {
        accountId: args.account.accountId,
        create: {
          send: {
            "#emailId": ref("emailSet", "Email/set", `/created/${creationId}/id`),
            identityId: args.identity.id,
            ...(envelope ? { envelope } : {}),
          },
        },
        onSuccessUpdateEmail: onSuccess,
      },
      "submissionSet",
    ]);
    return {
      calls,
      using: using(USING.submission),
      emailCallId: "emailSet",
      submissionCallId: "submissionSet",
    };
  }

  onSuccess[args.existingEmailId as string] = sentPatch(args.draftsId, args.sentId);
  calls.push([
    "EmailSubmission/set",
    {
      accountId: args.account.accountId,
      create: {
        send: {
          emailId: args.existingEmailId,
          identityId: args.identity.id,
          ...(envelope ? { envelope } : {}),
        },
      },
      onSuccessUpdateEmail: onSuccess,
    },
    "submissionSet",
  ]);
  return {
    calls,
    using: using(USING.submission),
    submissionCallId: "submissionSet",
    existingEmailId: args.existingEmailId,
  };
}

/** Ensure a create payload lives in Drafts and carries $draft/$seen until the submission moves it. */
function draftMailbox(create: EmailCreatePayload, draftsId: Id | undefined): EmailCreatePayload {
  const keywords = mergeKeywords(create.keywords, { "$draft": true, "$seen": true });
  if (create.mailboxIds || !draftsId) return { ...create, keywords };
  return { ...create, mailboxIds: { [draftsId]: true }, keywords };
}

function mergeKeywords(existing: unknown, add: Record<string, boolean>): Record<string, boolean> {
  const base = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, boolean>
    : {};
  return { ...base, ...add };
}

/** onSuccessUpdateEmail patch that moves the sent message drafts→sent and clears $draft. */
function sentPatch(draftsId: Id | undefined, sentId: Id | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = { "keywords/$draft": null, "keywords/$seen": true };
  if (draftsId) patch[`mailboxIds/${draftsId}`] = null;
  if (sentId) patch[`mailboxIds/${sentId}`] = true;
  return patch;
}

// ────────────────────────────────────────────────────────────────────────────
// Send execution + result shaping
// ────────────────────────────────────────────────────────────────────────────

interface SendResult {
  envelope: Envelope<unknown>;
  undoStatus?: string;
  submissionId?: Id;
  emailId?: Id;
}

/**
 * Run a BuiltSend, surface per-item failures without throwing, fetch the submission's undoStatus
 * and the created/sent email (brief-projected). `resultOnFailure` is returned as-is when the
 * submission failed entirely so the caller can shape a coherent envelope.
 */
async function executeSend(
  ctx: OpContext,
  account: AccountRef,
  built: BuiltSend,
  proj: { mode: ProjectionMode; fields?: string[]; mailboxes?: MailboxIndex },
): Promise<SendResult> {
  const result = await ctx.jmap.request(ctx.actor, built.using, built.calls);
  const responses = result.methodResponses;

  const failed: Record<string, SetError> = {};

  // Email/set (when creating) — collect any create failure.
  let createdEmailId: Id | undefined;
  if (built.emailCallId) {
    const emailRes = expectResponse(responses, "Email/set", built.emailCallId);
    const emailOutcome = setOutcome(emailRes);
    Object.assign(failed, emailOutcome.failed);
    const created = emailOutcome.created["email"];
    if (created && typeof created.id === "string") createdEmailId = created.id;
  }

  const submissionRes = expectResponse(responses, "EmailSubmission/set", built.submissionCallId);
  const submissionOutcome = setOutcome(submissionRes);
  Object.assign(failed, submissionOutcome.failed);
  const submissionCreated = submissionOutcome.created["send"];
  const submissionId = submissionCreated && typeof submissionCreated.id === "string"
    ? submissionCreated.id
    : undefined;
  const undoStatus = submissionCreated && typeof submissionCreated.undoStatus === "string"
    ? submissionCreated.undoStatus as string
    : (submissionId ? "final" : undefined);

  // The implicit Email/set from onSuccessUpdateEmail rides on the SAME call id as the submission
  // set; its result is a second entry with method "Email/set" carrying the moved-message id.
  const emailId = createdEmailId ?? built.existingEmailId;

  const items: unknown[] = [];
  if (emailId) {
    const ctxProj = projectionCtx(ctx, proj.mode, proj.fields, proj.mailboxes);
    // Fetch the sent email for a brief-projected item (post-move: it lives in Sent now).
    const emailBrief = await fetchEmailBrief(ctx, account, emailId, ctxProj, proj.mode);
    if (emailBrief) items.push(emailBrief);
    else items.push({ id: emailId });
  }

  const envelope: Envelope<unknown> = { items };
  if (Object.keys(failed).length > 0) envelope.failed = failed;
  return { envelope, undoStatus, submissionId, emailId };
}

/** Fetch one Email brief-projected (best-effort; returns undefined on any read failure). */
async function fetchEmailBrief(
  ctx: OpContext,
  account: AccountRef,
  emailId: Id,
  ctxProj: ProjectionContext,
  mode: ProjectionMode,
): Promise<unknown | undefined> {
  try {
    const res = await ctx.jmap.call(ctx.actor, using(USING.mail), "Email/get", {
      accountId: account.accountId,
      ids: [emailId],
      properties: [
        "id",
        "threadId",
        "mailboxIds",
        "keywords",
        "from",
        "to",
        "cc",
        "subject",
        "receivedAt",
        "preview",
        "hasAttachment",
      ],
    });
    const email = Array.isArray(res.list) ? (res.list as Email[])[0] : undefined;
    if (!email) return undefined;
    return project("email", email, mode, ctxProj);
  } catch {
    return undefined;
  }
}

function projectionCtx(
  _ctx: OpContext,
  _mode: ProjectionMode,
  fields: string[] | undefined,
  mailboxes: MailboxIndex | undefined,
): ProjectionContext {
  return {
    mailboxes: mailboxes?.map,
    ...(fields ? { fields } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Op: mail.reply
// ────────────────────────────────────────────────────────────────────────────

const replyOp = defineOp({
  name: "mail.reply",
  mcpName: "reply_email",
  description:
    "Reply to an email on the user's personal self-hosted mail (Letterdog). RFC-correct threading: " +
    "In-Reply-To = the parent's Message-Id, References = the parent's References + Message-Id, so " +
    "the reply stays in-thread. Recipients come from the parent's Reply-To (else From); reply_all " +
    "adds the parent's To+Cc minus your own addresses. The base subject is preserved (single Re:). " +
    "send:false drafts it in Drafts ($draft); send:true submits it and marks the parent $answered. " +
    "Under the balanced policy a send to >3 recipients returns a confirm_token to repeat with.",
  input: {
    email_id: JmapIdSchema,
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    reply_all: z.boolean().optional(),
    quote: z.boolean().optional(),
    attachments: z.array(AttachmentArgSchema).optional(),
    identity_id: z.string().optional(),
    send: z.boolean().default(false),
    confirm_token: ConfirmTokenSchema,
    ...bodyReadArgs,
  },
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "outward",
  projection: "email",
  surfaces: ["mcp", "cli"],
  handler: replyHandler,
});

async function replyHandler(
  args: {
    email_id: string;
    body_text?: string;
    body_html?: string;
    reply_all?: boolean;
    quote?: boolean;
    attachments?: AttachmentArg[];
    identity_id?: string;
    send: boolean;
    confirm_token?: string;
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  if (args.body_text === undefined && args.body_html === undefined) {
    throw new Error("reply requires body_text or body_html");
  }
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const [identities, mailboxes] = await Promise.all([
    fetchIdentities(ctx.jmap, ctx.actor, account),
    fetchMailboxIndex(ctx.jmap, ctx.actor, account),
  ]);
  const parent = await fetchEmailForReply(ctx, account, args.email_id);
  const identity = pickIdentity(identities, {
    identityId: args.identity_id,
    fromEmail: firstAddressEmail(parent.to) ?? undefined,
  });

  const create = buildReply(parent, identity, ownAddresses(identities), {
    reply_all: args.reply_all,
    body_text: args.body_text,
    body_html: args.body_html,
    quote: args.quote,
    attachments: args.attachments?.map(coerceAttachment),
  });
  const plan = await planMessageAttachments(ctx, account, args.attachments);

  if (!args.send) {
    return draftFromCreate(ctx, account, create, plan, mailboxes, args.projection, args.fields);
  }

  const gateResult = await gate(ctx, {
    op: "mail.reply",
    accountId: account.accountId,
    resourceIds: [args.email_id],
    payload: { subject: create.subject, to: create.to },
    recipientCount: countRecipients(create),
    confirmClass: "outward",
    confirmToken: args.confirm_token,
    summary: `Reply to ${firstAddressEmail(parent.from) ?? "sender"} (${
      countRecipients(create)
    } recipient(s))`,
    preview: project("email", { ...parent }, "brief", { mailboxes: mailboxes.map }),
  });
  if ("challenge" in gateResult) return gateResult.challenge;

  const built = buildSend({
    account,
    identity,
    create,
    attachmentPlan: plan,
    draftsId: mailboxes.byRole["drafts"],
    sentId: mailboxes.byRole["sent"],
    // Mark the parent $answered on successful submission (a keyword patch on the parent id).
    extraOnSuccess: { [args.email_id]: { "keywords/$answered": true } },
  });
  const result = await executeSend(ctx, account, built, {
    mode: args.projection,
    fields: args.fields,
    mailboxes,
  });
  return withUndoStatus(result);
}

/** Fetch the parent with the props buildReply needs (threading + body for quoting). */
async function fetchEmailForReply(ctx: OpContext, account: AccountRef, id: Id): Promise<Email> {
  const res = await ctx.jmap.call(ctx.actor, using(USING.mail), "Email/get", {
    accountId: account.accountId,
    ids: [id],
    properties: [
      "id",
      "blobId",
      "messageId",
      "inReplyTo",
      "references",
      "from",
      "to",
      "cc",
      "replyTo",
      "subject",
      "sentAt",
      "preview",
      "textBody",
      "htmlBody",
      "bodyValues",
    ],
    fetchTextBodyValues: true,
    fetchHTMLBodyValues: true,
  });
  const email = Array.isArray(res.list) ? (res.list as Email[])[0] : undefined;
  if (!email) throw new Error(`email "${id}" not found`);
  return email;
}

// ────────────────────────────────────────────────────────────────────────────
// Op: mail.send
// ────────────────────────────────────────────────────────────────────────────

const sendOp = defineOp({
  name: "mail.send",
  mcpName: "send_email",
  description:
    "Compose and send a new email, or submit an existing draft (draft_id), on the user's personal " +
    "self-hosted mail (Letterdog). Attachments accept {blob_id} | {content_base64} | {url} | " +
    "{text}: small payloads inline via an in-request blob upload, larger ones stream to the upload " +
    "endpoint; url sources are https-only, refuse cross-origin redirects, and cap at 25MB. " +
    "send_at (a UTC datetime) schedules delayed send via FUTURERELEASE when the server advertises " +
    "it — cancel within the window using cancel_send with the returned submission_id. The response " +
    "carries undo_status. Under balanced policy, >3 recipients returns a confirm_token to repeat.",
  input: {
    draft_id: JmapIdSchema.optional(),
    from: AddressInputSchema.optional(),
    to: z.array(AddressInputSchema).optional(),
    cc: z.array(AddressInputSchema).optional(),
    bcc: z.array(AddressInputSchema).optional(),
    reply_to: z.array(AddressInputSchema).optional(),
    subject: z.string().optional(),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    attachments: z.array(AttachmentArgSchema).optional(),
    identity_id: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    keywords: z.array(KeywordSchema).optional(),
    send_at: z.string().optional(),
    confirm_token: ConfirmTokenSchema,
    ...bodyReadArgs,
  },
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "outward",
  projection: "email",
  surfaces: ["mcp", "cli"],
  handler: sendHandler,
});

async function sendHandler(
  args: {
    draft_id?: string;
    from?: { name?: string; email: string };
    to?: { name?: string; email: string }[];
    cc?: { name?: string; email: string }[];
    bcc?: { name?: string; email: string }[];
    reply_to?: { name?: string; email: string }[];
    subject?: string;
    body_text?: string;
    body_html?: string;
    attachments?: AttachmentArg[];
    identity_id?: string;
    headers?: Record<string, string>;
    keywords?: string[];
    send_at?: string;
    confirm_token?: string;
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const [identities, mailboxes] = await Promise.all([
    fetchIdentities(ctx.jmap, ctx.actor, account),
    fetchMailboxIndex(ctx.jmap, ctx.actor, account),
  ]);

  if (args.send_at && !futureReleaseSupported(account)) {
    throw new Error(
      "send_at requested but the server does not advertise FUTURERELEASE delayed send",
    );
  }

  // Path A: submit an existing draft.
  if (args.draft_id) {
    const identity = pickIdentity(identities, { identityId: args.identity_id });
    const recipientCount = await draftRecipientCount(ctx, account, args.draft_id);
    const gateResult = await gate(ctx, {
      op: "mail.send",
      accountId: account.accountId,
      resourceIds: [args.draft_id],
      payload: { draft_id: args.draft_id, send_at: args.send_at ?? null },
      recipientCount,
      confirmClass: "outward",
      confirmToken: args.confirm_token,
      summary: `Send draft ${args.draft_id} (${recipientCount} recipient(s))`,
    });
    if ("challenge" in gateResult) return gateResult.challenge;

    const built = buildSend({
      account,
      identity,
      existingEmailId: args.draft_id,
      sendAt: args.send_at,
      draftsId: mailboxes.byRole["drafts"],
      sentId: mailboxes.byRole["sent"],
    });
    const result = await executeSend(ctx, account, built, {
      mode: args.projection,
      fields: args.fields,
      mailboxes,
    });
    return withUndoStatus(result);
  }

  // Path B: compose new + submit.
  if (!args.subject) throw new Error("send requires a subject (or a draft_id to submit)");
  if (args.body_text === undefined && args.body_html === undefined) {
    throw new Error("send requires body_text or body_html (or a draft_id to submit)");
  }
  const identity = pickIdentity(identities, {
    identityId: args.identity_id,
    fromEmail: args.from?.email,
  });
  const composeInput: ComposeEmailInput = {
    from: args.from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    reply_to: args.reply_to,
    subject: args.subject,
    body_text: args.body_text,
    body_html: args.body_html,
    identity_id: args.identity_id,
    headers: args.headers,
    keywords: args.keywords,
  };
  const create = buildCompose(composeInput, identity);
  const plan = await planMessageAttachments(ctx, account, args.attachments);

  const recipientCount = countRecipients(create);
  const gateResult = await gate(ctx, {
    op: "mail.send",
    accountId: account.accountId,
    resourceIds: ["compose"],
    payload: {
      subject: args.subject,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      send_at: args.send_at ?? null,
    },
    recipientCount,
    confirmClass: "outward",
    confirmToken: args.confirm_token,
    summary: `Send "${args.subject}" (${recipientCount} recipient(s))`,
  });
  if ("challenge" in gateResult) return gateResult.challenge;

  const built = buildSend({
    account,
    identity,
    create,
    attachmentPlan: plan,
    sendAt: args.send_at,
    draftsId: mailboxes.byRole["drafts"],
    sentId: mailboxes.byRole["sent"],
  });
  const result = await executeSend(ctx, account, built, {
    mode: args.projection,
    fields: args.fields,
    mailboxes,
  });
  return withUndoStatus(result);
}

/** Count recipients on an existing draft (for the gate). Best-effort — 0 on read failure. */
async function draftRecipientCount(ctx: OpContext, account: AccountRef, id: Id): Promise<number> {
  try {
    const res = await ctx.jmap.call(ctx.actor, using(USING.mail), "Email/get", {
      accountId: account.accountId,
      ids: [id],
      properties: ["to", "cc", "bcc"],
    });
    const email = Array.isArray(res.list) ? (res.list as Email[])[0] : undefined;
    if (!email) return 0;
    return countRecipients(email as unknown as EmailCreatePayload);
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Op: mail.cancel_send
// ────────────────────────────────────────────────────────────────────────────

const cancelSendOp = defineOp({
  name: "mail.cancel_send",
  mcpName: "cancel_send",
  description:
    "Cancel a still-pending email submission on the user's personal self-hosted mail (Letterdog) " +
    "by flipping its undoStatus to canceled — use the submission_id returned by send_email while " +
    "the delayed-send window is open. If the message already left the server the update fails with " +
    "cannotUnsend, surfaced clearly in failed; there is no way to recall it after that.",
  input: {
    submission_id: JmapIdSchema,
    account_id: AccountIdSchema,
  },
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["mcp", "cli"],
  handler: cancelSendHandler,
});

async function cancelSendHandler(
  args: { submission_id: string; account_id?: string },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.submission,
    args.account_id,
  );
  const res = await ctx.jmap.call(ctx.actor, using(USING.submission), "EmailSubmission/set", {
    accountId: account.accountId,
    update: { [args.submission_id]: { undoStatus: "canceled" } },
  });
  const outcome = setOutcome(res);
  const failure = outcome.failed[args.submission_id];
  const items: unknown[] = [];
  if (!failure) {
    items.push({ id: args.submission_id, undo_status: "canceled", canceled: true });
  } else if (failure.type === "cannotUnsend") {
    // Surface cannotUnsend as an explicit, actionable failed entry.
    const envelope: Envelope<unknown> = {
      items: [{ id: args.submission_id, canceled: false, reason: "cannotUnsend" }],
      failed: { [args.submission_id]: failure },
    };
    return envelope;
  }
  const envelope: Envelope<unknown> = { items };
  if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
  return envelope;
}

// ────────────────────────────────────────────────────────────────────────────
// Op: mail.forward
// ────────────────────────────────────────────────────────────────────────────

const forwardOp = defineOp({
  name: "mail.forward",
  mcpName: "forward_emails",
  description:
    "Forward one or more emails from the user's personal self-hosted mail (Letterdog) to new " +
    "recipients. Each original is reattached zero-copy by referencing its blobId as a " +
    "message/rfc822 part (no download/upload), preserving full MIME fidelity; set attach_original " +
    "false to inline-quote instead. Each forwarded original is marked $forwarded on success. " +
    "Batch-first: pass email_ids as an array; per-item failures surface in failed. Under balanced " +
    "policy, sending to >3 recipients returns a confirm_token to repeat the call with.",
  input: {
    email_ids: z.array(JmapIdSchema).min(1).max(50),
    to: z.array(AddressInputSchema).min(1),
    cc: z.array(AddressInputSchema).optional(),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    attach_original: z.boolean().optional(),
    identity_id: z.string().optional(),
    confirm_token: ConfirmTokenSchema,
    ...bodyReadArgs,
  },
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "outward",
  projection: "email",
  surfaces: ["mcp", "cli"],
  handler: forwardHandler,
});

async function forwardHandler(
  args: {
    email_ids: string[];
    to: { name?: string; email: string }[];
    cc?: { name?: string; email: string }[];
    body_text?: string;
    body_html?: string;
    attach_original?: boolean;
    identity_id?: string;
    confirm_token?: string;
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const [identities, mailboxes] = await Promise.all([
    fetchIdentities(ctx.jmap, ctx.actor, account),
    fetchMailboxIndex(ctx.jmap, ctx.actor, account),
  ]);
  const identity = pickIdentity(identities, { identityId: args.identity_id });

  const recipientCount = new Set(
    [...args.to, ...(args.cc ?? [])].map((a) => normalizeAddress(a.email)),
  ).size;

  const gateResult = await gate(ctx, {
    op: "mail.forward",
    accountId: account.accountId,
    resourceIds: args.email_ids,
    payload: { to: args.to, cc: args.cc },
    recipientCount,
    confirmClass: "outward",
    confirmToken: args.confirm_token,
    summary: `Forward ${args.email_ids.length} email(s) to ${recipientCount} recipient(s)`,
  });
  if ("challenge" in gateResult) return gateResult.challenge;

  // Fetch all originals with the props buildForward needs.
  const originals = await fetchEmailsForForward(ctx, account, args.email_ids);

  const items: unknown[] = [];
  const failed: Record<string, SetError> = {};

  for (const id of args.email_ids) {
    const original = originals.get(id);
    if (!original) {
      failed[id] = { type: "notFound", description: `email "${id}" not found` };
      continue;
    }
    const create = buildForward(original, identity, {
      to: args.to,
      cc: args.cc,
      body_text: args.body_text,
      body_html: args.body_html,
      attach_original: args.attach_original,
    });
    const built = buildSend({
      account,
      identity,
      create,
      draftsId: mailboxes.byRole["drafts"],
      sentId: mailboxes.byRole["sent"],
      extraOnSuccess: { [id]: { "keywords/$forwarded": true } },
    });
    try {
      const result = await executeSend(ctx, account, built, {
        mode: args.projection,
        fields: args.fields,
        mailboxes,
      });
      for (const item of result.envelope.items) {
        items.push(
          typeof item === "object" && item
            ? {
              ...(item as Record<string, unknown>),
              forwarded_from: id,
              undo_status: result.undoStatus,
            }
            : item,
        );
      }
      Object.assign(failed, result.envelope.failed ?? {});
    } catch (err) {
      failed[id] = {
        type: "forbiddenToSend",
        description: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const envelope: Envelope<unknown> = { items };
  if (Object.keys(failed).length > 0) envelope.failed = failed;
  return envelope;
}

async function fetchEmailsForForward(
  ctx: OpContext,
  account: AccountRef,
  ids: Id[],
): Promise<Map<Id, Email>> {
  const res = await ctx.jmap.getChunked(ctx.actor, using(USING.mail), "Email/get", {
    accountId: account.accountId,
    ids,
    properties: [
      "id",
      "blobId",
      "from",
      "to",
      "subject",
      "sentAt",
      "preview",
      "textBody",
      "htmlBody",
      "bodyValues",
    ],
    fetchTextBodyValues: true,
    fetchHTMLBodyValues: true,
  });
  const map = new Map<Id, Email>();
  if (Array.isArray(res.list)) {
    for (const email of res.list as Email[]) map.set(email.id, email);
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// Op: draft.create / draft.update / draft.delete / draft.list
// ────────────────────────────────────────────────────────────────────────────

const draftListOp = defineOp({
  name: "draft.list",
  mcpName: "list_drafts",
  description:
    "List draft emails (messages with the $draft keyword) on the user's personal self-hosted mail " +
    "(Letterdog). Read-only; brief projection by default. On the MCP surface prefer search_emails " +
    'with query "is:draft"; this exists for the CLI.',
  input: {
    limit: LimitSchema,
    ...bodyReadArgs,
  },
  annotations: { readOnly: true, idempotent: true },
  confirmClass: "none",
  projection: "email",
  surfaces: ["cli"],
  handler: draftListHandler,
});

async function draftListHandler(
  args: { limit: number; account_id?: string; projection: ProjectionMode; fields?: string[] },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const mailboxes = await fetchMailboxIndex(ctx.jmap, ctx.actor, account);
  const query = await ctx.jmap.request(ctx.actor, using(USING.mail), [
    [
      "Email/query",
      {
        accountId: account.accountId,
        filter: { hasKeyword: "$draft" },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: args.limit,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId: account.accountId,
        "#ids": ref("q", "Email/query", "/ids"),
        properties: [
          "id",
          "threadId",
          "mailboxIds",
          "keywords",
          "from",
          "to",
          "cc",
          "subject",
          "receivedAt",
          "preview",
          "hasAttachment",
        ],
      },
      "g",
    ],
  ]);
  const getRes = expectResponse(query.methodResponses, "Email/get", "g");
  const emails = Array.isArray(getRes.list) ? getRes.list as Email[] : [];
  const ctxProj = projectionCtx(ctx, args.projection, args.fields, mailboxes);
  const items = emails.map((e) => project("email", e, args.projection, ctxProj));
  const envelope: Envelope<unknown> = { items };
  if (typeof getRes.state === "string") envelope.state = getRes.state;
  return envelope;
}

const draftCreateOp = defineOp({
  name: "draft.create",
  mcpName: "create_draft",
  description:
    "Create a draft email (stored in Drafts with the $draft keyword; NOT sent) on the user's " +
    "personal self-hosted mail (Letterdog). Same compose fields and attachment sources as " +
    "send_email. Returns the new draft's id; submit it later with send_email draft_id.",
  input: {
    from: AddressInputSchema.optional(),
    to: z.array(AddressInputSchema).optional(),
    cc: z.array(AddressInputSchema).optional(),
    bcc: z.array(AddressInputSchema).optional(),
    reply_to: z.array(AddressInputSchema).optional(),
    subject: z.string(),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    attachments: z.array(AttachmentArgSchema).optional(),
    identity_id: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    keywords: z.array(KeywordSchema).optional(),
    ...bodyReadArgs,
  },
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "none",
  projection: "email",
  surfaces: ["cli"],
  handler: draftCreateHandler,
});

async function draftCreateHandler(
  args: {
    from?: { name?: string; email: string };
    to?: { name?: string; email: string }[];
    cc?: { name?: string; email: string }[];
    bcc?: { name?: string; email: string }[];
    reply_to?: { name?: string; email: string }[];
    subject: string;
    body_text?: string;
    body_html?: string;
    attachments?: AttachmentArg[];
    identity_id?: string;
    headers?: Record<string, string>;
    keywords?: string[];
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  if (args.body_text === undefined && args.body_html === undefined) {
    throw new Error("draft requires body_text or body_html");
  }
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const [identities, mailboxes] = await Promise.all([
    fetchIdentities(ctx.jmap, ctx.actor, account),
    fetchMailboxIndex(ctx.jmap, ctx.actor, account),
  ]);
  const identity = pickIdentity(identities, {
    identityId: args.identity_id,
    fromEmail: args.from?.email,
  });
  const compose: ComposeEmailInput = {
    from: args.from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    reply_to: args.reply_to,
    subject: args.subject,
    body_text: args.body_text,
    body_html: args.body_html,
    identity_id: args.identity_id,
    headers: args.headers,
    keywords: args.keywords,
  };
  const create = buildCompose(compose, identity);
  const plan = await planMessageAttachments(ctx, account, args.attachments);
  return draftFromCreate(ctx, account, create, plan, mailboxes, args.projection, args.fields);
}

const draftUpdateOp = defineOp({
  name: "draft.update",
  mcpName: "update_draft",
  description:
    "Replace a draft email on the user's personal self-hosted mail (Letterdog). JMAP Email objects " +
    "are largely immutable, so this creates a new draft from the given fields and destroys the old " +
    "one — THE DRAFT ID CHANGES. The response echoes replaced_id (the destroyed old id) alongside " +
    "the new draft. Provide the full compose fields you want the replacement to have.",
  input: {
    draft_id: JmapIdSchema,
    from: AddressInputSchema.optional(),
    to: z.array(AddressInputSchema).optional(),
    cc: z.array(AddressInputSchema).optional(),
    bcc: z.array(AddressInputSchema).optional(),
    reply_to: z.array(AddressInputSchema).optional(),
    subject: z.string(),
    body_text: z.string().optional(),
    body_html: z.string().optional(),
    attachments: z.array(AttachmentArgSchema).optional(),
    identity_id: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    keywords: z.array(KeywordSchema).optional(),
    ...bodyReadArgs,
  },
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "none",
  projection: "email",
  surfaces: ["cli"],
  handler: draftUpdateHandler,
});

async function draftUpdateHandler(
  args: {
    draft_id: string;
    from?: { name?: string; email: string };
    to?: { name?: string; email: string }[];
    cc?: { name?: string; email: string }[];
    bcc?: { name?: string; email: string }[];
    reply_to?: { name?: string; email: string }[];
    subject: string;
    body_text?: string;
    body_html?: string;
    attachments?: AttachmentArg[];
    identity_id?: string;
    headers?: Record<string, string>;
    keywords?: string[];
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  if (args.body_text === undefined && args.body_html === undefined) {
    throw new Error("draft update requires body_text or body_html");
  }
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const [identities, mailboxes] = await Promise.all([
    fetchIdentities(ctx.jmap, ctx.actor, account),
    fetchMailboxIndex(ctx.jmap, ctx.actor, account),
  ]);
  const identity = pickIdentity(identities, {
    identityId: args.identity_id,
    fromEmail: args.from?.email,
  });
  const compose: ComposeEmailInput = {
    from: args.from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    reply_to: args.reply_to,
    subject: args.subject,
    body_text: args.body_text,
    body_html: args.body_html,
    identity_id: args.identity_id,
    headers: args.headers,
    keywords: args.keywords,
  };
  const create = buildCompose(compose, identity);
  const plan = await planMessageAttachments(ctx, account, args.attachments);
  const draftsId = mailboxes.byRole["drafts"];
  const withAtt = withInlineAttachments(create, plan);
  const created = draftMailbox(withAtt, draftsId);

  // Create the replacement and destroy the old in one /set (server processes create before destroy).
  const calls: MethodCall[] = [];
  if (plan.preCalls.length) calls.push(...plan.preCalls);
  calls.push([
    "Email/set",
    {
      accountId: account.accountId,
      create: { email: created },
      destroy: [args.draft_id],
    },
    "emailSet",
  ]);
  const result = await ctx.jmap.request(ctx.actor, using(USING.mailBlob), calls);
  const setRes = expectResponse(result.methodResponses, "Email/set", "emailSet");
  const outcome = setOutcome(setRes);

  const newCreated = outcome.created["email"];
  const newId = newCreated && typeof newCreated.id === "string" ? newCreated.id : undefined;

  const items: unknown[] = [];
  const ctxProj = projectionCtx(ctx, args.projection, args.fields, mailboxes);
  if (newId) {
    const brief = await fetchEmailBrief(ctx, account, newId, ctxProj, args.projection);
    items.push({
      ...(brief && typeof brief === "object" ? brief as Record<string, unknown> : { id: newId }),
      replaced_id: args.draft_id,
    });
  }
  const envelope: Envelope<unknown> = { items };
  if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
  return envelope;
}

const draftDeleteOp = defineOp({
  name: "draft.delete",
  mcpName: "delete_draft",
  description:
    "Delete draft email(s) on the user's personal self-hosted mail (Letterdog) by destroying them " +
    "outright (drafts are reversible-class — an unsent draft has no recall value). Batch-first: " +
    "pass draft_ids as an array; per-item failures surface in failed.",
  input: {
    draft_ids: z.array(JmapIdSchema).min(1).max(200),
    account_id: AccountIdSchema,
  },
  annotations: { readOnly: false, destructive: true, idempotent: true },
  confirmClass: "none",
  projection: "email",
  surfaces: ["cli"],
  handler: draftDeleteHandler,
});

async function draftDeleteHandler(
  args: { draft_ids: string[]; account_id?: string },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(ctx.actor, CAPABILITIES.mail, args.account_id);
  const res = await ctx.jmap.setChunked(ctx.actor, using(USING.mail), "Email/set", {
    accountId: account.accountId,
    destroy: args.draft_ids,
  });
  const outcome = setOutcome(res);
  const items = outcome.destroyed.map((id) => ({ id, destroyed: true }));
  const envelope: Envelope<unknown> = { items };
  if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
  return envelope;
}

/**
 * Persist a create payload as a draft in one Email/set (with inline Blob/upload preCalls) and
 * return a brief-projected envelope. Shared by reply(send:false), draft.create.
 */
async function draftFromCreate(
  ctx: OpContext,
  account: AccountRef,
  create: EmailCreatePayload,
  plan: AttachmentPlan,
  mailboxes: MailboxIndex,
  mode: ProjectionMode,
  fields: string[] | undefined,
): Promise<Envelope<unknown>> {
  const draftsId = mailboxes.byRole["drafts"];
  const withAtt = withInlineAttachments(create, plan);
  const payload = draftMailbox(withAtt, draftsId);

  const calls: MethodCall[] = [];
  if (plan.preCalls.length) calls.push(...plan.preCalls);
  calls.push([
    "Email/set",
    { accountId: account.accountId, create: { email: payload } },
    "emailSet",
  ]);
  const result = await ctx.jmap.request(ctx.actor, using(USING.mailBlob), calls);
  const setRes = expectResponse(result.methodResponses, "Email/set", "emailSet");
  const outcome = setOutcome(setRes);
  const created = outcome.created["email"];
  const newId = created && typeof created.id === "string" ? created.id : undefined;

  const items: unknown[] = [];
  if (newId) {
    const ctxProj = projectionCtx(ctx, mode, fields, mailboxes);
    const brief = await fetchEmailBrief(ctx, account, newId, ctxProj, mode);
    items.push(brief ?? { id: newId });
  }
  const envelope: Envelope<unknown> = { items };
  if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
  return envelope;
}

// ────────────────────────────────────────────────────────────────────────────
// Op: vacation.get / vacation.set
// ────────────────────────────────────────────────────────────────────────────

const vacationGetOp = defineOp({
  name: "vacation.get",
  mcpName: "get_vacation",
  description:
    "Read the vacation / out-of-office auto-reply (the account's VacationResponse singleton) on the " +
    "user's personal self-hosted mail (Letterdog): whether it's enabled, its active window " +
    "(from_date/to_date), and the subject/body. Read-only.",
  input: {
    account_id: AccountIdSchema,
  },
  annotations: { readOnly: true, idempotent: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  handler: vacationGetHandler,
});

async function vacationGetHandler(
  args: { account_id?: string },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.vacationResponse,
    args.account_id,
  );
  const res = await ctx.jmap.call(ctx.actor, using(USING.vacation), "VacationResponse/get", {
    accountId: account.accountId,
    ids: ["singleton"],
  });
  const list = Array.isArray(res.list) ? res.list as Record<string, unknown>[] : [];
  return { items: list } as Envelope<unknown>;
}

const vacationSetOp = defineOp({
  name: "vacation.set",
  mcpName: "set_vacation",
  description:
    "Enable, disable, or update the vacation / out-of-office auto-reply on the user's personal " +
    "self-hosted mail (Letterdog). Auto-replies go out to whoever writes you (RFC 3834), so this is " +
    "an outward action. Set enabled + optional from_date/to_date (UTCDateTime; null clears a " +
    "bound), subject, text_body/html_body. Under the balanced policy this returns a confirm_token " +
    "to repeat with; under minimal it applies directly.",
  input: {
    enabled: z.boolean(),
    from_date: z.string().nullable().optional(),
    to_date: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    text_body: z.string().nullable().optional(),
    html_body: z.string().nullable().optional(),
    confirm_token: ConfirmTokenSchema,
    account_id: AccountIdSchema,
  },
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "outward",
  projection: "raw",
  surfaces: ["cli"],
  handler: vacationSetHandler,
});

async function vacationSetHandler(
  args: {
    enabled: boolean;
    from_date?: string | null;
    to_date?: string | null;
    subject?: string | null;
    text_body?: string | null;
    html_body?: string | null;
    confirm_token?: string;
    account_id?: string;
  },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.vacationResponse,
    args.account_id,
  );

  const patch: Record<string, unknown> = { isEnabled: args.enabled };
  if (args.from_date !== undefined) patch.fromDate = args.from_date;
  if (args.to_date !== undefined) patch.toDate = args.to_date;
  if (args.subject !== undefined) patch.subject = args.subject;
  if (args.text_body !== undefined) patch.textBody = args.text_body;
  if (args.html_body !== undefined) patch.htmlBody = args.html_body;

  // recipientCount is unknown/unbounded for an auto-reply → treat as query-powered so balanced
  // policy two-phases it (auto-replies fan out to arbitrary senders).
  const gateResult = await gate(ctx, {
    op: "vacation.set",
    accountId: account.accountId,
    resourceIds: ["singleton"],
    payload: patch,
    queryPowered: true,
    confirmClass: "outward",
    confirmToken: args.confirm_token,
    summary: args.enabled ? "Enable out-of-office auto-reply" : "Disable out-of-office auto-reply",
  });
  if ("challenge" in gateResult) return gateResult.challenge;

  const res = await ctx.jmap.call(ctx.actor, using(USING.vacation), "VacationResponse/set", {
    accountId: account.accountId,
    update: { singleton: patch },
  });
  const outcome = setOutcome(res);
  const updated = outcome.updated["singleton"];
  const items: unknown[] = [{
    id: "singleton",
    is_enabled: args.enabled,
    ...(updated && typeof updated === "object" ? updated : {}),
  }];
  const envelope: Envelope<unknown> = { items };
  if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
  return envelope;
}

// ────────────────────────────────────────────────────────────────────────────
// Small helpers
// ────────────────────────────────────────────────────────────────────────────

/** Attach the top-level undo_status onto a send envelope for the single-message ops. */
function withUndoStatus(result: SendResult): Envelope<unknown> {
  const envelope = result.envelope;
  const enriched = { ...envelope } as Envelope<unknown> & {
    undo_status?: string;
    submission_id?: Id;
  };
  if (result.undoStatus) enriched.undo_status = result.undoStatus;
  if (result.submissionId) enriched.submission_id = result.submissionId;
  return enriched;
}

function firstAddressEmail(
  list: { email: string }[] | null | undefined,
): string | undefined {
  return list && list.length ? list[0].email : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────────────────────

export const ops: OpDefinition[] = [
  replyOp,
  sendOp,
  cancelSendOp,
  forwardOp,
  draftListOp,
  draftCreateOp,
  draftUpdateOp,
  draftDeleteOp,
  vacationGetOp,
  vacationSetOp,
];
