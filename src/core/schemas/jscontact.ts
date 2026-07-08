/**
 * JSContact Card (RFC 9553, JMAP contacts RFC 9610) Zod schemas — scoped to the Card-level
 * properties the PIM needs (design "Open questions": names, emails, phones, addresses,
 * organizations, notes, linked principals).
 *
 * Stalwart's contacts surface is UNPROBED, so these schemas stay deliberately loose: only the
 * fields people-ops project are typed, everything else round-trips via .passthrough(). Nested
 * maps (emails, phones, …) type just the one load-bearing subfield and passthrough the rest.
 * Keep tolerant until a dedicated RFC 9553/9610 digest lands in docs/rfc-notes/.
 */
import { z } from "zod";

export interface CardName {
  full?: string;
  components?: { kind: string; value: string }[];
  [key: string]: unknown;
}

/** JSContact Card — minimal typed slice + passthrough. Spec camelCase (wire shape). */
export interface ContactCard {
  "@type"?: "Card";
  id?: string;
  uid?: string;
  kind?: string;
  name?: CardName;
  /** Map id → {address: "mailto-less addr-spec", contexts?, pref?}. */
  emails?: Record<string, { address: string; [key: string]: unknown }>;
  phones?: Record<string, { number: string; [key: string]: unknown }>;
  addresses?: Record<string, Record<string, unknown>>;
  organizations?: Record<string, { name?: string; [key: string]: unknown }>;
  notes?: Record<string, { note: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Name component: {kind, value} + passthrough (RFC 9553 §2.2.1). */
const NameComponentSchema = z.object({
  kind: z.string(),
  value: z.string(),
}).passthrough();

const CardNameSchema = z.object({
  full: z.string().optional(),
  components: z.array(NameComponentSchema).optional(),
}).passthrough();

const EmailEntrySchema = z.object({
  address: z.string(),
}).passthrough();

const PhoneEntrySchema = z.object({
  number: z.string(),
}).passthrough();

/** Addresses left fully open — component structure unprobed on Stalwart. */
const AddressEntrySchema = z.record(z.string(), z.unknown());

const OrganizationEntrySchema = z.object({
  name: z.string().optional(),
}).passthrough();

const NoteEntrySchema = z.object({
  note: z.string(),
}).passthrough();

export const ContactCardSchema = z.object({
  "@type": z.literal("Card").optional(),
  id: z.string().optional(),
  uid: z.string().optional(),
  kind: z.string().optional(),
  name: CardNameSchema.optional(),
  emails: z.record(z.string(), EmailEntrySchema).optional(),
  phones: z.record(z.string(), PhoneEntrySchema).optional(),
  addresses: z.record(z.string(), AddressEntrySchema).optional(),
  organizations: z.record(z.string(), OrganizationEntrySchema).optional(),
  notes: z.record(z.string(), NoteEntrySchema).optional(),
}).passthrough() as unknown as z.ZodType<ContactCard>;

/** ContactCard/query filter (typed after the RFC 9610 digest; keep text/email/name for now). */
export interface ContactFilterCondition {
  text?: string;
  email?: string;
  name?: string;
  uid?: string;
  [key: string]: unknown;
}

export const ContactFilterConditionSchema = z.object({
  text: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
  uid: z.string().optional(),
}).passthrough() as unknown as z.ZodType<ContactFilterCondition>;
