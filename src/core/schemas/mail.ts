/**
 * Mail-domain Zod schemas (RFC 8621). Interfaces are normative (owned by B2-schemas-mail); the
 * schema consts below are the real definitions replacing the earlier todoSchema() stubs.
 * Typed payloads that ride INSIDE the JMAP wire object keep spec camelCase; snake_case is only for
 * tool-arg surfaces (AddressInput, AttachmentInput, ComposeEmailInput).
 * Grounded in docs/rfc-notes/rfc8620-8621-jmap-core-mail.md §2.7 (filter — all 18 conditions),
 * §2.8 (keyword charset), §2.9 (create), §2.13 (submission envelope).
 */
import { z } from "zod";
import { UtcDateTimeSchema } from "./common.ts";

/** Snake_case address input for tool args; converted to spec EmailAddress in compose.ts. */
export interface AddressInput {
  name?: string;
  email: string;
}

/**
 * The complete RFC 8621 Email/query FilterCondition — all 18 conditions, spec camelCase
 * because this object goes INSIDE the JMAP payload. before/after filter on receivedAt.
 */
export interface EmailFilterCondition {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  before?: string;
  after?: string;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: string[];
}

/** Recursive FilterOperator tree ({operator: AND|OR|NOT, conditions: [...]}) or a condition. */
export type EmailFilter =
  | EmailFilterCondition
  | { operator: "AND" | "OR" | "NOT"; conditions: EmailFilter[] };

/** RFC 8620 §5.5 Comparator; keyword sorts require the extra `keyword` property. */
export interface EmailComparator {
  property: string;
  isAscending?: boolean;
  collation?: string;
  keyword?: string;
}

/** Attachment input union for send/reply/forward — exactly one source. */
export type AttachmentInput =
  | { blob_id: string; name?: string; type?: string; cid?: string; inline?: boolean }
  | { content_base64: string; name: string; type: string; cid?: string; inline?: boolean }
  | { url: string; name?: string; type?: string; cid?: string; inline?: boolean };

/** Compose input for mail.send (snake_case tool-arg side; compose.ts builds the JMAP payload). */
export interface ComposeEmailInput {
  from?: AddressInput;
  to?: AddressInput[];
  cc?: AddressInput[];
  bcc?: AddressInput[];
  reply_to?: AddressInput[];
  subject: string;
  body_text?: string;
  body_html?: string;
  attachments?: AttachmentInput[];
  identity_id?: string;
  headers?: Record<string, string>;
  keywords?: string[];
}

/**
 * IMAP-keyword charset: 1–255 chars %x21–%x7E minus ( ) { ] % * " \ (RFC 8621 §2.8). Keywords are
 * case-insensitive and returned lowercase by the server, but we accept the caller's case verbatim.
 */
const KEYWORD_FORBIDDEN = new Set(["(", ")", "{", "]", "%", "*", '"', "\\"]);
export const KeywordSchema: z.ZodType<string> = z.string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      [...value].every((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code >= 0x21 && code <= 0x7e && !KEYWORD_FORBIDDEN.has(ch);
      }),
    'keyword must be 1-255 chars from %x21-%x7E excluding ( ) { ] % * " \\',
  );

/**
 * FilterCondition schema. Every field optional; a FilterCondition MUST NOT carry an `operator` key
 * (that would make it a FilterOperator — enforced in EmailFilterSchema, not here, so a bare
 * condition object stays permissive). `header` is a 1–2 element tuple: [name] tests existence,
 * [name, text] tests a substring of the value.
 */
export const EmailFilterConditionSchema: z.ZodType<EmailFilterCondition> = z.object({
  inMailbox: z.string().optional(),
  inMailboxOtherThan: z.array(z.string()).optional(),
  before: UtcDateTimeSchema.optional(),
  after: UtcDateTimeSchema.optional(),
  minSize: z.number().int().nonnegative().optional(),
  maxSize: z.number().int().nonnegative().optional(),
  allInThreadHaveKeyword: KeywordSchema.optional(),
  someInThreadHaveKeyword: KeywordSchema.optional(),
  noneInThreadHaveKeyword: KeywordSchema.optional(),
  hasKeyword: KeywordSchema.optional(),
  notKeyword: KeywordSchema.optional(),
  hasAttachment: z.boolean().optional(),
  text: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  header: z.array(z.string().min(1)).min(1).max(2).optional(),
});

