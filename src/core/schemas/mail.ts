/**
 * Mail-domain Zod schemas (RFC 8621). CONTRACT STUB — TODO(builder: B2-schemas-mail).
 * Interfaces are normative; schema consts currently todoSchema() and MUST be replaced with real
 * zod definitions (typed payloads use .passthrough()-style tolerance via catchall where the
 * spec allows extension).
 * Grounded in docs/rfc-notes/rfc8620-8621-jmap-core-mail.md §2.7 (filter), §2.9 (create).
 */
import { z } from "zod";
import { todoSchema } from "./common.ts";

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

export const EmailFilterConditionSchema: z.ZodType<EmailFilterCondition> = todoSchema(
  "schemas/mail EmailFilterConditionSchema",
);

export const EmailFilterSchema: z.ZodType<EmailFilter> = todoSchema(
  "schemas/mail EmailFilterSchema (recursive operator tree via z.lazy)",
);

export const EmailComparatorSchema: z.ZodType<EmailComparator> = todoSchema(
  "schemas/mail EmailComparatorSchema",
);

export const AddressInputSchema: z.ZodType<AddressInput> = todoSchema(
  "schemas/mail AddressInputSchema",
);

export const AttachmentInputSchema: z.ZodType<AttachmentInput> = todoSchema(
  "schemas/mail AttachmentInputSchema (union: blob_id | content_base64 | url)",
);

export const ComposeEmailInputSchema: z.ZodType<ComposeEmailInput> = todoSchema(
  "schemas/mail ComposeEmailInputSchema",
);

/** IMAP-keyword charset: 1–255 chars %x21–%x7E minus ( ) { ] % * " \ (RFC 8621 §2.8). */
export const KeywordSchema: z.ZodType<string> = todoSchema("schemas/mail KeywordSchema");

/** organize_emails `mark` sugar. */
export const MarkSchema = z.enum(["read", "unread", "flagged", "unflagged", "junk", "not_junk"]);

/** organize_emails `move_to` sugar: role or explicit mailbox id. */
export const MoveToSchema = z.string().min(1).describe(
  "archive | trash | inbox | <mailbox_id>",
);
