/**
 * Unit tests for MIME assembly, RFC-correct reply threading, forward quoting, body-structure
 * building, subject handling, HTML downshift, byte capping, attachment planning, and the canonical
 * send plan (src/core/compose.ts). Grounded in rfc-notes/rfc8620-8621-jmap-core-mail.md §2.9,
 * §2.13, §2.15. Pure functions except planAttachments (async; url branch would fetch).
 */
import {
  type AttachmentBodyPart,
  baseSubject,
  bodyStructureCreate,
  buildCompose,
  buildForward,
  buildReply,
  capUtf8,
  type EmailCreatePayload,
  forwardSubject,
  htmlToMarkdown,
  htmlToText,
  normalizeAddress,
  type PendingUpload,
  planAttachments,
  planSend,
  replySubject,
  uploadedAttachmentPart,
} from "../../src/core/compose.ts";
import type { Email, Identity } from "../../src/core/jmap/types.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}: got ${a}, expected ${e}`);
}

const IDENTITY: Identity = { id: "id1", name: "Sol", email: "sol@astrius.ink" };

/** A rich parent email for reply/forward threading tests. */
function parentEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: "m1",
    blobId: "blob-m1",
    threadId: "t1",
    messageId: ["<parent@example.com>"],
    references: ["<root@example.com>", "<mid@example.com>"],
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [
      { name: "Sol", email: "sol@astrius.ink" },
      { name: "Bob", email: "bob@example.com" },
    ],
    cc: [{ name: "Carol", email: "carol@example.com" }],
    subject: "Re: [list] Quarterly report",
    sentAt: "2026-07-01T10:00:00Z",
    textBody: [{ partId: "1", type: "text/plain" }],
    htmlBody: [{ partId: "2", type: "text/html" }],
    bodyValues: {
      "1": { value: "Original line one\nOriginal line two" },
      "2": { value: "<p>Original <b>html</b></p>" },
    },
    preview: "Original line one",
    ...overrides,
  };
}

// ── Subjects ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("baseSubject strips repeated Re:/Fwd: prefixes and leading list tags", () => {
  assertEquals(baseSubject("Re: Fwd: [list] Hello"), "Hello");
  assertEquals(baseSubject("[Team] Re: Status"), "Status");
  assertEquals(baseSubject("plain"), "plain");
  assertEquals(baseSubject(undefined), "");
});

Deno.test("replySubject prefixes a single Re: onto the base and preserves it", () => {
  assertEquals(replySubject("Re: [list] Quarterly report"), "Re: Quarterly report");
  assertEquals(replySubject("Fresh topic"), "Re: Fresh topic");
  assertEquals(replySubject(undefined), "Re:");
});

Deno.test("forwardSubject prefixes Fwd: onto the base subject", () => {
  assertEquals(forwardSubject("Re: Meeting"), "Fwd: Meeting");
  assertEquals(forwardSubject(undefined), "Fwd:");
});

// ── buildReply threading (RFC 8621 §2.15) ───────────────────────────────────────────────────────

Deno.test("buildReply sets inReplyTo = parent messageId and references = parent refs + messageId", () => {
  const reply = buildReply(parentEmail(), IDENTITY, ["sol@astrius.ink"], {});
  assertEquals(reply.inReplyTo, ["<parent@example.com>"], "inReplyTo");
  assertEquals(
    reply.references,
    ["<root@example.com>", "<mid@example.com>", "<parent@example.com>"],
    "references appends parent messageId",
  );
  assertEquals(reply.subject, "Re: Quarterly report", "base subject preserved");
  assertEquals(reply.from, [{ name: "Sol", email: "sol@astrius.ink" }], "From from identity");
});

Deno.test("buildReply falls back to inReplyTo for references when parent has none", () => {
  const reply = buildReply(
    parentEmail({ references: null, inReplyTo: ["<grandparent@example.com>"] }),
    IDENTITY,
    ["sol@astrius.ink"],
    {},
  );
  assertEquals(reply.references, ["<grandparent@example.com>", "<parent@example.com>"]);
});

