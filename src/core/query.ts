/**
 * Gmail-syntax → RFC 8621 Email/query FilterCondition translation. Ported and improved from v1
 * (src/tools/mail.ts parseMailSearchQuery), now targeting the typed EmailFilter and surfacing
 * unresolved mailbox refs (in:/label:) separately so the op layer resolves them to ids.
 *
 * Supported token grammar (document VERBATIM in search_emails description):
 *   from: to: cc: bcc: subject: body: text:   → the matching header/text FilterCondition
 *   in:<mailbox-name-or-role>                  → inMailbox (name/role → id, resolved by op layer)
 *   is:unread|read|flagged|starred|answered|draft|forwarded|important|junk|notjunk
 *                                              → hasKeyword/notKeyword ($seen, $flagged, …)
 *   has:attachment                             → hasAttachment: true
 *   before:YYYY-MM-DD after:YYYY-MM-DD         → receivedAt bounds (NOT sentAt); see below
 *   larger:1M smaller:500K                     → minSize / maxSize (K/M/G = 1024-based)
 *   label:<keyword-or-mailbox>                 → treated as a mailbox ref (in:) like Gmail labels
 *   header:Name[:value]                        → header existence / substring
 *   "quoted phrase"                            → phrase; bare tokens → all-required text match
 *   -token / -field:value                      → NOT-wrapped condition
 * Unknown operators land in `unsupported` (op surfaces them; never guessed).
 *
 * receivedAt semantics (RFC 8621 §2.7): `after` is INCLUSIVE (receivedAt ≥ value), `before` is
 * EXCLUSIVE (receivedAt < value). A bare date like 2026-07-08 is widened to the UTC midnight
 * boundary 2026-07-08T00:00:00Z, so `after:2026-07-08` includes everything on the 8th and
 * `before:2026-07-08` excludes the 8th entirely. Both are receivedAt (server arrival time), NOT the
 * Date: header (sentAt).
 */
import type { EmailFilter, EmailFilterCondition } from "./schemas/mail.ts";

export interface GmailTranslation {
  /** null when the query contributes no conditions. */
  filter: EmailFilter | null;
  /** Operators/tokens that could not be translated — surfaced to the caller. */
  unsupported: string[];
  /**
   * Mailbox names/roles from in:/label: tokens, lowercased and de-duplicated. The op layer resolves
   * each to a mailbox id and rewrites the placeholder condition `{ inMailbox: "name:<ref>" }`.
   */
  mailboxRefs: string[];
}

/** Sentinel prefix marking an unresolved mailbox reference the op layer must rewrite to an id. */
export const MAILBOX_REF_PREFIX = "name:";

export function translateGmailQuery(query: string): GmailTranslation {
  const conditions: EmailFilter[] = [];
  const freeText: string[] = [];
  const unsupported: string[] = [];
  const mailboxRefs = new Set<string>();

  for (const token of tokenizeQuery(query ?? "")) {
    const parsed = splitOperator(token);
    if (!parsed) {
      if (token.trim()) freeText.push(token);
      continue;
    }
    const { negated, key, value } = parsed;
    const condition = conditionForOperator(key, value, mailboxRefs);
    if (!condition) {
      unsupported.push(token);
      continue;
    }
    conditions.push(negated ? negateCondition(condition) : condition);
  }

  if (freeText.length) conditions.push({ text: freeText.join(" ") });

  return {
    filter: combineAnd(conditions),
    unsupported,
    mailboxRefs: [...mailboxRefs],
  };
}

/** AND-merge the Gmail-derived filter with a typed filter arg (either may be null). */
export function mergeFilters(
  gmail: EmailFilter | null,
  typed: EmailFilter | null,
): EmailFilter | null {
  return combineAnd([gmail, typed].filter((f): f is EmailFilter => f !== null));
}

// ── Token grammar ──────────────────────────────────────────────────────────────────────────────

