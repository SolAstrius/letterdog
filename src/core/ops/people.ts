/**
 * people ops (JSContact contacts + RFC 9670 principals) — builder ops:aux (B10-ops-misc).
 *
 * Ops (docs/v2-contracts.md §ops inventory):
 * - people.search   → search_people    [mcp, cli]  none  readOnly  projection: person
 *     ONE ranked search over JSContact cards (urn:ietf:params:jmap:contacts) AND principals
 *     (urn:ietf:params:jmap:principals). Merged, de-duplicated, ranked list of
 *     {id, kind, name, emails, calendar_address, principal_type, source}. This is where
 *     "invite Daria" / "mail Ivan" resolves.
 * - contact.read    → read_contacts     [mcp, cli]  none  readOnly  projection: contact
 *     full JSContact cards by ids array (ContactCard/get).
 * - contact.search  → search_contacts   [cli]       none  readOnly  projection: contact
 *     pure ContactCard/query (no principals), typed filter.
 *
 * Live-probed method/property shapes (2026-07, Stalwart v0.16.11, account "b"):
 *   ContactCard/query|get, Principal/query|get. Principal/get list = {id, type, name,
 *   description, email, capabilities?} — capabilities[urn:...:calendars].calendarAddress carries
 *   the invite URI when present (this instance's individual principals omit it, so we fall back to
 *   `mailto:<email>`).
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import { CAPABILITIES, USING } from "../jmap/session.ts";
import { envelopeFromGet } from "../jmap/envelopes.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { ref } from "../jmap/client.ts";
import type { AccountRef } from "../jmap/client.ts";
import { project } from "../projections.ts";
import type { ProjectionMode } from "../projections.ts";
import type { BriefPerson } from "../projections.ts";
import type { ContactCard, ContactFilterCondition } from "../schemas/jscontact.ts";
import { ContactFilterConditionSchema } from "../schemas/jscontact.ts";
import type { Principal } from "../jmap/types.ts";
import {
  AccountIdSchema,
  FieldsSchema,
  IdsSchema,
  LimitSchema,
  ProjectionSchema,
} from "../schemas/common.ts";

// --- shared helpers -----------------------------------------------------------------------------

/** Derive the caller's ProjectionContext extras (fields) — people ops need no id maps. */
function projectionCtx(args: { fields?: string[] }) {
  return { fields: args.fields };
}

/** Strip a leading mailto: from a calendar URI, lowercased. */
function bareAddress(uri: string | undefined | null): string | undefined {
  if (!uri) return undefined;
  return uri.replace(/^mailto:/i, "").toLowerCase();
}

/** Principal calendarAddress from capabilities, or mailto:<email> fallback. */
function principalCalendarAddress(p: Principal): string | undefined {
  const cal = p.capabilities?.[CAPABILITIES.calendars];
  const addr = cal?.["calendarAddress"];
  if (typeof addr === "string" && addr.length > 0) return addr;
  if (p.email) return `mailto:${p.email}`;
  return undefined;
}

/** Flatten a contact card's emails (address values only). */
function contactEmails(card: ContactCard): string[] {
  if (!card.emails) return [];
  const out: string[] = [];
  for (const e of Object.values(card.emails)) {
    if (e?.address) out.push(e.address);
  }
  return out;
}

function contactDisplayName(card: ContactCard): string | undefined {
  const n = card.name;
  if (n?.full) return n.full;
  if (n?.components && n.components.length > 0) {
    return n.components.map((c) => c.value).filter(Boolean).join(" ") || undefined;
  }
  return undefined;
}

// --- people.search ------------------------------------------------------------------------------

const PeopleSearchShape = {
  query: z.string().min(1).describe(
    "Free-text search matched against contact names/emails and principal names/emails.",
  ),
  include_contacts: z.boolean().default(true).describe("Search JSContact address-book cards."),
  include_principals: z.boolean().default(true).describe(
    "Search RFC 9670 principals (people/resources you can invite/schedule with).",
  ),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
  limit: LimitSchema,
};

/** A merged, ranked person row before projection. */
interface RankedPerson {
  raw: ContactCard | Principal;
  kind: "contact" | "principal";
  score: number;
  /** dedup key = first email / calendarAddress / id, lowercased. */
  dedupKey: string;
  source: "contacts" | "principals";
}

