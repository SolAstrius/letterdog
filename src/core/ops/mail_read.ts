/**
 * mail read ops — builder: ops:mail-read.
 *
 * Ops implemented (see docs/v2-contracts.md §ops inventory). All read-only, confirmClass none,
 * projection-routed, batch-first:
 * - mail.search      → search_emails     [mcp, cli]  projection: email
 *   Gmail-syntax `query` (core/query.ts) AND/OR typed RFC 8621 filter (all 18 conditions);
 *   `ids_only`, `collapse_threads`, `include_snippets` (SearchSnippet/get in the same request).
 * - mail.read        → read_emails       [mcp, cli]  projection: email
 *   ids array; `include_body` (fetchAllBodyValues + maxBodyValueBytes), body_as text|markdown|html
 *   via projections.htmlToText, include_raw.
 * - mail.thread      → read_thread       [mcp, cli]  projection: email
 *   email_id | thread_ids via the canonical back-ref chain in ONE request.
 * - attachment.read  → read_attachment   [mcp, cli]  projection: blob
 *   part-membership verified; mode url (DEFAULT, authed download URL + curl hint) | content;
 *   parse:true → Email/parse for attached .eml.
 * - attachment.save  → save_attachment   [cli]  projection: blob
 *   membership-verified blob(s) written to disk (out_path file or directory; omit blob/part id to
 *   save every attachment).
 * - mail.export      → export_emails     [cli]  projection: raw
 *   raw RFC822 .eml files written to out_dir (one per id; bytes never enter model context).
 * - mail.import      → import_emails     [cli]  projection: email
 *   local .eml files → Blob upload → Email/import into a mailbox (name/role/id resolved).
 */
import { z } from "zod";
import { defineOp, type OpContext, type OpDefinition } from "./registry.ts";
import {
  AccountIdSchema,
  FieldsSchema,
  IdsSchema,
  JmapIdSchema,
  LimitSchema,
  ProjectionSchema,
  UtcDateTimeSchema,
} from "../schemas/common.ts";
import { EmailComparatorSchema, EmailFilterSchema, KeywordSchema } from "../schemas/mail.ts";
import type { EmailComparator, EmailFilter, EmailFilterCondition } from "../schemas/mail.ts";
import { CAPABILITIES, USING } from "../jmap/session.ts";
import { ref } from "../jmap/client.ts";
import { envelopeFromGet, envelopeFromQuery, expectResponse } from "../jmap/envelopes.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { MAILBOX_REF_PREFIX, mergeFilters, translateGmailQuery } from "../query.ts";
import { projectEmail } from "../projections.ts";
import type { ProjectionContext, ProjectionMode } from "../projections.ts";
import { htmlToText } from "../projections.ts";
import type { Email, EmailBodyPart, Mailbox } from "../jmap/types.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Mutable copy of the mail `using` set (client signatures take string[], USING.* are readonly). */
const MAIL_USING: string[] = [...USING.mail];

/** Email/get default-ish "fast" property set — enough for the brief projection, no body sinks. */
const BRIEF_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "from",
  "to",
  "cc",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
];

/** Body-part properties needed to locate attachments and inline parts. */
const ATTACHMENT_BODY_PROPERTIES = [
  "partId",
  "blobId",
  "size",
  "name",
  "type",
  "charset",
  "disposition",
  "cid",
  "location",
];

/**
 * Fetch the account's mailboxes once and build the id → {name, role} map the email projector needs
 * to resolve mailboxIds into ["inbox", …]. Also returns a role → id map for mailbox-ref resolution.
 */
async function loadMailboxes(
  ctx: OpContext,
  accountId: string,
): Promise<{
  byId: Map<string, { name: string; role?: string | null }>;
  byNameOrRole: Map<string, string>;
}> {
  const res = await ctx.jmap.call(ctx.actor, MAIL_USING, "Mailbox/get", {
    accountId,
    ids: null,
    properties: ["id", "name", "role", "parentId"],
  });
  const list = Array.isArray(res.list) ? res.list as Mailbox[] : [];
  const byId = new Map<string, { name: string; role?: string | null }>();
  const byNameOrRole = new Map<string, string>();
  for (const mb of list) {
    byId.set(mb.id, { name: mb.name, role: mb.role ?? null });
    if (mb.role) byNameOrRole.set(String(mb.role).toLowerCase(), mb.id);
    if (mb.name) byNameOrRole.set(mb.name.toLowerCase(), mb.id);
  }
  return { byId, byNameOrRole };
}

/**
 * Rewrite mailbox-ref sentinels (`{inMailbox: "name:<ref>"}`, from query.ts in:/label: tokens) to
 * real mailbox ids. An unresolved ref becomes a condition that matches nothing (documented: an
 * unknown mailbox name yields zero results rather than silently dropping the constraint).
 */
