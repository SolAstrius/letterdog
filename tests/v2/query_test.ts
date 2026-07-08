/**
 * Unit tests for the Gmail-syntax → RFC 8621 Email/query FilterCondition translator
 * (src/core/query.ts). Pure functions; no network. Covers every documented token, negation,
 * quoting, free-text merging, receivedAt date widening, size suffixes, unsupported-token capture,
 * mailbox-ref deferral, and mergeFilters AND-composition.
 */
import {
  type GmailTranslation,
  MAILBOX_REF_PREFIX,
  mergeFilters,
  translateGmailQuery,
} from "../../src/core/query.ts";
import type { EmailFilter, EmailFilterCondition } from "../../src/core/schemas/mail.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}: got ${a}, expected ${e}`);
}

function isOperator(
  f: EmailFilter | null,
): f is { operator: "AND" | "OR" | "NOT"; conditions: EmailFilter[] } {
  return typeof f === "object" && f !== null && "operator" in f;
}

/** A single-condition query produces exactly that condition (no AND wrapper). */
function onlyCondition(t: GmailTranslation): EmailFilterCondition {
  assert(t.filter !== null, "expected a filter");
  assert(!isOperator(t.filter), "expected a bare condition, got an operator");
  return t.filter as EmailFilterCondition;
}

// ── Header/text operators ──────────────────────────────────────────────────────────────────────

Deno.test("from/to/cc/bcc/subject/body/text map to their FilterCondition key", () => {
  for (const key of ["from", "to", "cc", "bcc", "subject", "body", "text"]) {
    const t = translateGmailQuery(`${key}:hello`);
    assertEquals(onlyCondition(t), { [key]: "hello" }, key);
    assertEquals(t.unsupported, [], `${key} unsupported`);
  }
});

Deno.test("operator keys are case-insensitive and normalize to lowercase", () => {
  const t = translateGmailQuery("From:Alice");
  assertEquals(onlyCondition(t), { from: "Alice" }, "From: → from:");
});

// ── is: keyword sugar ───────────────────────────────────────────────────────────────────────────

Deno.test("is: sugar maps to hasKeyword/notKeyword system keywords", () => {
  const cases: Record<string, EmailFilterCondition> = {
    "is:read": { hasKeyword: "$seen" },
    "is:unread": { notKeyword: "$seen" },
    "is:flagged": { hasKeyword: "$flagged" },
    "is:starred": { hasKeyword: "$flagged" },
    "is:unflagged": { notKeyword: "$flagged" },
    "is:draft": { hasKeyword: "$draft" },
    "is:important": { hasKeyword: "$important" },
    "is:answered": { hasKeyword: "$answered" },
    "is:forwarded": { hasKeyword: "$forwarded" },
    "is:junk": { hasKeyword: "$junk" },
    "is:spam": { hasKeyword: "$junk" },
    "is:notjunk": { hasKeyword: "$notjunk" },
  };
  for (const [query, expected] of Object.entries(cases)) {
    assertEquals(onlyCondition(translateGmailQuery(query)), expected, query);
  }
});

Deno.test("unknown is: value is surfaced as unsupported, not guessed", () => {
  const t = translateGmailQuery("is:pinned");
  assertEquals(t.filter, null, "no condition produced");
  assertEquals(t.unsupported, ["is:pinned"], "surfaced verbatim");
});

// ── has: attachment ─────────────────────────────────────────────────────────────────────────────

Deno.test("has:attachment maps to hasAttachment true; other has: values unsupported", () => {
  assertEquals(onlyCondition(translateGmailQuery("has:attachment")), { hasAttachment: true });
  assertEquals(translateGmailQuery("has:nothing").unsupported, ["has:nothing"]);
});

// ── Dates: receivedAt widening + inclusivity semantics ─────────────────────────────────────────