function conditionForOperator(
  key: string,
  value: string,
  mailboxRefs: Set<string>,
): EmailFilter | undefined {
  switch (key.toLowerCase()) {
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
    case "body":
    case "text":
      return { [key.toLowerCase()]: value } as EmailFilterCondition;
    case "after":
    case "newer":
      return { after: normalizeSearchDate(value) };
    case "before":
    case "older":
      return { before: normalizeSearchDate(value) };
    case "larger":
      return { minSize: parseSize(value) };
    case "smaller":
      return { maxSize: parseSize(value) };
    case "has":
      return value.toLowerCase() === "attachment" ? { hasAttachment: true } : undefined;
    case "is":
      return conditionForIs(value);
    case "in":
    case "label": {
      const ref = value.toLowerCase();
      mailboxRefs.add(ref);
      return { inMailbox: `${MAILBOX_REF_PREFIX}${ref}` };
    }
    case "header": {
      const [name, ...rest] = value.split(":");
      if (!name) return undefined;
      return { header: rest.length ? [name, rest.join(":")] : [name] };
    }
    default:
      return undefined;
  }
}

function conditionForIs(value: string): EmailFilterCondition | undefined {
  switch (value.toLowerCase()) {
    case "read":
      return { hasKeyword: "$seen" };
    case "unread":
      return { notKeyword: "$seen" };
    case "starred":
    case "flagged":
      return { hasKeyword: "$flagged" };
    case "unflagged":
      return { notKeyword: "$flagged" };
    case "draft":
      return { hasKeyword: "$draft" };
    case "important":
      return { hasKeyword: "$important" };
    case "answered":
      return { hasKeyword: "$answered" };
    case "forwarded":
      return { hasKeyword: "$forwarded" };
    case "junk":
    case "spam":
      return { hasKeyword: "$junk" };
    case "notjunk":
      return { hasKeyword: "$notjunk" };
    default:
      return undefined;
  }
}

/**
 * Negate a leaf condition. Keyword conditions flip to their complement, `inMailbox` becomes
 * `inMailboxOtherThan`, and everything else wraps in a NOT operator. `hasAttachment` flips its
 * boolean rather than NOT-wrapping (both are exact, but this stays a plain condition).
 */
function negateCondition(condition: EmailFilter): EmailFilter {
  if (isOperator(condition)) return { operator: "NOT", conditions: [condition] };
  const c = condition;
  if (typeof c.hasKeyword === "string") return { notKeyword: c.hasKeyword };
  if (typeof c.notKeyword === "string") return { hasKeyword: c.notKeyword };
  if (typeof c.hasAttachment === "boolean") return { hasAttachment: !c.hasAttachment };
  if (typeof c.inMailbox === "string") return { inMailboxOtherThan: [c.inMailbox] };
  return { operator: "NOT", conditions: [c] };
}

// ── Parsing primitives ───────────────────────────────────────────────────────────────────────

function splitOperator(
  token: string,
): { negated: boolean; key: string; value: string } | undefined {
  const negated = token.startsWith("-");
  const bare = negated ? token.slice(1) : token;
  const separator = bare.indexOf(":");
  if (separator <= 0) return undefined;
  const key = bare.slice(0, separator);
  const value = bare.slice(separator + 1);
  if (!value) return undefined;
  return { negated, key, value };
}

/**
 * Split on whitespace honoring single/double quotes. A quoted region is kept as one token with the
 * quotes stripped, so `subject:"quarterly report"` and `"free text phrase"` both survive as one
 * token. A leading `-` before a quote (`-"phrase"`) negates the phrase.
 */
function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of query) {
    if ((char === '"' || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Normalize a search date to a UTCDateTime. `2026/07/08` and `2026-07-08` widen to
 * `2026-07-08T00:00:00Z`; an already-full UTCDateTime passes through. Anything else is returned
 * verbatim (the schema will reject it downstream, surfacing a clear error).
 */
function normalizeSearchDate(value: string): string {
  const dateOnly = value.replaceAll("/", "-");
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return `${dateOnly}T00:00:00Z`;
  return value;
}

function parseSize(value: string): number {
  const match = /^(\d+)([kKmMgG])?$/.exec(value);
  if (!match) throw new Error(`Invalid size search value: ${value}`);
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return amount * 1024;
  if (suffix === "m") return amount * 1024 * 1024;
  if (suffix === "g") return amount * 1024 * 1024 * 1024;
  return amount;
}

// ── Filter combination ───────────────────────────────────────────────────────────────────────

function combineAnd(filters: EmailFilter[]): EmailFilter | null {
  const present = filters.filter((f) => f !== null && f !== undefined);
  if (!present.length) return null;
  if (present.length === 1) return present[0];
  return { operator: "AND", conditions: present };
}

function isOperator(
  filter: EmailFilter,
): filter is { operator: "AND" | "OR" | "NOT"; conditions: EmailFilter[] } {
  return typeof filter === "object" && filter !== null && "operator" in filter;
}