function resolveMailboxRefs(
  filter: EmailFilter | null,
  byNameOrRole: Map<string, string>,
): EmailFilter | null {
  if (filter === null) return null;
  if ("operator" in filter) {
    return {
      operator: filter.operator,
      conditions: filter.conditions
        .map((c) => resolveMailboxRefs(c, byNameOrRole))
        .filter((c): c is EmailFilter => c !== null),
    };
  }
  const c = filter as EmailFilterCondition;
  if (typeof c.inMailbox === "string" && c.inMailbox.startsWith(MAILBOX_REF_PREFIX)) {
    const refName = c.inMailbox.slice(MAILBOX_REF_PREFIX.length);
    const id = byNameOrRole.get(refName);
    // Unknown mailbox → a sentinel id that resolves to no messages (never matches a real id).
    return { ...c, inMailbox: id ?? "\u0000no-such-mailbox" };
  }
  if (Array.isArray(c.inMailboxOtherThan)) {
    const mapped = c.inMailboxOtherThan.map((v) =>
      typeof v === "string" && v.startsWith(MAILBOX_REF_PREFIX)
        ? byNameOrRole.get(v.slice(MAILBOX_REF_PREFIX.length)) ?? "\u0000no-such-mailbox"
        : v
    );
    return { ...c, inMailboxOtherThan: mapped };
  }
  return c;
}

/** UTF-8-safe truncation cap shared by include_body. 0/undefined ⇒ no cap. */
function bodyMaxBytesArg(maxBodyBytes: number | undefined): number {
  return typeof maxBodyBytes === "number" && maxBodyBytes > 0 ? maxBodyBytes : 0;
}

// ---------------------------------------------------------------------------
// mail.search → search_emails
// ---------------------------------------------------------------------------