const EmailFilterOperatorSchema: z.ZodType<
  { operator: "AND" | "OR" | "NOT"; conditions: EmailFilter[] }
> = z.object({
  operator: z.enum(["AND", "OR", "NOT"]),
  conditions: z.array(z.lazy(() => EmailFilterSchema)),
});

/**
 * Recursive FilterOperator | FilterCondition. The union prefers the operator branch so that an
 * object carrying an `operator` key is validated as an operator (its presence would otherwise be
 * silently ignored by the condition branch). z.lazy breaks the self-reference cycle.
 */
export const EmailFilterSchema: z.ZodType<EmailFilter> = z.lazy(() =>
  z.union([EmailFilterOperatorSchema, EmailFilterConditionSchema])
);

/** RFC 8620 §5.5 Comparator. The three thread-keyword sorts additionally require `keyword`. */
export const EmailComparatorSchema: z.ZodType<EmailComparator> = z.object({
  property: z.string().min(1),
  isAscending: z.boolean().optional(),
  collation: z.string().optional(),
  keyword: KeywordSchema.optional(),
}).superRefine((value, ctx) => {
  const needsKeyword = value.property === "allInThreadHaveKeyword" ||
    value.property === "someInThreadHaveKeyword" || value.property === "hasKeyword";
  if (needsKeyword && value.keyword === undefined) {
    ctx.addIssue({
      code: "custom",
      message: `sort on ${value.property} requires a keyword property`,
      path: ["keyword"],
    });
  }
});

export const AddressInputSchema: z.ZodType<AddressInput> = z.object({
  name: z.string().optional(),
  email: z.string().min(1),
});

/**
 * Attachment source union — exactly one of blob_id / content_base64 / url. Modeled as a
 * discriminated-style union: each branch asserts the presence of exactly its own source key and
 * the absence of the others, so ambiguous inputs (two sources) are rejected rather than silently
 * coerced. content_base64 requires name+type (server has no filename/MIME metadata otherwise).
 */
const AttachmentBlobSchema = z.object({
  blob_id: z.string().min(1),
  name: z.string().optional(),
  type: z.string().optional(),
  cid: z.string().optional(),
  inline: z.boolean().optional(),
}).strict();

const AttachmentBase64Schema = z.object({
  content_base64: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  cid: z.string().optional(),
  inline: z.boolean().optional(),
}).strict();

const AttachmentUrlSchema = z.object({
  url: z.string().url(),
  name: z.string().optional(),
  type: z.string().optional(),
  cid: z.string().optional(),
  inline: z.boolean().optional(),
}).strict();

export const AttachmentInputSchema: z.ZodType<AttachmentInput> = z.union([
  AttachmentBlobSchema,
  AttachmentBase64Schema,
  AttachmentUrlSchema,
]);

/**
 * Compose input for mail.send. Requires a subject and at least one body part (text or html);
 * cross-field body presence is enforced here so the op handler doesn't emit an empty message.
 */
export const ComposeEmailInputSchema: z.ZodType<ComposeEmailInput> = z.object({
  from: AddressInputSchema.optional(),
  to: z.array(AddressInputSchema).optional(),
  cc: z.array(AddressInputSchema).optional(),
  bcc: z.array(AddressInputSchema).optional(),
  reply_to: z.array(AddressInputSchema).optional(),
  subject: z.string(),
  body_text: z.string().optional(),
  body_html: z.string().optional(),
  attachments: z.array(AttachmentInputSchema).optional(),
  identity_id: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  keywords: z.array(KeywordSchema).optional(),
}).superRefine((value, ctx) => {
  if (value.body_text === undefined && value.body_html === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "provide at least one of body_text or body_html",
      path: ["body_text"],
    });
  }
});

/** organize_emails `mark` sugar. */
export const MarkSchema = z.enum(["read", "unread", "flagged", "unflagged", "junk", "not_junk"]);

/** organize_emails `move_to` sugar: role or explicit mailbox id. */
export const MoveToSchema = z.string().min(1).describe(
  "archive | trash | inbox | <mailbox_id>",
);