Deno.test("buildReply (sender-only) targets replyTo when present, else from", () => {
  const withReplyTo = buildReply(
    parentEmail({ replyTo: [{ email: "noreply@example.com" }] }),
    IDENTITY,
    ["sol@astrius.ink"],
    {},
  );
  assertEquals(withReplyTo.to, [{ email: "noreply@example.com" }], "replyTo wins");
  assert(!("cc" in withReplyTo), "sender-only reply has no cc");

  const withoutReplyTo = buildReply(
    parentEmail({ replyTo: null }),
    IDENTITY,
    ["sol@astrius.ink"],
    {},
  );
  assertEquals(
    withoutReplyTo.to,
    [{ name: "Alice", email: "alice@example.com" }],
    "from is target",
  );
});

Deno.test("buildReply reply-all adds parent to+cc minus self and minus existing recipients", () => {
  const reply = buildReply(parentEmail(), IDENTITY, ["sol@astrius.ink"], { reply_all: true });
  // to = from (Alice); cc = parent to+cc minus self (sol) minus already-in-to (alice).
  assertEquals(reply.to, [{ name: "Alice", email: "alice@example.com" }]);
  assertEquals(
    reply.cc,
    [
      { name: "Bob", email: "bob@example.com" },
      { name: "Carol", email: "carol@example.com" },
    ],
    "self dropped, alice already in to",
  );
});

Deno.test("buildReply self-address matching is case-insensitive", () => {
  // Parent to = [SOL (self, mixed-case), dave]; parent cc = Carol (default fixture).
  // reply-all cc = parent to+cc minus self minus already-in-to(from=alice) → dave, carol.
  const reply = buildReply(
    parentEmail({ to: [{ email: "SOL@Astrius.INK" }, { email: "dave@example.com" }] }),
    IDENTITY,
    ["sol@astrius.ink"],
    { reply_all: true },
  );
  assertEquals(
    reply.cc,
    [{ email: "dave@example.com" }, { name: "Carol", email: "carol@example.com" }],
    "case-folded self removed from cc, others kept",
  );
});

Deno.test("buildReply quotes the parent plain body with '> ' prefixes by default", () => {
  const reply = buildReply(parentEmail(), IDENTITY, ["sol@astrius.ink"], { body_text: "Sure." });
  const { bodyValues } = reply as { bodyValues: Record<string, { value: string }> };
  assert(bodyValues.text.value.startsWith("Sure."), "user text leads");
  assert(bodyValues.text.value.includes("> Original line one"), "quoted parent line one");
  assert(bodyValues.text.value.includes("> Original line two"), "quoted parent line two");
});

Deno.test("buildReply with quote:false omits the quoted parent body", () => {
  const reply = buildReply(parentEmail(), IDENTITY, ["sol@astrius.ink"], {
    body_text: "No quote.",
    quote: false,
  });
  const { bodyValues } = reply as { bodyValues: Record<string, { value: string }> };
  assertEquals(bodyValues.text.value, "No quote.");
});

Deno.test("buildReply carries the identity replyTo when set", () => {
  const identity: Identity = { ...IDENTITY, replyTo: [{ email: "desk@astrius.ink" }] };
  const reply = buildReply(parentEmail(), identity, ["sol@astrius.ink"], {});
  assertEquals(reply.replyTo, [{ email: "desk@astrius.ink" }]);
});

Deno.test("buildReply overrides replace derived recipients but keep threading", () => {
  const parent = parentEmail();
  const reply = buildReply(parent, IDENTITY, ["sol@astrius.ink"], {
    reply_all: true,
    to: [{ email: "billing@example.com" }],
    cc: [{ name: "Ops", email: "ops@example.com" }],
    bcc: [{ email: "audit@astrius.ink" }],
    from: { name: "Sol", email: "sol@astrius.ink" },
    reply_to: [{ email: "desk@astrius.ink" }],
    subject: "Custom subject",
    headers: { "X-Ref": "INV-4071790" },
    keywords: ["$flagged"],
  });
  // Explicit to/cc win over reply-all derivation; bcc added.
  assertEquals(reply.to, [{ email: "billing@example.com" }]);
  assertEquals(reply.cc, [{ name: "Ops", email: "ops@example.com" }]);
  assertEquals(reply.bcc, [{ email: "audit@astrius.ink" }]);
  assertEquals(reply.from, [{ name: "Sol", email: "sol@astrius.ink" }]);
  assertEquals(reply.replyTo, [{ email: "desk@astrius.ink" }]);
  assertEquals(reply.subject, "Custom subject");
  assertEquals((reply as Record<string, unknown>)["header:X-Ref"], "INV-4071790");
  assertEquals(reply.keywords, { "$flagged": true });
  // Threading is still derived from the parent regardless of overrides.
  assertEquals(reply.inReplyTo, parent.messageId);
});

