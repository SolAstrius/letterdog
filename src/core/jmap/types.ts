/**
 * Typed JMAP mail-domain objects (RFC 8621) + principals (RFC 9670). Pure types — normative
 * contract, owned by builder B1-jmap (extend, don't rename). Spec camelCase is intentional:
 * these mirror wire shapes. Grounded in docs/rfc-notes/rfc8620-8621-jmap-core-mail.md.
 */

/** JMAP Id (RFC 8620 §1.2). */
export type Id = string;
/** RFC 3339 date-time with Z offset. */
export type UTCDate = string;

export interface EmailAddress {
  name?: string | null;
  email: string;
}

export interface EmailAddressGroup {
  name: string | null;
  addresses: EmailAddress[];
}

export interface EmailHeader {
  name: string;
  value: string;
}

/** RFC 8621 §4.1.4 — partId XOR blobId (both null iff multipart/*). */
export interface EmailBodyPart {
  partId?: string | null;
  blobId?: Id | null;
  size?: number;
  headers?: EmailHeader[];
  name?: string | null;
  type?: string;
  charset?: string | null;
  disposition?: string | null;
  cid?: string | null;
  language?: string[] | null;
  location?: string | null;
  subParts?: EmailBodyPart[] | null;
  [key: string]: unknown;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem?: boolean;
  isTruncated?: boolean;
}

/** RFC 8621 §4.1 Email. All fields optional because /get properties are caller-selected. */
export interface Email {
  id: Id;
  blobId?: Id;
  threadId?: Id;
  /** Values MUST be true; non-empty at all times. */
  mailboxIds?: Record<Id, boolean>;
  /** Returned lowercase; values true ($seen, $draft, $flagged, $answered, $forwarded, …). */
  keywords?: Record<string, boolean>;
  size?: number;
  /** What before/after filter on — IMAP internaldate, NOT sentAt. */
  receivedAt?: UTCDate;
  messageId?: string[] | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  sender?: EmailAddress[] | null;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  replyTo?: EmailAddress[] | null;
  subject?: string | null;
  sentAt?: string | null;
  bodyStructure?: EmailBodyPart;
  bodyValues?: Record<string, EmailBodyValue>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  attachments?: EmailBodyPart[];
  hasAttachment?: boolean;
  preview?: string;
  [key: string]: unknown;
}

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export type MailboxRole =
  | "inbox"
  | "archive"
  | "drafts"
  | "sent"
  | "trash"
  | "junk"
  | "all"
  | "flagged"
  | "important";

export interface Mailbox {
  id: Id;
  name: string;
  parentId?: Id | null;
  role?: MailboxRole | string | null;
  sortOrder?: number;
  totalEmails?: number;
  unreadEmails?: number;
  totalThreads?: number;
  unreadThreads?: number;
  myRights?: MailboxRights;
  isSubscribed?: boolean;
  [key: string]: unknown;
}

export interface Thread {
  id: Id;
  /** Sorted by receivedAt ascending. */
  emailIds: Id[];
}

/** The IANA-registered mailbox roles JMAP recognizes (lowercased). */
export const MAILBOX_ROLES: readonly MailboxRole[] = [
  "inbox",
  "archive",
  "drafts",
  "sent",
  "trash",
  "junk",
  "all",
  "flagged",
  "important",
];

/**
 * Build a role → mailbox-id lookup from a list of mailboxes (role-less mailboxes skipped). At
 * most one mailbox per role per account, so the last one wins on the theoretical duplicate.
 */
export function mailboxRoleMap(mailboxes: Mailbox[]): Record<string, Id> {
  const map: Record<string, Id> = {};
  for (const mailbox of mailboxes) {
    if (mailbox.role) map[mailbox.role] = mailbox.id;
  }
  return map;
}

export interface Identity {
  id: Id;
  name?: string;
  email: string;
  replyTo?: EmailAddress[] | null;
  bcc?: EmailAddress[] | null;
  textSignature?: string;
  htmlSignature?: string;
  mayDelete?: boolean;
  [key: string]: unknown;
}

export interface SubmissionAddress {
  email: string;
  /** SMTP params, e.g. HOLDFOR/HOLDUNTIL for FUTURERELEASE delayed send. */
  parameters?: Record<string, string | null> | null;
}

export interface SubmissionEnvelope {
  mailFrom: SubmissionAddress;
  rcptTo: SubmissionAddress[];
}

export type UndoStatus = "pending" | "final" | "canceled";

export interface DeliveryStatus {
  smtpReply: string;
  delivered: "queued" | "yes" | "no" | "unknown";
  displayed: "unknown" | "yes";
}

export interface EmailSubmission {
  id: Id;
  identityId?: Id;
  emailId?: Id;
  threadId?: Id;
  envelope?: SubmissionEnvelope | null;
  sendAt?: UTCDate;
  undoStatus?: UndoStatus;
  deliveryStatus?: Record<string, DeliveryStatus> | null;
  dsnBlobIds?: Id[];
  mdnBlobIds?: Id[];
  [key: string]: unknown;
}

/** Singleton, id === "singleton" (RFC 8621 §8). */
export interface VacationResponse {
  id: "singleton";
  isEnabled: boolean;
  fromDate?: UTCDate | null;
  toDate?: UTCDate | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

/** RFC 9670 Principal (no "domain" type value exists). */
export interface Principal {
  id: Id;
  type: "individual" | "group" | "resource" | "location" | "other";
  name: string;
  description?: string | null;
  email?: string | null;
  timeZone?: string | null;
  /** capabilities["urn:ietf:params:jmap:calendars"].calendarAddress = invite URI. */
  capabilities?: Record<string, Record<string, unknown>>;
  accounts?: Record<Id, unknown> | null;
  [key: string]: unknown;
}

/** draft-ietf-jmap-calendars ParticipantIdentity — matches event Participants by address. */
export interface ParticipantIdentity {
  id: Id;
  name?: string;
  calendarAddress: string;
  /** Server-set; mutate only via ParticipantIdentity/set onSuccessSetIsDefault. */
  isDefault?: boolean;
}