/** Rank a person against the query terms (higher = better). */
function scorePerson(
  query: string,
  name: string | undefined,
  emails: string[],
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let score = 0;
  const nm = (name ?? "").toLowerCase();
  if (nm === q) score += 100;
  else if (nm.startsWith(q)) score += 60;
  else if (nm.includes(q)) score += 30;
  for (const e of emails) {
    const el = e.toLowerCase();
    if (el === q) score += 90;
    else if (el.startsWith(q)) score += 50;
    else if (el.includes(q)) score += 25;
    // local-part match (before @)
    const local = el.split("@")[0];
    if (local === q) score += 40;
  }
  return score;
}

/** Generic Foo/query → Foo/get back-referenced fetch, returning the `list`. */
async function queryThenGet<T>(
  ctx: OpContext,
  acct: AccountRef,
  using: readonly string[],
  type: string,
  queryArgs: Record<string, unknown>,
): Promise<T[]> {
  const result = await ctx.jmap.request(authOf(ctx), [...using], [
    [`${type}/query`, { accountId: acct.accountId, ...queryArgs }, "q"],
    [`${type}/get`, {
      accountId: acct.accountId,
      "#ids": ref("q", `${type}/query`, "/ids"),
    }, "g"],
  ]);
  const getRes = result.methodResponses.find((r) => r[2] === "g");
  if (!getRes || getRes[0] === "error") return [];
  const env = envelopeFromGet<T>(getRes[1]);
  return env.items;
}

/** Extract the JmapAuth slice from the op context actor. */
function authOf(ctx: OpContext): { authorization: string; fingerprint: string } {
  return { authorization: ctx.actor.authorization, fingerprint: ctx.actor.fingerprint };
}

const peopleSearch = defineOp({
  name: "people.search",
  mcpName: "search_people",
  description:
    "Letterdog (the user's personal self-hosted contacts + directory). Resolve a person by name " +
    "or email into their address(es) and calendar invite URI — the lookup step before mailing or " +
    "inviting someone. Searches BOTH the JSContact address book and the JMAP principals directory " +
    "(schedulable people/resources) and returns one ranked list: {id, kind, name, emails, " +
    "calendar_address, principal_type, source}. Use the returned email for send_email and the " +
    "calendar_address for create_events participants / respond_to_event.",
  input: PeopleSearchShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "person",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const mode = args.projection as ProjectionMode;
    const pctx = projectionCtx(args);

    const ranked: RankedPerson[] = [];

    if (args.include_contacts) {
      // Contacts live under the mail/contacts account (calendars capability shares it on Stalwart).
      const acct = await ctx.jmap.resolveAccount(
        authOf(ctx),
        CAPABILITIES.contacts,
        args.account_id,
      );
      const cards = await queryThenGet<ContactCard>(
        ctx,
        acct,
        [...USING.contacts],
        "ContactCard",
        { filter: { text: args.query } as ContactFilterCondition, limit: args.limit },
      );
      for (const card of cards) {
        const emails = contactEmails(card);
        const name = contactDisplayName(card);
        ranked.push({
          raw: card,
          kind: "contact",
          score: scorePerson(args.query, name, emails),
          dedupKey: (emails[0] ?? card.id ?? card.uid ?? "").toLowerCase(),
          source: "contacts",
        });
      }
    }

    if (args.include_principals) {
      const acct = await ctx.jmap.resolveAccount(
        authOf(ctx),
        CAPABILITIES.principals,
        args.account_id,
      );
      const principals = await queryThenGet<Principal>(
        ctx,
        acct,
        [...USING.principals],
        "Principal",
        { limit: args.limit },
      );
      const q = args.query.trim().toLowerCase();
      for (const p of principals) {
        const emails = p.email ? [p.email] : [];
        const score = scorePerson(args.query, p.name, emails);
        // Principal/query has no text filter guarantee — filter client-side by non-zero score.
        if (score === 0 && q.length > 0) continue;
        ranked.push({
          raw: p,
          kind: "principal",
          score,
          dedupKey: bareAddress(principalCalendarAddress(p)) ?? p.email?.toLowerCase() ?? p.id,
          source: "principals",
        });
      }
    }

    // De-duplicate: a contact and a principal sharing an address collapse to one row, keeping the
    // principal (it carries the calendar_address / schedulability) but preferring the higher score.
    const byKey = new Map<string, RankedPerson>();
    for (const person of ranked) {
      const existing = byKey.get(person.dedupKey);
      if (!existing) {
        byKey.set(person.dedupKey, person);
        continue;
      }
      // Principal wins the merge (schedulable); otherwise the higher score.
      const winner = existing.kind === "principal"
        ? existing
        : person.kind === "principal"
        ? person
        : (person.score > existing.score ? person : existing);
      winner.score = Math.max(existing.score, person.score);
      byKey.set(person.dedupKey, winner);
    }

    const merged = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, args.limit);

    const items = merged.map((m) => {
      const projected = project("person", m.raw, mode, { ...pctx }) as
        | BriefPerson
        | Record<string, unknown>;
      if (mode === "brief" && projected && typeof projected === "object") {
        (projected as Record<string, unknown>).source = m.source;
        // Ensure a calendar_address on principals even when the projector could not derive one.
        if (m.kind === "principal" && !(projected as BriefPerson).calendar_address) {
          const ca = principalCalendarAddress(m.raw as Principal);
          if (ca) (projected as BriefPerson).calendar_address = ca;
        }
      }
      return projected;
    });

    const envelope: Envelope<unknown> = { items };
    return envelope;
  },
});