// ── buildForward ─────────────────────────────────────────────────────────────────────────────────

Deno.test("buildForward reattaches the original zero-copy as a message/rfc822 part by default", () => {
  const fwd = buildForward(parentEmail(), IDENTITY, {
    to: [{ email: "dana@example.com" }],
    body_text: "FYI",
  });
  assertEquals(fwd.subject, "Fwd: Quarterly report");
  assertEquals(fwd.to, [{ email: "dana@example.com" }]);
  const structure = fwd.bodyStructure as {
    type: string;
    subParts: Array<Record<string, unknown>>;
  };
  assertEquals(structure.type, "multipart/mixed", "attachment wraps in mixed");
  const attach = structure.subParts.find((p) => p.blobId === "blob-m1");
  assert(attach !== undefined, "original reattached by blobId");
  assertEquals(attach!.type, "message/rfc822");
  // Filename is derived from the raw subject (sanitized), not the base subject.
  assertEquals(attach!.name, "Re_list_Quarterly_report.eml");
  assertEquals(attach!.disposition, "attachment");
});

Deno.test("buildForward in quote mode (attach_original:false) inlines the quoted original", () => {
  const fwd = buildForward(parentEmail(), IDENTITY, {
    to: [{ email: "dana@example.com" }],
    body_text: "See below",
    attach_original: false,
  });
  const { bodyValues } = fwd as { bodyValues: Record<string, { value: string }> };
  assert(bodyValues.text.value.includes("Forwarded message"), "forward header block present");
  assert(bodyValues.text.value.includes("Original line one"), "original body inlined");
  // HTML preserved when parent had HTML.
  assert("html" in bodyValues, "html body part emitted for HTML-bearing parent");
});

// ── buildCompose ─────────────────────────────────────────────────────────────────────────────────

Deno.test("buildCompose uses the explicit from, applies keywords and custom headers", () => {
  const payload = buildCompose(
    {
      from: { name: "Sol", email: "sol@astrius.ink" },
      to: [{ email: "x@example.com" }],
      subject: "Hi",
      body_text: "Body",
      keywords: ["$draft"],
      headers: { "X-Custom": "1" },
    },
    undefined,
  );
  assertEquals(payload.from, [{ name: "Sol", email: "sol@astrius.ink" }]);
  assertEquals(payload.subject, "Hi");
  assertEquals(payload.keywords, { "$draft": true }, "keywords as set-of-true");
  assertEquals(payload["header:X-Custom"], "1", "custom header via header:<Name>");
  assert(!("headers" in payload), "no top-level headers property (RFC 8621 §2.9)");
});

Deno.test("buildCompose falls back to the identity address when from is omitted", () => {
  const payload = buildCompose({ subject: "S", body_text: "B" }, IDENTITY);
  assertEquals(payload.from, [{ name: "Sol", email: "sol@astrius.ink" }]);
});

Deno.test("buildCompose throws when neither from nor identity is available", () => {
  let threw = false;
  try {
    buildCompose({ subject: "S", body_text: "B" }, undefined);
  } catch {
    threw = true;
  }
  assert(threw, "expected throw without a from address");
});

// ── bodyStructureCreate (RFC 8621 §2.9) ──────────────────────────────────────────────────────────

Deno.test("bodyStructureCreate emits a single text/plain part with no wrapper", () => {
  const { bodyStructure, bodyValues } = bodyStructureCreate("hello", undefined, []);
  assertEquals(bodyStructure, { partId: "text", type: "text/plain" }, "bare text part");
  assertEquals(bodyValues, { text: { value: "hello" } });
});

Deno.test("bodyStructureCreate nests text+html under multipart/alternative", () => {
  const { bodyStructure, bodyValues } = bodyStructureCreate("t", "<p>h</p>", []);
  assertEquals(bodyStructure, {
    type: "multipart/alternative",
    subParts: [
      { partId: "text", type: "text/plain" },
      { partId: "html", type: "text/html" },
    ],
  });
  assertEquals(bodyValues, { text: { value: "t" }, html: { value: "<p>h</p>" } });
});