Deno.test("after:/before: widen a bare date to UTC midnight (receivedAt bounds)", () => {
  assertEquals(onlyCondition(translateGmailQuery("after:2026-07-08")), {
    after: "2026-07-08T00:00:00Z",
  });
  assertEquals(onlyCondition(translateGmailQuery("before:2026-07-08")), {
    before: "2026-07-08T00:00:00Z",
  });
});

Deno.test("newer:/older: are aliases of after:/before:", () => {
  assertEquals(onlyCondition(translateGmailQuery("newer:2026-01-01")), {
    after: "2026-01-01T00:00:00Z",
  });
  assertEquals(onlyCondition(translateGmailQuery("older:2026-01-01")), {
    before: "2026-01-01T00:00:00Z",
  });
});

Deno.test("slash-form dates are accepted and normalized to hyphen UTC boundary", () => {
  assertEquals(onlyCondition(translateGmailQuery("after:2026/07/08")), {
    after: "2026-07-08T00:00:00Z",
  });
});

Deno.test("a full UTCDateTime passes through unchanged", () => {
  assertEquals(onlyCondition(translateGmailQuery("after:2026-07-08T09:30:00Z")), {
    after: "2026-07-08T09:30:00Z",
  });
});

// ── Sizes ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("larger:/smaller: parse 1024-based K/M/G suffixes to minSize/maxSize", () => {
  assertEquals(onlyCondition(translateGmailQuery("larger:1M")), { minSize: 1024 * 1024 });
  assertEquals(onlyCondition(translateGmailQuery("smaller:500K")), { maxSize: 500 * 1024 });
  assertEquals(onlyCondition(translateGmailQuery("larger:2G")), {
    minSize: 2 * 1024 * 1024 * 1024,
  });
  assertEquals(onlyCondition(translateGmailQuery("larger:100")), { minSize: 100 });
});

Deno.test("an unparseable size throws (surfacing a clear error to the op layer)", () => {
  let threw = false;
  try {
    translateGmailQuery("larger:huge");
  } catch {
    threw = true;
  }
  assert(threw, "expected a throw on non-numeric size");
});

// ── header: operator ─────────────────────────────────────────────────────────────────────────────

Deno.test("header:Name tests existence; header:Name:value tests substring (colon-preserving)", () => {
  assertEquals(onlyCondition(translateGmailQuery("header:List-Id")), { header: ["List-Id"] });
  assertEquals(onlyCondition(translateGmailQuery("header:X-Spam:yes")), {
    header: ["X-Spam", "yes"],
  });
  // A value that itself contains a colon is rejoined so the whole substring is preserved.
  assertEquals(onlyCondition(translateGmailQuery("header:Link:https://x")), {
    header: ["Link", "https://x"],
  });
});

// ── in:/label: mailbox refs deferred to the op layer ──────────────────────────────────────────────

Deno.test("in:/label: produce a sentinel-prefixed placeholder and record the mailbox ref", () => {
  const t = translateGmailQuery("in:Inbox");
  assertEquals(onlyCondition(t), { inMailbox: `${MAILBOX_REF_PREFIX}inbox` }, "lowercased ref");
  assertEquals(t.mailboxRefs, ["inbox"], "ref recorded for op-layer resolution");

  const l = translateGmailQuery("label:Work");
  assertEquals(onlyCondition(l), { inMailbox: `${MAILBOX_REF_PREFIX}work` });
  assertEquals(l.mailboxRefs, ["work"]);
});

Deno.test("duplicate mailbox refs are de-duplicated", () => {
  const t = translateGmailQuery("in:inbox label:Inbox");
  assertEquals(t.mailboxRefs, ["inbox"], "one entry only");
});

// ── Negation ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("-is:read flips hasKeyword→notKeyword (stays a plain condition)", () => {
  assertEquals(onlyCondition(translateGmailQuery("-is:read")), { notKeyword: "$seen" });
  assertEquals(onlyCondition(translateGmailQuery("-is:unread")), { hasKeyword: "$seen" });
});