const searchInput = {
  account_id: AccountIdSchema,
  /** Gmail-syntax query (from:/to:/subject:/in:/is:/has:/before:/after:/larger:/smaller:/…). */
  query: z.string().optional(),
  /** Typed RFC 8621 filter (all 18 conditions), AND-merged with the Gmail query. */
  filter: EmailFilterSchema.optional(),
  sort: z.array(EmailComparatorSchema).optional(),
  collapse_threads: z.boolean().optional(),
  ids_only: z.boolean().optional(),
  include_snippets: z.boolean().optional(),
  limit: LimitSchema,
  position: z.number().int().nonnegative().optional(),
  calculate_total: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

async function searchHandler(
  args: {
    account_id?: string;
    query?: string;
    filter?: EmailFilter;
    sort?: EmailComparator[];
    collapse_threads?: boolean;
    ids_only?: boolean;
    include_snippets?: boolean;
    limit: number;
    position?: number;
    calculate_total?: boolean;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const { byId: mailboxById, byNameOrRole } = await loadMailboxes(ctx, accountId);

  const gmail = args.query ? translateGmailQuery(args.query) : null;
  const gmailFilter = gmail ? resolveMailboxRefs(gmail.filter, byNameOrRole) : null;
  const filter = mergeFilters(gmailFilter, args.filter ?? null);

  const queryArgs: Record<string, unknown> = {
    accountId,
    ...(filter ? { filter } : {}),
    sort: args.sort ?? [{ property: "receivedAt", isAscending: false }],
    collapseThreads: args.collapse_threads ?? false,
    limit: args.limit,
    ...(args.position ? { position: args.position } : {}),
    calculateTotal: args.calculate_total ?? false,
  };

  // ids_only: a bare Email/query round-trip, no /get.
  if (args.ids_only) {
    const res = await ctx.jmap.call(ctx.actor, MAIL_USING, "Email/query", queryArgs);
    const envelope = envelopeFromQuery(res);
    const out: Envelope<string> & { position?: number; unsupported?: string[] } = envelope;
    if (gmail && gmail.unsupported.length) out.unsupported = gmail.unsupported;
    return out;
  }

  // query → get(#ids), plus optional SearchSnippet/get in the SAME request.
  const calls: Array<[string, Record<string, unknown>, string]> = [
    ["Email/query", queryArgs, "q"],
    [
      "Email/get",
      {
        accountId,
        "#ids": ref("q", "Email/query", "/ids"),
        properties: BRIEF_PROPERTIES,
      },
      "g",
    ],
  ];
  if (args.include_snippets) {
    calls.push([
      "SearchSnippet/get",
      {
        accountId,
        ...(filter ? { filter } : {}),
        "#emailIds": ref("q", "Email/query", "/ids"),
      },
      "s",
    ]);
  }

  const result = await ctx.jmap.request(ctx.actor, MAIL_USING, calls);
  const responses = result.methodResponses;
  const queryRes = expectResponse(responses, "Email/query", "q");
  const getRes = expectResponse(responses, "Email/get", "g");

  const emails = Array.isArray(getRes.list) ? getRes.list as Email[] : [];
  const ctxProj: ProjectionContext = { mailboxes: mailboxById, fields: args.fields };

  // Snippets keyed by emailId for a cheap join onto brief items.
  const snippets = new Map<string, { subject?: string | null; preview?: string | null }>();
  if (args.include_snippets) {
    const snapRes = responses.find((r) => r[2] === "s");
    if (snapRes && snapRes[0] !== "error" && Array.isArray(snapRes[1].list)) {
      for (const sn of snapRes[1].list as Array<Record<string, unknown>>) {
        snippets.set(String(sn.emailId), {
          subject: sn.subject as string | null,
          preview: sn.preview as string | null,
        });
      }
    }
  }

  // Preserve Email/query id order (Email/get does not guarantee ordering).
  const queryIds = Array.isArray(queryRes.ids) ? queryRes.ids as string[] : [];
  const byId = new Map(emails.map((e) => [e.id, e]));
  const ordered = queryIds.map((id) => byId.get(id)).filter((e): e is Email => e !== undefined);

  const items = ordered.map((email) => {
    const projected = projectEmail(email, args.projection, ctxProj) as Record<string, unknown>;
    if (args.include_snippets) {
      const sn = snippets.get(email.id);
      if (sn) projected.snippet = sn;
    }
    return projected;
  });

  const envelope: Envelope<Record<string, unknown>> & {
    position?: number;
    unsupported?: string[];
  } = { items };
  if (typeof queryRes.total === "number") envelope.total = queryRes.total;
  if (typeof queryRes.queryState === "string") envelope.state = queryRes.queryState;
  if (typeof queryRes.position === "number") envelope.position = queryRes.position;
  if (gmail && gmail.unsupported.length) envelope.unsupported = gmail.unsupported;
  return envelope;
}

// ---------------------------------------------------------------------------
// mail.read → read_emails
// ---------------------------------------------------------------------------

const readInput = {
  account_id: AccountIdSchema,
  ids: IdsSchema,
  include_body: z.boolean().optional(),
  body_as: z.enum(["text", "markdown", "html"]).default("text"),
  max_body_bytes: z.number().int().positive().optional(),
  include_raw: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

/** Pick the best body value for an email given the requested representation. */
function extractBody(
  email: Email,
  bodyAs: "text" | "markdown" | "html",
): string | undefined {
  const values = email.bodyValues;
  if (!values) return undefined;

  const partsFor = (parts: EmailBodyPart[] | undefined): string | undefined => {
    if (!parts) return undefined;
    const chunks: string[] = [];
    for (const part of parts) {
      if (part.partId && values[part.partId]) chunks.push(values[part.partId].value);
    }
    return chunks.length ? chunks.join("\n") : undefined;
  };

  if (bodyAs === "html") {
    // Prefer the html body verbatim; fall back to text wrapped as-is.
    return partsFor(email.htmlBody) ?? partsFor(email.textBody);
  }

  // text | markdown: prefer plain text; else convert html server-side (cuts bodies 5–20×).
  const text = partsFor(email.textBody);
  if (text) return text;
  const html = partsFor(email.htmlBody);
  if (html) return htmlToText(html);
  return undefined;
}

async function readHandler(
  args: {
    account_id?: string;
    ids: string[];
    include_body?: boolean;
    body_as: "text" | "markdown" | "html";
    max_body_bytes?: number;
    include_raw?: boolean;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const { byId: mailboxById } = await loadMailboxes(ctx, accountId);

  const wantBody = args.include_body ?? false;
  const properties = args.projection === "raw"
    ? undefined // null/omitted ⇒ server default property set (full spec shape).
    : wantBody
    ? [...BRIEF_PROPERTIES, "bodyValues", "textBody", "htmlBody", "attachments"]
    : args.include_raw
    ? [...BRIEF_PROPERTIES, "blobId"]
    : BRIEF_PROPERTIES;

  const res = await ctx.jmap.getChunked(ctx.actor, MAIL_USING, "Email/get", {
    accountId,
    ids: args.ids,
    ...(properties ? { properties } : {}),
    ...(wantBody
      ? { fetchAllBodyValues: true, maxBodyValueBytes: bodyMaxBytesArg(args.max_body_bytes) }
      : {}),
  });

  const envelope = envelopeFromGet<Email>(res);
  const ctxProj: ProjectionContext = { mailboxes: mailboxById, fields: args.fields };

  const items = envelope.items.map((email) => {
    const projected = projectEmail(email, args.projection, ctxProj) as Record<string, unknown>;
    if (wantBody) {
      const body = extractBody(email, args.body_as);
      if (body !== undefined) {
        projected.body = body;
        projected.body_as = args.body_as;
      }
    }
    return projected;
  });

  // include_raw: attach an authenticated download URL for the full RFC822 blob per email.
  if (args.include_raw) {
    const session = await ctx.jmap.session(ctx.actor);
    for (let i = 0; i < items.length; i++) {
      const email = envelope.items[i];
      if (email?.blobId) {
        items[i].raw_download_url = ctx.jmap.downloadUrlFor(
          session,
          accountId,
          email.blobId,
          `${email.id}.eml`,
          "message/rfc822",
        );
      }
    }
  }

  const out: Envelope<Record<string, unknown>> = { items };
  if (envelope.not_found) out.not_found = envelope.not_found;
  if (envelope.state) out.state = envelope.state;
  return out;
}

// ---------------------------------------------------------------------------
// mail.thread → read_thread
// ---------------------------------------------------------------------------

const threadInput = {
  account_id: AccountIdSchema,
  /** Resolve the thread from a single email id (its threadId is looked up). */
  email_id: JmapIdSchema.optional(),
  /** …or read one or more threads directly by thread id. */
  thread_ids: z.array(JmapIdSchema).min(1).max(100).optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

async function threadHandler(
  args: {
    account_id?: string;
    email_id?: string;
    thread_ids?: string[];
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  if (!args.email_id && (!args.thread_ids || args.thread_ids.length === 0)) {
    throw new Error("read_thread requires email_id or thread_ids");
  }
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const { byId: mailboxById } = await loadMailboxes(ctx, accountId);

  // Canonical back-ref chain (rfc-notes 8620 §1.3), all in ONE request:
  //   [from email_id] Email/get(threadId) → Thread/get(#/list/*/threadId)
  //                   → Email/get(#/list/*/emailIds)
  //   [from thread_ids] Thread/get(ids) → Email/get(#/list/*/emailIds)
  const calls: Array<[string, Record<string, unknown>, string]> = [];
  if (args.email_id) {
    calls.push([
      "Email/get",
      { accountId, ids: [args.email_id], properties: ["id", "threadId"] },
      "e0",
    ]);
    calls.push([
      "Thread/get",
      { accountId, "#ids": ref("e0", "Email/get", "/list/*/threadId") },
      "t",
    ]);
  } else {
    calls.push(["Thread/get", { accountId, ids: args.thread_ids }, "t"]);
  }
  calls.push([
    "Email/get",
    {
      accountId,
      "#ids": ref("t", "Thread/get", "/list/*/emailIds"),
      properties: BRIEF_PROPERTIES,
    },
    "g",
  ]);

  const result = await ctx.jmap.request(ctx.actor, MAIL_USING, calls);
  const responses = result.methodResponses;
  const threadRes = expectResponse(responses, "Thread/get", "t");
  const getRes = expectResponse(responses, "Email/get", "g");

  const emails = Array.isArray(getRes.list) ? getRes.list as Email[] : [];
  const ctxProj: ProjectionContext = { mailboxes: mailboxById, fields: args.fields };
  const byId = new Map(emails.map((e) => [e.id, e]));

  // Group emails by thread, in the thread's canonical emailIds order (receivedAt ascending).
  const threads = Array.isArray(threadRes.list)
    ? threadRes.list as Array<{ id: string; emailIds: string[] }>
    : [];
  const items = threads.map((thread) => ({
    thread_id: thread.id,
    emails: (thread.emailIds ?? [])
      .map((id) => byId.get(id))
      .filter((e): e is Email => e !== undefined)
      .map((email) => projectEmail(email, args.projection, ctxProj)),
  }));

  const out: Envelope<unknown> = { items };
  if (typeof getRes.state === "string") out.state = getRes.state;
  const notFound = threadRes.notFound;
  if (Array.isArray(notFound) && notFound.length) out.not_found = notFound as string[];
  return out;
}

// ---------------------------------------------------------------------------
// attachment.read → read_attachment
// ---------------------------------------------------------------------------

const attachmentInput = {
  account_id: AccountIdSchema,
  /** The email the attachment belongs to (membership is verified). */
  email_id: JmapIdSchema,
  /** The blobId of the attachment part (from read_emails attachments[]). */
  blob_id: JmapIdSchema.optional(),
  /** Or reference the attachment by its partId within the email. */
  part_id: z.string().min(1).optional(),
  /** url (default): authenticated download URL + curl one-liner. content: inline (small parts). */
  mode: z.enum(["url", "content"]).default("url"),
  /** parse:true → run Email/parse on an attached message/rfc822 blob, returning its brief Email. */
  parse: z.boolean().optional(),
  /** Cap for content mode (bytes). Guards against inlining large attachments. */
  max_bytes: z.number().int().positive().optional(),
};

/** Walk an email's body-part tree collecting attachment-ish parts (blobId-bearing leaves). */
function collectParts(email: Email): EmailBodyPart[] {
  const out: EmailBodyPart[] = [];
  const visit = (parts: EmailBodyPart[] | null | undefined) => {
    if (!parts) return;
    for (const p of parts) {
      if (p.blobId) out.push(p);
      if (p.subParts) visit(p.subParts);
    }
  };
  visit(email.attachments);
  if (email.bodyStructure) visit([email.bodyStructure]);
  return out;
}

/**
 * Fetch the owning email's attachment/body-part metadata to VERIFY membership before exposing
 * any blob — a caller cannot pull an arbitrary blob by claiming it belongs to an email they own.
 */
async function loadEmailParts(
  ctx: OpContext,
  accountId: string,
  emailId: string,
): Promise<{ email: Email; parts: EmailBodyPart[] }> {
  const res = await ctx.jmap.call(ctx.actor, MAIL_USING, "Email/get", {
    accountId,
    ids: [emailId],
    properties: ["id", "attachments", "bodyStructure"],
    bodyProperties: ATTACHMENT_BODY_PROPERTIES,
    fetchAllBodyValues: false,
  });
  const email = Array.isArray(res.list) ? (res.list as Email[])[0] : undefined;
  if (!email) throw new Error(`Email ${emailId} not found`);
  return { email, parts: collectParts(email) };
}

async function attachmentHandler(
  args: {
    account_id?: string;
    email_id: string;
    blob_id?: string;
    part_id?: string;
    mode: "url" | "content";
    parse?: boolean;
    max_bytes?: number;
  },
  ctx: OpContext,
): Promise<unknown> {
  if (!args.blob_id && !args.part_id) {
    throw new Error("read_attachment requires blob_id or part_id");
  }
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );

  const { parts } = await loadEmailParts(ctx, accountId, args.email_id);
  const part = args.blob_id
    ? parts.find((p) => p.blobId === args.blob_id)
    : parts.find((p) => p.partId === args.part_id);
  if (!part || !part.blobId) {
    throw new Error(
      `Attachment ${args.blob_id ?? args.part_id} does not belong to email ${args.email_id}`,
    );
  }
  const blobId = part.blobId;
  const name = part.name ?? `${args.email_id}-${blobId}`;
  const type = part.type ?? "application/octet-stream";

  // parse:true — treat the blob as an embedded message and parse it (attached .eml).
  if (args.parse) {
    const parseRes = await ctx.jmap.call(ctx.actor, MAIL_USING, "Email/parse", {
      accountId,
      blobIds: [blobId],
      properties: BRIEF_PROPERTIES.filter((p) =>
        !["id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt"].includes(p)
      ),
    });
    const parsed = (parseRes.parsed as Record<string, Email> | null | undefined)?.[blobId];
    if (!parsed) {
      const notParsable = Array.isArray(parseRes.notParsable) ? parseRes.notParsable : [];
      throw new Error(
        `Blob ${blobId} is not a parsable message${notParsable.length ? ` (notParsable)` : ""}`,
      );
    }
    return {
      items: [{
        email_id: args.email_id,
        blob_id: blobId,
        name,
        type,
        parsed: projectEmail(parsed, "brief", {}),
      }],
    };
  }

  const session = await ctx.jmap.session(ctx.actor);
  const downloadUrl = ctx.jmap.downloadUrlFor(session, accountId, blobId, name, type);

  if (args.mode === "content") {
    const bytes = await ctx.jmap.downloadBlob(ctx.actor, accountId, blobId, name, type);
    if (args.max_bytes && bytes.length > args.max_bytes) {
      throw new Error(
        `Attachment ${blobId} is ${bytes.length} bytes (> max_bytes ${args.max_bytes}); ` +
          `use mode:"url" to download it directly.`,
      );
    }
    const base64 = base64Encode(bytes);
    return {
      items: [{
        email_id: args.email_id,
        blob_id: blobId,
        name,
        type,
        size: bytes.length,
        content_base64: base64,
      }],
    };
  }

  // url mode (default): the authenticated download URL + a curl one-liner for local save. The
  // bearer is NOT embedded — the caller supplies it (never log/echo the token here).
  return {
    items: [{
      email_id: args.email_id,
      blob_id: blobId,
      name,
      type,
      size: part.size,
      download_url: downloadUrl,
      curl: `curl -H "Authorization: Bearer $STALWART_BEARER" -o ${shellQuote(name)} ${
        shellQuote(downloadUrl)
      }`,
    }],
  };
}

/** Base64-encode bytes without pulling a dep (btoa over a binary string, chunked). */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Minimal single-quote shell escaping for the curl hint. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// attachment.save → save_attachment (CLI-only)
// ---------------------------------------------------------------------------

const attachmentSaveInput = {
  account_id: AccountIdSchema,
  /** The email the attachment belongs to (membership is verified). */
  email_id: JmapIdSchema.describe("Email the attachment belongs to (membership verified)."),
  /** Target a single attachment by blobId; omit blob_id AND part_id to save ALL attachments. */
  blob_id: JmapIdSchema.optional().describe("Attachment blobId (from read_emails attachments[])."),
  /** …or target it by partId. */
  part_id: z.string().min(1).optional().describe("Attachment partId within the email."),
  /** Destination: a file path (single attachment) or an existing directory. */
  out_path: z.string().min(1).describe(
    "Where to write: a file path (single attachment) or an existing directory " +
      "(required when saving multiple; files named after the attachments).",
  ),
};

/** Strip path separators / control chars so a hostile attachment name cannot escape out_path. */
function safeFileName(name: string, fallback: string): string {
  // deno-lint-ignore no-control-regex
  const cleaned = name.replaceAll(/[/\\\u0000-\u001f]/g, "_").replace(/^\.+/, "_").trim();
  return cleaned || fallback;
}

async function attachmentSaveHandler(
  args: {
    account_id?: string;
    email_id: string;
    blob_id?: string;
    part_id?: string;
    out_path: string;
  },
  ctx: OpContext,
): Promise<unknown> {
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const { email, parts } = await loadEmailParts(ctx, accountId, args.email_id);

  let targets: EmailBodyPart[];
  if (args.blob_id || args.part_id) {
    const part = args.blob_id
      ? parts.find((p) => p.blobId === args.blob_id)
      : parts.find((p) => p.partId === args.part_id);
    if (!part || !part.blobId) {
      throw new Error(
        `Attachment ${args.blob_id ?? args.part_id} does not belong to email ${args.email_id}`,
      );
    }
    targets = [part];
  } else {
    // No specific part → every attachment (the email's `attachments` list, blobId leaves only).
    const seen = new Set<string>();
    targets = (email.attachments ?? []).filter((p) => {
      if (!p.blobId || seen.has(p.blobId)) return false;
      seen.add(p.blobId);
      return true;
    });
    if (targets.length === 0) throw new Error(`Email ${args.email_id} has no attachments`);
  }

  const stat = await Deno.stat(args.out_path).catch(() => null);
  const isDir = stat?.isDirectory ?? false;
  if (targets.length > 1 && !isDir) {
    throw new Error(
      `out_path must be an existing directory when saving ${targets.length} attachments`,
    );
  }

  const items: Array<Record<string, unknown>> = [];
  const failed: Record<string, { type: string; description: string }> = {};
  for (const part of targets) {
    const blobId = part.blobId as string;
    const name = safeFileName(part.name ?? "", `${args.email_id}-${blobId}`);
    const type = part.type ?? "application/octet-stream";
    const filePath = isDir ? `${args.out_path.replace(/\/+$/, "")}/${name}` : args.out_path;
    try {
      const bytes = await ctx.jmap.downloadBlob(ctx.actor, accountId, blobId, name, type);
      await Deno.writeFile(filePath, bytes);
      items.push({
        email_id: args.email_id,
        blob_id: blobId,
        name,
        type,
        size: bytes.length,
        file_path: filePath,
      });
    } catch (error) {
      failed[blobId] = {
        type: "downloadFailed",
        description: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const out: Envelope<Record<string, unknown>> = { items };
  if (Object.keys(failed).length) out.failed = failed;
  return out;
}

// ---------------------------------------------------------------------------
// mail.export → export_emails (CLI-only)
// ---------------------------------------------------------------------------

const exportInput = {
  account_id: AccountIdSchema,
  ids: IdsSchema,
  /** Directory to write the raw .eml files into (one `<id>.eml` per email). */
  out_dir: z.string().min(1).default(".").describe(
    "Existing directory for the exported .eml files (one <id>.eml per email).",
  ),
};

async function exportHandler(
  args: { account_id?: string; ids: string[]; out_dir: string },
  ctx: OpContext,
): Promise<unknown> {
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const stat = await Deno.stat(args.out_dir).catch(() => null);
  if (!stat?.isDirectory) throw new Error(`out_dir is not an existing directory: ${args.out_dir}`);

  const res = await ctx.jmap.getChunked(ctx.actor, MAIL_USING, "Email/get", {
    accountId,
    ids: args.ids,
    properties: ["id", "blobId", "subject", "receivedAt"],
  });
  const envelope = envelopeFromGet<Email>(res);

  const dir = args.out_dir.replace(/\/+$/, "");
  const items: Array<Record<string, unknown>> = [];
  const failed: Record<string, { type: string; description: string }> = {};
  for (const email of envelope.items) {
    const filePath = `${dir}/${safeFileName(email.id, "email")}.eml`;
    try {
      if (!email.blobId) throw new Error("email has no blobId");
      const bytes = await ctx.jmap.downloadBlob(
        ctx.actor,
        accountId,
        email.blobId,
        `${email.id}.eml`,
        "message/rfc822",
      );
      await Deno.writeFile(filePath, bytes);
      items.push({
        id: email.id,
        subject: email.subject ?? null,
        received_at: email.receivedAt ?? null,
        size: bytes.length,
        file_path: filePath,
      });
    } catch (error) {
      failed[email.id] = {
        type: "downloadFailed",
        description: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const out: Envelope<Record<string, unknown>> = { items };
  if (envelope.not_found) out.not_found = envelope.not_found;
  if (Object.keys(failed).length) out.failed = failed;
  return out;
}

// ---------------------------------------------------------------------------
// mail.import → import_emails (CLI-only)
// ---------------------------------------------------------------------------

const importInput = {
  account_id: AccountIdSchema,
  /** Local RFC822 (.eml) files to import. */
  file_paths: z.array(z.string().min(1)).min(1).max(500).describe(
    "Local .eml (RFC822) files to import, one email per file.",
  ),
  /** Target mailbox: role (inbox/archive/…), name, or mailbox id. */
  mailbox: z.string().min(1).default("inbox").describe(
    "Target mailbox: role (inbox, archive, …), name, or mailbox id.",
  ),
  /** Keywords set on the imported emails. Defaults to $seen (imported mail is not "new"). */
  keywords: z.array(KeywordSchema).default(["$seen"]).describe(
    'Keywords for the imported emails (default ["$seen"]).',
  ),
  /** Override receivedAt (UTCDate) for ALL imported emails; server default = now. */
  received_at: UtcDateTimeSchema.optional().describe(
    "receivedAt override (UTCDate) applied to every imported email; omit for server time.",
  ),
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

async function importHandler(
  args: {
    account_id?: string;
    file_paths: string[];
    mailbox: string;
    keywords: string[];
    received_at?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const { byId: mailboxById, byNameOrRole } = await loadMailboxes(ctx, accountId);
  const mailboxId = byNameOrRole.get(args.mailbox.toLowerCase()) ??
    (mailboxById.has(args.mailbox) ? args.mailbox : undefined);
  if (!mailboxId) throw new Error(`Unknown mailbox: ${args.mailbox}`);

  const keywords: Record<string, true> = {};
  for (const kw of args.keywords) keywords[kw] = true;

  // Upload each file's bytes, then a single Email/import for all successfully uploaded blobs.
  const failed: Record<string, { type: string; description: string }> = {};
  const emailsByCreationId: Record<string, Record<string, unknown>> = {};
  const pathByCreationId = new Map<string, string>();
  let n = 0;
  for (const filePath of args.file_paths) {
    try {
      const bytes = await Deno.readFile(filePath);
      const uploaded = await ctx.jmap.uploadBlob(ctx.actor, accountId, bytes, "message/rfc822");
      const creationId = `i${n++}`;
      pathByCreationId.set(creationId, filePath);
      emailsByCreationId[creationId] = {
        blobId: uploaded.blobId,
        mailboxIds: { [mailboxId]: true },
        keywords,
        ...(args.received_at ? { receivedAt: args.received_at } : {}),
      };
    } catch (error) {
      failed[filePath] = {
        type: "uploadFailed",
        description: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const items: unknown[] = [];
  if (Object.keys(emailsByCreationId).length > 0) {
    const res = await ctx.jmap.call(ctx.actor, MAIL_USING, "Email/import", {
      accountId,
      emails: emailsByCreationId,
    });
    const created = (res.created ?? {}) as Record<string, Email>;
    const notCreated = (res.notCreated ?? {}) as Record<
      string,
      { type?: string; description?: string | null }
    >;
    const ctxProj: ProjectionContext = { mailboxes: mailboxById, fields: args.fields };
    for (const [creationId, filePath] of pathByCreationId) {
      if (created[creationId]) {
        const projected = projectEmail(created[creationId], args.projection, ctxProj) as Record<
          string,
          unknown
        >;
        projected.file_path = filePath;
        items.push(projected);
      } else {
        const err = notCreated[creationId];
        failed[filePath] = {
          type: err?.type ?? "importFailed",
          description: err?.description ?? "Email/import did not create this email",
        };
      }
    }
  }

  const out: Envelope<unknown> = { items };
  if (Object.keys(failed).length) out.failed = failed;
  return out;
}

// ---------------------------------------------------------------------------
// Op definitions
// ---------------------------------------------------------------------------

export const ops: OpDefinition[] = [
  defineOp({
    name: "mail.search",
    mcpName: "search_emails",
    description:
      "Search the user's personal self-hosted mailbox (JMAP). Accepts a Gmail-syntax `query` " +
      "(from:/to:/cc:/bcc:/subject:/body:/in:/label:/is:unread|flagged|draft|…/has:attachment/" +
      'before:/after:/larger:/smaller:/header:; quoted "phrases" match as a phrase, bare words ' +
      "are all-required tokens, a leading - negates) AND/OR a typed RFC 8621 `filter` (all 18 " +
      "conditions), AND-merged. TRAP: before:/after: filter on receivedAt (server arrival time), " +
      "NOT the Date: header — after: is inclusive, before: is exclusive. `collapse_threads` keeps " +
      "one email per thread; `ids_only` returns just ids (accumulate then act via read_emails/" +
      "organize_emails); `include_snippets` adds <mark>-highlighted match snippets. `limit` " +
      "defaults 25; `calculate_total` is opt-in. read-only.",
    input: searchInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "email",
    surfaces: ["mcp", "cli"],
    handler: searchHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "mail.read",
    mcpName: "read_emails",
    description:
      "Read one or more emails by id (batch-first: pass an ids array). By default returns brief " +
      "metadata only. `include_body` fetches the body (bounded by `max_body_bytes` → UTF-8-safe " +
      "maxBodyValueBytes); `body_as` picks text (default), markdown, or html — html is converted " +
      "to text server-side, cutting tokens 5–20×. `include_raw` adds an authenticated download " +
      'URL for the full RFC822 message. Use projection:"raw" for the untouched spec shape. ' +
      "read-only.",
    input: readInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "email",
    surfaces: ["mcp", "cli"],
    handler: readHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "mail.thread",
    mcpName: "read_thread",
    description:
      "Read the full conversation for a message. Pass `email_id` (its thread is resolved) or " +
      "`thread_ids` directly. Returns each thread's emails brief-projected in canonical order " +
      "(oldest first). Resolves the whole thread in ONE server round-trip. Use before replying " +
      "so the reply lands in-thread with correct quoting context. read-only.",
    input: threadInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "email",
    surfaces: ["mcp", "cli"],
    handler: threadHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "attachment.read",
    mcpName: "read_attachment",
    description:
      "Read an email attachment. Identify it by `email_id` + `blob_id` (from read_emails " +
      "attachments[]) or `email_id` + `part_id`; membership is verified so you cannot pull an " +
      'arbitrary blob. `mode:"url"` (DEFAULT) returns an authenticated download URL plus a curl ' +
      'one-liner — the local-save path, bytes never enter the model context. `mode:"content"` ' +
      "inlines the bytes as base64 (guard with `max_bytes`). `parse:true` runs Email/parse on an " +
      "attached message/rfc822 (.eml) and returns its brief Email. read-only.",
    input: attachmentInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "blob",
    surfaces: ["mcp", "cli"],
    handler: attachmentHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "attachment.save",
    mcpName: "save_attachment",
    description:
      "Save email attachment(s) to local disk (CLI-only; bytes never enter model context). " +
      "Pass `email_id` + `blob_id` (or `part_id`) to save one attachment, or just `email_id` to " +
      "save ALL of its attachments. `out_path` is a file path for a single attachment or an " +
      "existing directory (attachment names sanitized). Membership is verified against the " +
      "email's body-part tree. read-only on the server; writes locally.",
    input: attachmentSaveInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "blob",
    surfaces: ["cli"],
    handler: attachmentSaveHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "mail.export",
    mcpName: "export_emails",
    description:
      "Export emails as raw RFC822 .eml files to a local directory (CLI-only; raw fidelity, " +
      "bytes never enter model context). Batch-first: pass ids (or pipe them via `-`). Writes " +
      "one `<id>.eml` per email into `out_dir`; per-email download failures land in `failed`.",
    input: exportInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "raw",
    surfaces: ["cli"],
    handler: exportHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "mail.import",
    mcpName: "import_emails",
    description:
      "Import local .eml (RFC822) files into a mailbox via Email/import (CLI-only). `mailbox` " +
      'accepts a role (inbox, archive, …), a name, or a mailbox id. Keywords default ["$seen"] ' +
      "(imported mail is not new); `received_at` overrides the server timestamp for all files. " +
      "Per-file upload/import failures land in `failed`; successes return brief-projected emails.",
    input: importInput,
    annotations: { readOnly: false, idempotent: false },
    confirmClass: "none",
    projection: "email",
    surfaces: ["cli"],
    handler: importHandler as OpDefinition["handler"],
  }),
];
