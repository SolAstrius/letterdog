/**
 * JSContact Card (RFC 9553, JMAP contacts RFC 9610) Zod schemas — scoped to the Card-level
 * properties the PIM needs (design "Open questions": names, emails, phones, addresses,
 * organizations, notes, linked principals).
 * CONTRACT STUB — TODO(builder: B3-schemas-calendar). A dedicated RFC 9553/9610 digest pass
 * into docs/rfc-notes/ happens before deep Card work; keep this tolerant (passthrough) until
 * then.
 */
import { z } from "zod";
import { todoSchema } from "./common.ts";

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

export const ContactCardSchema: z.ZodType<ContactCard> = todoSchema(
  "schemas/jscontact ContactCardSchema",
);

/** ContactCard/query filter (typed after the RFC 9610 digest; keep text/email/name for now). */
export interface ContactFilterCondition {
  text?: string;
  email?: string;
  name?: string;
  uid?: string;
  [key: string]: unknown;
}

export const ContactFilterConditionSchema: z.ZodType<ContactFilterCondition> = todoSchema(
  "schemas/jscontact ContactFilterConditionSchema",
);
