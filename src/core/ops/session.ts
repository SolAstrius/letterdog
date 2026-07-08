/**
 * session ops — builder: ops:mail-read (owns session.ts + mail_read.ts per task assignment).
 *
 * Ops implemented (see docs/v2-contracts.md §ops inventory):
 * - session.whoami → whoami            [mcp, cli]  none  readOnly  projection: session
 *   Session, accounts, capabilities + key limits, mail identities, participant identities,
 *   default calendar. ONE JMAP request batching Identity/get + ParticipantIdentity/get +
 *   Calendar/get alongside the cached session object.
 * - identity.list → list_identities    [cli]       none  readOnly  projection: identity
 *   Mail Identity/get (ids: null) + ParticipantIdentity/get (ids: null).
 */
import { defineOp, type OpContext, type OpDefinition } from "./registry.ts";
import { AccountIdSchema, FieldsSchema, ProjectionSchema } from "../schemas/common.ts";
import { CAPABILITIES, coreLimits } from "../jmap/session.ts";
import { expectResponse } from "../jmap/envelopes.ts";
import type { Identity, ParticipantIdentity } from "../jmap/types.ts";
import { projectIdentity, type ProjectionMode } from "../projections.ts";

/** whoami is a curated MCP tool; identity.list is CLI-only. Both are read-only, ungated. */

const whoamiInput = {
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

const listIdentitiesInput = {
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

/**
 * Build the `using` set for whoami. The account holds mail + submission + calendars + principals,
 * so we request everything whoami touches in one shot. Falls back gracefully: methods for absent
 * capabilities simply error in their slot and we omit that section.
 */
const WHOAMI_USING = [
  CAPABILITIES.core,
  CAPABILITIES.mail,
  CAPABILITIES.submission,
  CAPABILITIES.calendars,
  CAPABILITIES.principals,
];

interface WhoamiCalendar {
  id: string;
  name?: string;
  isDefault?: boolean;
}

/** Pull the named /get list out of a batched response, tolerating a per-method error slot. */
function safeList<T>(
  responses: Array<[string, Record<string, unknown>, string]>,
  method: string,
  callId: string,
): T[] {
  try {
    const res = expectResponse(responses, method, callId);
    return Array.isArray(res.list) ? res.list as T[] : [];
  } catch {
    // A capability the account lacks (or a server that rejects ids:null) shouldn't sink whoami.
    return [];
  }
}

async function whoamiHandler(
  args: {
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const account = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.mail,
    args.account_id,
  );
  const { session, accountId } = account;

  const result = await ctx.jmap.request(ctx.actor, WHOAMI_USING, [
    ["Identity/get", { accountId, ids: null }, "i"],
    ["ParticipantIdentity/get", { accountId, ids: null }, "p"],
    [
      "Calendar/get",
      { accountId, ids: null, properties: ["id", "name", "isDefault"] },
      "c",
    ],
  ]);
  const responses = result.methodResponses;

  const identities = safeList<Identity>(responses, "Identity/get", "i");
  const participantIdentities = safeList<ParticipantIdentity>(
    responses,
    "ParticipantIdentity/get",
    "p",
  );
  const calendars = safeList<WhoamiCalendar>(responses, "Calendar/get", "c");
  const defaultCalendar = calendars.find((c) => c.isDefault) ?? calendars[0];

  const limits = coreLimits(session);
  const projectIdentityBrief = (id: Identity) =>
    projectIdentity(id, args.projection, { fields: args.fields });

  // The whoami envelope is bespoke (projection "session" passes through untouched). It leads with
  // routing-useful identity so the model can pick a from-address / RSVP identity without a follow-up.
  const whoami = {
    account_id: accountId,
    username: session.username,
    accounts: Object.entries(session.accounts ?? {}).map(([id, a]) => ({
      id,
      name: a.name,
      is_personal: a.isPersonal,
      is_read_only: a.isReadOnly,
    })),
    primary_accounts: session.primaryAccounts,
    capabilities: Object.keys(session.capabilities ?? {}),
    limits: {
      max_size_upload: limits.maxSizeUpload,
      max_size_request: limits.maxSizeRequest,
      max_calls_in_request: limits.maxCallsInRequest,
      max_objects_in_get: limits.maxObjectsInGet,
      max_objects_in_set: limits.maxObjectsInSet,
    },
    identities: identities.map(projectIdentityBrief),
    participant_identities: participantIdentities.map((p) => ({
      id: p.id,
      name: p.name,
      calendar_address: p.calendarAddress,
      is_default: p.isDefault,
    })),
    default_calendar: defaultCalendar
      ? { id: defaultCalendar.id, name: defaultCalendar.name }
      : undefined,
  };

  return { items: [whoami] };
}

async function listIdentitiesHandler(
  args: {
    account_id?: string;
    projection: ProjectionMode;
    fields?: string[];
  },
  ctx: OpContext,
): Promise<unknown> {
  const { accountId } = await ctx.jmap.resolveAccount(
    ctx.actor,
    CAPABILITIES.submission,
    args.account_id,
  );

  const result = await ctx.jmap.request(
    ctx.actor,
    [CAPABILITIES.core, CAPABILITIES.submission, CAPABILITIES.calendars],
    [
      ["Identity/get", { accountId, ids: null }, "i"],
      ["ParticipantIdentity/get", { accountId, ids: null }, "p"],
    ],
  );
  const responses = result.methodResponses;

  const mailIdentities = safeList<Identity>(responses, "Identity/get", "i");
  const participantIdentities = safeList<ParticipantIdentity>(
    responses,
    "ParticipantIdentity/get",
    "p",
  );

  // Mail identities go through the identity projector; participant identities are a distinct
  // (calendar-side) shape surfaced alongside so `list_identities` covers both invite surfaces.
  const items = [
    ...mailIdentities.map((id) => ({
      kind: "mail" as const,
      ...(projectIdentity(id, args.projection, { fields: args.fields }) as Record<string, unknown>),
    })),
    ...participantIdentities.map((p) => ({
      kind: "participant" as const,
      id: p.id,
      name: p.name,
      calendar_address: p.calendarAddress,
      is_default: p.isDefault,
    })),
  ];

  return { items };
}

export const ops: OpDefinition[] = [
  defineOp({
    name: "session.whoami",
    mcpName: "whoami",
    description:
      "Identify the connected Letterdog account (the user's personal self-hosted mail/calendar/" +
      "contacts over JMAP). Returns the account id, username, capabilities and key server limits, " +
      "the mail sending identities (from-addresses), the calendar participant identities " +
      "(RSVP/invite addresses), and the default calendar. Call this first to learn which " +
      "from-address or RSVP identity to use before sending mail or responding to events. " +
      "read-only.",
    input: whoamiInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "session",
    surfaces: ["mcp", "cli"],
    handler: whoamiHandler as OpDefinition["handler"],
  }),
  defineOp({
    name: "identity.list",
    mcpName: "list_identities",
    description:
      "List the account's mail sending identities (Identity/get) and calendar participant " +
      "identities (ParticipantIdentity/get) — the from-addresses available to send_email/reply " +
      'and the calendarAddress values used to RSVP. Each row carries `kind: "mail"|"participant"`. ' +
      "read-only. CLI: `letterdog identity list`.",
    input: listIdentitiesInput,
    annotations: { readOnly: true },
    confirmClass: "none",
    projection: "identity",
    surfaces: ["cli"],
    handler: listIdentitiesHandler as OpDefinition["handler"],
  }),
];