Deno.test("bodyStructureCreate wraps body + attachments in multipart/mixed", () => {
  const attachments: AttachmentBodyPart[] = [{
    blobId: "b1",
    type: "application/pdf",
    name: "doc.pdf",
    disposition: "attachment",
  }];
  const { bodyStructure } = bodyStructureCreate("t", undefined, attachments);
  const s = bodyStructure as { type: string; subParts: Array<Record<string, unknown>> };
  assertEquals(s.type, "multipart/mixed");
  assertEquals(s.subParts[0], { partId: "text", type: "text/plain" }, "body first");
  assertEquals(s.subParts[1], {
    blobId: "b1",
    type: "application/pdf",
    name: "doc.pdf",
    disposition: "attachment",
  });
});

// ── planSend (RFC 8621 §2.13) ────────────────────────────────────────────────────────────────────

Deno.test("planSend composes Email/set + EmailSubmission/set with a #creationId back-reference", () => {
  const plan = planSend({
    accountId: "acct",
    identity: IDENTITY,
    create: { subject: "S", from: [{ email: "sol@astrius.ink" }] },
    draftsMailboxId: "mb-drafts",
    sentMailboxId: "mb-sent",
    submissionUsing: ["urn:core", "urn:submission"],
  });
  assertEquals(plan.using, ["urn:core", "urn:submission"]);
  assertEquals(plan.calls.length, 2, "two method calls");

  const [emailMethod, emailArgs] = plan.calls[0];
  assertEquals(emailMethod, "Email/set");
  const create = (emailArgs as { create: Record<string, EmailCreatePayload> }).create.email;
  assertEquals(create.mailboxIds, { "mb-drafts": true }, "lands in drafts until send");

  const [subMethod, subArgs] = plan.calls[1];
  assertEquals(subMethod, "EmailSubmission/set");
  const args = subArgs as {
    create: { send: { emailId: string; identityId: string } };
    onSuccessUpdateEmail: Record<string, Record<string, unknown>>;
  };
  assertEquals(args.create.send.identityId, "id1");
  assertEquals(
    args.create.send.emailId,
    "#email",
    "RFC 8620 §5.3 creation-id string (Stalwart rejects ResultReferences inside create objects)",
  );
  assertEquals(
    args.onSuccessUpdateEmail["#send"],
    {
      "keywords/$draft": null,
      "keywords/$seen": true,
      "mailboxIds/mb-drafts": null,
      "mailboxIds/mb-sent": true,
    },
    "onSuccessUpdateEmail moves drafts→sent and clears $draft",
  );
});

Deno.test("planSend for an existing draft targets its id directly (no Email/set)", () => {
  const plan = planSend({
    accountId: "acct",
    identity: IDENTITY,
    existingEmailId: "m9",
    sentMailboxId: "mb-sent",
    draftsMailboxId: "mb-drafts",
    submissionUsing: ["urn:submission"],
  });
  assertEquals(plan.calls.length, 1, "only the submission call");
  const [method, args] = plan.calls[0];
  assertEquals(method, "EmailSubmission/set");
  const a = args as {
    create: { send: { emailId: string } };
    onSuccessUpdateEmail: Record<string, unknown>;
  };
  assertEquals(a.create.send.emailId, "m9");
  assert("m9" in a.onSuccessUpdateEmail, "patch keyed by the existing email id");
});

Deno.test("planSend with send_at attaches a FUTURERELEASE HOLDUNTIL envelope", () => {
  const plan = planSend({
    accountId: "acct",
    identity: IDENTITY,
    create: { subject: "S" },
    sendAt: "2026-07-09T09:00:00Z",
    submissionUsing: ["urn:submission"],
  });
  const subArgs = plan.calls[1][1] as {
    create: { send: { envelope?: { mailFrom: { parameters: Record<string, string> } } } };
  };
  assertEquals(
    subArgs.create.send.envelope?.mailFrom.parameters,
    { HOLDUNTIL: "2026-07-09T09:00:00Z" },
    "hold parameter carries the release instant",
  );
});

Deno.test("planSend throws when neither create nor existingEmailId is supplied", () => {
  let threw = false;
  try {
    planSend({ accountId: "a", identity: IDENTITY, submissionUsing: [] });
  } catch {
    threw = true;
  }
  assert(threw, "expected throw");
});

// ── planAttachments ─────────────────────────────────────────────────────────────────────────────

