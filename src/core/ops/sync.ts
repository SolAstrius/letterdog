/**
 * sync primitive ops — builder ops:aux (B10-ops-misc). CLI-only, and registered ONLY when
 * config.enableSyncTools is true (frontends filter by the `sync.` name prefix). These are the
 * demoted /changes // /queryChanges primitives — CLI territory for local mirrors and scripts.
 *
 * Ops (docs/v2-contracts.md §ops inventory):
 * - sync.changes       → sync_changes        [cli]  none  readOnly  projection: raw
 *     Foo/changes for a `type` (Email|Mailbox|Thread|CalendarEvent|Calendar|ContactCard|…) with
 *     since_state, max_changes. Surfaces cannotCalculateChanges as a typed error telling the
 *     caller to full-resync.
 * - sync.query_changes → sync_query_changes  [cli]  none  readOnly  projection: raw
 *     Foo/queryChanges with filter/sort/since_query_state/up_to_id.
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import { CAPABILITIES } from "../jmap/session.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { AccountIdSchema } from "../schemas/common.ts";

function authOf(ctx: OpContext): { authorization: string; fingerprint: string } {
  return { authorization: ctx.actor.authorization, fingerprint: ctx.actor.fingerprint };
}

/**
 * Map a datatype to the capability that must be in `using` and the account capability required to
 * resolve it. Covers the common Email/Calendar/Contacts/File datatypes; unknown types fall back to
 * the core+mail set (the caller can still target any type the account supports).
 */
function usingForType(type: string): { using: string[]; capability?: string } {
  const t = type.split("/")[0];
  switch (t) {
    case "Email":
    case "Mailbox":
    case "Thread":
    case "EmailSubmission":
      return { using: [CAPABILITIES.core, CAPABILITIES.mail], capability: CAPABILITIES.mail };
    case "Calendar":
    case "CalendarEvent":
    case "CalendarEventNotification":
    case "ParticipantIdentity":
      return {
        using: [CAPABILITIES.core, CAPABILITIES.calendars],
        capability: CAPABILITIES.calendars,
      };
    case "ContactCard":
    case "AddressBook":
      return {
        using: [CAPABILITIES.core, CAPABILITIES.contacts],
        capability: CAPABILITIES.contacts,
      };
    case "FileNode":
      return {
        using: [CAPABILITIES.core, CAPABILITIES.fileNode],
        capability: CAPABILITIES.fileNode,
      };
    case "Principal":
      return {
        using: [CAPABILITIES.core, CAPABILITIES.principals],
        capability: CAPABILITIES.principals,
      };
    default:
      return { using: [CAPABILITIES.core, CAPABILITIES.mail] };
  }
}

const TYPE_RE = /^[A-Za-z][A-Za-z0-9]*$/;

// --- sync.changes -------------------------------------------------------------------------------

const SyncChangesShape = {
  type: z.string().regex(TYPE_RE).describe(
    "JMAP datatype: Email | Mailbox | Thread | Calendar | CalendarEvent | ContactCard | FileNode | …",
  ),
  since_state: z.string().min(1).describe("The state string from a prior /get or /changes call."),
  max_changes: z.number().int().min(1).optional().describe(
    "Cap the number of changed ids returned; server may return hasMoreChanges:true.",
  ),
  account_id: AccountIdSchema,
};

const syncChanges = defineOp({
  name: "sync.changes",
  mcpName: "sync_changes",
  description:
    "Foo/changes: what created/updated/destroyed since a state string, for local mirroring. Pass the " +
    "datatype and since_state; page with max_changes (hasMoreChanges in the response). If the server " +
    "returns cannotCalculateChanges this op errors telling you to full-resync (re-fetch from " +
    "scratch and take a new state). Requires ENABLE_SYNC_TOOLS. CLI-only.",
  input: SyncChangesShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { using, capability } = usingForType(args.type);
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), capability, args.account_id);
    const method = `${args.type}/changes`;
    const methodArgs: Record<string, unknown> = {
      accountId: acct.accountId,
      sinceState: args.since_state,
    };
    if (args.max_changes !== undefined) methodArgs.maxChanges = args.max_changes;

    const result = await ctx.jmap.request(authOf(ctx), using, [[method, methodArgs, "c1"]]);
    const slot = result.methodResponses.find((r) => r[2] === "c1");
    if (slot && slot[0] === "error") {
      const err = slot[1] as { type?: string; description?: string };
      if (err.type === "cannotCalculateChanges") {
        throw new Error(
          `cannotCalculateChanges for ${args.type}: the since_state is too old. Full-resync — ` +
            `re-fetch ${args.type} from scratch and adopt the fresh state.`,
        );
      }
      throw new Error(`${method} error: ${err.type ?? "unknown"} ${err.description ?? ""}`.trim());
    }
    const envelope: Envelope<unknown> = { items: [slot ? slot[1] : {}] };
    return envelope;
  },
});

// --- sync.query_changes -------------------------------------------------------------------------

const SyncQueryChangesShape = {
  type: z.string().regex(TYPE_RE).describe("JMAP datatype supporting /queryChanges (e.g. Email)."),
  since_query_state: z.string().min(1).describe("The queryState from a prior /query call."),
  filter: z.record(z.string(), z.unknown()).optional().describe(
    "The SAME FilterCondition/operator tree used in the original /query (spec camelCase).",
  ),
  sort: z.array(z.record(z.string(), z.unknown())).optional().describe(
    "The SAME Comparator[] used in the original /query.",
  ),
  max_changes: z.number().int().min(1).optional().describe("Cap the number of changes returned."),
  up_to_id: z.string().optional().describe(
    "Only report changes affecting positions up to this id.",
  ),
  calculate_total: z.boolean().default(false).describe("Opt-in total in the response."),
  account_id: AccountIdSchema,
};

const syncQueryChanges = defineOp({
  name: "sync.query_changes",
  mcpName: "sync_query_changes",
  description:
    "Foo/queryChanges: how a query result set shifted since a queryState — added/removed ids for an " +
    "incremental view. Pass the SAME filter and sort as the original /query, plus since_query_state. " +
    "Requires ENABLE_SYNC_TOOLS. CLI-only.",
  input: SyncQueryChangesShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { using, capability } = usingForType(args.type);
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), capability, args.account_id);
    const method = `${args.type}/queryChanges`;
    const methodArgs: Record<string, unknown> = {
      accountId: acct.accountId,
      sinceQueryState: args.since_query_state,
    };
    if (args.filter) methodArgs.filter = args.filter;
    if (args.sort) methodArgs.sort = args.sort;
    if (args.max_changes !== undefined) methodArgs.maxChanges = args.max_changes;
    if (args.up_to_id !== undefined) methodArgs.upToId = args.up_to_id;
    if (args.calculate_total) methodArgs.calculateTotal = true;

    const result = await ctx.jmap.request(authOf(ctx), using, [[method, methodArgs, "c1"]]);
    const slot = result.methodResponses.find((r) => r[2] === "c1");
    if (slot && slot[0] === "error") {
      const err = slot[1] as { type?: string; description?: string };
      if (err.type === "cannotCalculateChanges") {
        throw new Error(
          `cannotCalculateChanges for ${args.type}/query: since_query_state too old. Re-run the ` +
            `original /query and adopt its fresh queryState.`,
        );
      }
      throw new Error(`${method} error: ${err.type ?? "unknown"} ${err.description ?? ""}`.trim());
    }
    const envelope: Envelope<unknown> = { items: [slot ? slot[1] : {}] };
    return envelope;
  },
});

export const ops: OpDefinition[] = [syncChanges, syncQueryChanges];