Deno.test("-has:attachment flips the boolean rather than NOT-wrapping", () => {
  assertEquals(onlyCondition(translateGmailQuery("-has:attachment")), { hasAttachment: false });
});

Deno.test("-in:trash becomes inMailboxOtherThan with the placeholder ref", () => {
  const t = translateGmailQuery("-in:trash");
  assertEquals(onlyCondition(t), { inMailboxOtherThan: [`${MAILBOX_REF_PREFIX}trash`] });
  assertEquals(t.mailboxRefs, ["trash"], "ref still recorded for op-layer resolution");
});

Deno.test("-from:spammer NOT-wraps a header condition", () => {
  const t = translateGmailQuery("-from:spammer");
  assert(isOperator(t.filter), "expected a NOT operator");
  assertEquals(t.filter, { operator: "NOT", conditions: [{ from: "spammer" }] });
});

// ── Quoting & free text ──────────────────────────────────────────────────────────────────────────

Deno.test("quoted operator value keeps whitespace as a single phrase", () => {
  assertEquals(onlyCondition(translateGmailQuery('subject:"quarterly report"')), {
    subject: "quarterly report",
  });
  assertEquals(onlyCondition(translateGmailQuery("subject:'quarterly report'")), {
    subject: "quarterly report",
  });
});

Deno.test("bare tokens collapse into a single required-text condition", () => {
  assertEquals(onlyCondition(translateGmailQuery("invoice overdue")), {
    text: "invoice overdue",
  });
});

Deno.test("a quoted free-text phrase is one text token", () => {
  assertEquals(onlyCondition(translateGmailQuery('"payment failed"')), {
    text: "payment failed",
  });
});

Deno.test("empty / whitespace-only query yields a null filter and no unsupported tokens", () => {
  for (const q of ["", "   ", "\t\n"]) {
    const t = translateGmailQuery(q);
    assertEquals(t.filter, null, `query ${JSON.stringify(q)}`);
    assertEquals(t.unsupported, []);
    assertEquals(t.mailboxRefs, []);
  }
});

// ── Composition: multiple conditions AND together, free text appended last ──────────────────────

Deno.test("multiple conditions AND together with free text as a trailing text condition", () => {
  const t = translateGmailQuery("from:klarna is:unread invoice");
  assert(isOperator(t.filter), "expected AND operator");
  assertEquals(t.filter, {
    operator: "AND",
    conditions: [
      { from: "klarna" },
      { notKeyword: "$seen" },
      { text: "invoice" },
    ],
  });
});

Deno.test("unknown operators are captured verbatim and do not appear in the filter", () => {
  const t = translateGmailQuery("from:a deliveredto:b subject:c");
  assertEquals(t.unsupported, ["deliveredto:b"], "only the unknown operator surfaces");
  assert(isOperator(t.filter), "known conditions still AND together");
  assertEquals(t.filter, {
    operator: "AND",
    conditions: [{ from: "a" }, { subject: "c" }],
  });
});

// ── mergeFilters ─────────────────────────────────────────────────────────────────────────────────

Deno.test("mergeFilters ANDs a gmail filter with a typed filter", () => {
  const gmail = translateGmailQuery("from:x").filter;
  const typed: EmailFilter = { hasAttachment: true };
  assertEquals(mergeFilters(gmail, typed), {
    operator: "AND",
    conditions: [{ from: "x" }, { hasAttachment: true }],
  });
});

Deno.test("mergeFilters returns the single present side unwrapped, or null when both null", () => {
  const gmail = translateGmailQuery("from:x").filter;
  assertEquals(mergeFilters(gmail, null), { from: "x" }, "gmail only");
  assertEquals(mergeFilters(null, { hasAttachment: true }), { hasAttachment: true }, "typed only");
  assertEquals(mergeFilters(null, null), null, "both null");
});