Deno.test("planAttachments passes blob_id sources through as body parts, no upload", async () => {
  const { bodyParts, uploads, preCalls } = await planAttachments(
    [{ blob_id: "b1", name: "a.pdf", type: "application/pdf" }],
    "acct",
  );
  assertEquals(preCalls, [], "no in-request blob creation (JMAP has none)");
  assertEquals(uploads, [], "blob_id needs no upload");
  assertEquals(bodyParts, [{
    blobId: "b1",
    type: "application/pdf",
    name: "a.pdf",
    disposition: "attachment",
  }]);
});

Deno.test("planAttachments defers content_base64 sources to a pending upload with decoded bytes", async () => {
  const b64 = btoa("hello");
  const { bodyParts, uploads } = await planAttachments(
    [{ content_base64: b64, name: "h.txt", type: "text/plain" }],
    "acct",
  );
  assertEquals(bodyParts, [], "no body part until the blob is uploaded");
  assertEquals(uploads.length, 1);
  assertEquals(uploads[0].name, "h.txt");
  assertEquals(uploads[0].type, "text/plain");
  assertEquals(new TextDecoder().decode(uploads[0].bytes), "hello", "base64 decoded to bytes");
});

Deno.test("uploadedAttachmentPart turns an upload + returned blobId into a body part", () => {
  const upload: PendingUpload = {
    index: 0,
    bytes: new Uint8Array(),
    name: "h.txt",
    type: "text/plain",
  };
  assertEquals(uploadedAttachmentPart(upload, "blob-new"), {
    blobId: "blob-new",
    type: "text/plain",
    name: "h.txt",
    disposition: "attachment",
  });
});

Deno.test("uploadedAttachmentPart honors the inline flag → inline disposition", () => {
  const upload: PendingUpload = {
    index: 0,
    bytes: new Uint8Array(),
    name: "logo.png",
    type: "image/png",
    cid: "logo@cid",
    inline: true,
  };
  assertEquals(uploadedAttachmentPart(upload, "b2"), {
    blobId: "b2",
    type: "image/png",
    name: "logo.png",
    cid: "logo@cid",
    disposition: "inline",
  });
});

// ── HTML downshift ───────────────────────────────────────────────────────────────────────────────

Deno.test("htmlToText strips markup to readable text (h1 rendered per html-to-text defaults)", () => {
  const out = htmlToText("<h1>Title</h1><p>Hello <b>world</b></p>");
  assert(out.includes("Hello world"), "paragraph text kept, inline tags flattened");
  assert(out.toUpperCase().includes("TITLE"), "heading text kept");
  assert(!out.includes("<"), "no tags remain");
});

Deno.test("htmlToMarkdown surfaces link targets alongside link text", () => {
  const out = htmlToMarkdown('<h2>Sec</h2><p><a href="https://x.test">link</a></p>');
  assert(out.includes("Sec"), "heading text kept");
  assert(out.includes("https://x.test"), "link href surfaced (not hidden)");
  assert(!out.includes("<"), "no tags remain");
});

Deno.test("htmlToText applies a UTF-8-safe byte cap", () => {
  const out = htmlToText("<p>abcdefghij</p>", 4);
  assert(new TextEncoder().encode(out).length <= 4, "capped to <= 4 bytes");
});

// ── capUtf8 ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("capUtf8 returns the input unchanged when under the cap or no cap given", () => {
  assertEquals(capUtf8("hello"), "hello", "no cap");
  assertEquals(capUtf8("hello", 100), "hello", "under cap");
  assertEquals(capUtf8("hello", 0), "hello", "0 means no cap");
});

Deno.test("capUtf8 never splits a multi-byte codepoint", () => {
  // "é" is 2 UTF-8 bytes; a cap of 3 must drop it rather than emit a lone half.
  const capped = capUtf8("aé", 2);
  assertEquals(capped, "a", "half of é dropped, no replacement char");
  assert(!capped.includes("�"), "no U+FFFD replacement char left behind");
  // A cap that lands exactly on a codepoint boundary keeps it.
  assertEquals(capUtf8("aé", 3), "aé", "full é fits in 3 bytes");
});

// ── normalizeAddress ─────────────────────────────────────────────────────────────────────────────

Deno.test("normalizeAddress trims and case-folds for self/dup comparison", () => {
  assertEquals(normalizeAddress("  Sol@Astrius.INK "), "sol@astrius.ink");
});