// --- contact.read -------------------------------------------------------------------------------

const ContactReadShape = {
  ids: IdsSchema.describe("ContactCard ids to fetch (batch-first — singular use = array of one)."),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

const contactRead = defineOp({
  name: "contact.read",
  mcpName: "read_contacts",
  description:
    "Read full JSContact contact cards by id from Letterdog's address book. Follow-up to " +
    "search_people / search_contacts when you need phones, addresses, organizations or notes " +
    "beyond the ranked-search summary. Batch: pass an ids array.",
  input: ContactReadShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "contact",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const mode = args.projection as ProjectionMode;
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.contacts, args.account_id);
    const res = await ctx.jmap.getChunked(authOf(ctx), [...USING.contacts], "ContactCard/get", {
      accountId: acct.accountId,
      ids: args.ids,
    });
    const env = envelopeFromGet<ContactCard>(res);
    const items = env.items.map((c) => project("contact", c, mode, projectionCtx(args)));
    const envelope: Envelope<unknown> = { items };
    if (env.not_found) envelope.not_found = env.not_found;
    if (env.state) envelope.state = env.state;
    return envelope;
  },
});

// --- contact.search (CLI) -----------------------------------------------------------------------

const ContactSearchShape = {
  query: z.string().optional().describe("Free-text (maps to the ContactCard/query `text` filter)."),
  filter: z.record(z.string(), z.unknown()).optional().describe(
    "Typed ContactCard/query FilterCondition (text|email|name|uid), spec camelCase inside.",
  ),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
  limit: LimitSchema,
  calculate_total: z.boolean().default(false).describe("Opt-in Foo/query total (can be slow)."),
};

const contactSearch = defineOp({
  name: "contact.search",
  mcpName: "search_contacts",
  description:
    "Search Letterdog's JSContact address book only (no principals) with a typed ContactCard/query " +
    "filter. CLI-side counterpart to the merged search_people; use when you want raw contact cards " +
    "without directory principals in the results.",
  input: ContactSearchShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "contact",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const mode = args.projection as ProjectionMode;
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.contacts, args.account_id);

    let filter: ContactFilterCondition | undefined;
    if (args.filter) {
      filter = ContactFilterConditionSchema.parse(args.filter);
    } else if (args.query) {
      filter = { text: args.query };
    }

    const queryArgs: Record<string, unknown> = { accountId: acct.accountId, limit: args.limit };
    if (filter) queryArgs.filter = filter;
    if (args.calculate_total) queryArgs.calculateTotal = true;

    const result = await ctx.jmap.request(authOf(ctx), [...USING.contacts], [
      ["ContactCard/query", queryArgs, "q"],
      ["ContactCard/get", {
        accountId: acct.accountId,
        "#ids": ref("q", "ContactCard/query", "/ids"),
      }, "g"],
    ]);
    const queryRes = result.methodResponses.find((r) => r[2] === "q");
    const getRes = result.methodResponses.find((r) => r[2] === "g");
    if (!getRes || getRes[0] === "error") {
      throw new Error("ContactCard/get failed");
    }
    const env = envelopeFromGet<ContactCard>(getRes[1]);
    const items = env.items.map((c) => project("contact", c, mode, projectionCtx(args)));
    const envelope: Envelope<unknown> = { items };
    if (queryRes && queryRes[0] !== "error" && typeof queryRes[1].total === "number") {
      envelope.total = queryRes[1].total as number;
    }
    if (env.state) envelope.state = env.state;
    return envelope;
  },
});

export const ops: OpDefinition[] = [peopleSearch, contactRead, contactSearch];
