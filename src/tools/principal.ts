import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import type { AccountContext } from "../jmap.ts";
import { PRINCIPAL_USING } from "../jmap.ts";
import type { ToolContext } from "../server/context.ts";
import {
  accountIdSchema,
  confirmSchema,
  idsSchema,
  objectSchema,
  propertiesSchema,
  registerJsonTool,
  requireMutationConfirmation,
  setArgs,
} from "./common.ts";

const mutationShape = {
  account_id: accountIdSchema,
  if_in_state: z.string().optional(),
  ...confirmSchema,
};

export function registerPrincipalTools(server: McpServer, config: EnvConfig): void {
  registerParticipantIdentityTools(server, config);

  registerJsonTool(
    server,
    config,
    "principal_search",
    "Search principals with Principal/query.",
    {
      account_id: accountIdSchema,
      query: z.string().optional(),
      calendar_address: z.string().optional(),
      filter: objectSchema.optional(),
      sort: z.array(objectSchema).optional(),
      position: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
      fetch: z.boolean().default(false).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[1],
        args.account_id,
      );
      const filter = {
        ...(args.filter ?? {}),
        ...(args.query ? { text: args.query } : {}),
        ...(args.calendar_address ? { calendarAddress: args.calendar_address } : {}),
      };
      const query = await context.jmap.single(account, PRINCIPAL_USING, "Principal/query", {
        accountId: account.accountId,
        filter,
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (!args.fetch) return { query };
      const ids = asIds(query.ids);
      const get = ids.length
        ? await context.jmap.single(account, PRINCIPAL_USING, "Principal/get", {
          accountId: account.accountId,
          ids,
          ...(args.properties ? { properties: args.properties } : {}),
        })
        : { accountId: account.accountId, list: [], notFound: [] };
      return { query, get };
    },
  );

  registerJsonTool(
    server,
    config,
    "principal_get",
    "Read principals with Principal/get.",
    {
      account_id: accountIdSchema,
      ids: idsSchema.optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, PRINCIPAL_USING, "Principal/get", {
        accountId: account.accountId,
        ids: args.ids ?? null,
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "principal_availability_get",
    "Read free/busy for known principal ids with Principal/getAvailability.",
    {
      account_id: accountIdSchema,
      principal_ids: idsSchema,
      utc_start: z.string(),
      utc_end: z.string(),
      show_details: z.boolean().optional(),
      event_properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[1],
        args.account_id,
      );
      return await getAvailabilityForIds(context, account, args.principal_ids, {
        utcStart: args.utc_start,
        utcEnd: args.utc_end,
        showDetails: args.show_details,
        eventProperties: args.event_properties,
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "availability_get",
    "Resolve calendar addresses if needed, then call Principal/getAvailability.",
    {
      account_id: accountIdSchema,
      principal_ids: z.array(z.string()).optional(),
      calendar_addresses: z.array(z.string()).optional(),
      utc_start: z.string(),
      utc_end: z.string(),
      show_details: z.boolean().optional(),
      event_properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[1],
        args.account_id,
      );
      const resolvedIds = new Set(args.principal_ids ?? []);
      const resolution: Record<string, unknown> = {};
      for (const address of args.calendar_addresses ?? []) {
        const query = await context.jmap.single(account, PRINCIPAL_USING, "Principal/query", {
          accountId: account.accountId,
          filter: { calendarAddress: address },
          limit: 10,
        });
        resolution[address] = query;
        for (const id of asIds(query.ids)) resolvedIds.add(id);
      }
      if (!resolvedIds.size) {
        throw new Error("No principal ids resolved for availability request");
      }
      const availability = await getAvailabilityForIds(context, account, [...resolvedIds], {
        utcStart: args.utc_start,
        utcEnd: args.utc_end,
        showDetails: args.show_details,
        eventProperties: args.event_properties,
      });
      return { resolution, availability };
    },
  );
}

function registerParticipantIdentityTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "participant_identity_list",
    "List participant identities with ParticipantIdentity/get.",
    {
      account_id: accountIdSchema,
      ids: z.array(z.string()).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[2],
        args.account_id,
      );
      return await context.jmap.single(account, PRINCIPAL_USING, "ParticipantIdentity/get", {
        accountId: account.accountId,
        ids: args.ids ?? null,
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "participant_identity_create",
    "Create a participant identity with ParticipantIdentity/set create.",
    {
      ...mutationShape,
      identity: objectSchema,
      create_id: z.string().default("new").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[2],
        args.account_id,
      );
      const create = { [args.create_id ?? "new"]: args.identity };
      const payload = setArgs(account.accountId, { create, ifInState: args.if_in_state });
      const guard = await requireMutationConfirmation(context, {
        toolName: "participant_identity_create",
        accountId: account.accountId,
        operation: "create",
        resourceKind: "ParticipantIdentity",
        resourceIds: Object.keys(create),
        payload,
        summary: "Create a participant identity.",
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(
        account,
        PRINCIPAL_USING,
        "ParticipantIdentity/set",
        payload,
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "participant_identity_update",
    "Update a participant identity with ParticipantIdentity/set update.",
    {
      ...mutationShape,
      identity_id: z.string(),
      patch: objectSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[2],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        update: { [args.identity_id]: args.patch },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "participant_identity_update",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "ParticipantIdentity",
        resourceIds: [args.identity_id],
        payload,
        summary: `Update participant identity ${args.identity_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(
        account,
        PRINCIPAL_USING,
        "ParticipantIdentity/set",
        payload,
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "participant_identity_delete",
    "Delete participant identities with ParticipantIdentity/set destroy.",
    {
      ...mutationShape,
      ids: idsSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[2],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        destroy: args.ids,
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "participant_identity_delete",
        accountId: account.accountId,
        operation: "delete",
        resourceKind: "ParticipantIdentity",
        resourceIds: args.ids,
        payload,
        summary: `Delete ${args.ids.length} participant identity/identities.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(
        account,
        PRINCIPAL_USING,
        "ParticipantIdentity/set",
        payload,
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "participant_identity_set_default",
    "Set default participant identity using the ParticipantIdentity/set default-identity option.",
    {
      ...mutationShape,
      identity_id: z.string(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[2],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        extra: { onSuccessSetDefaultIdentity: args.identity_id },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "participant_identity_set_default",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "ParticipantIdentity",
        resourceIds: [args.identity_id],
        payload,
        summary: `Set participant identity ${args.identity_id} as default.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(
        account,
        PRINCIPAL_USING,
        "ParticipantIdentity/set",
        payload,
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "participant_identity_changes",
    "Read participant identity changes with ParticipantIdentity/changes.",
    {
      account_id: accountIdSchema,
      since_state: z.string(),
      max_changes: z.number().int().positive().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        PRINCIPAL_USING[2],
        args.account_id,
      );
      return await context.jmap.single(account, PRINCIPAL_USING, "ParticipantIdentity/changes", {
        accountId: account.accountId,
        sinceState: args.since_state,
        ...(args.max_changes ? { maxChanges: args.max_changes } : {}),
      });
    },
  );
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

async function getAvailabilityForIds(
  context: ToolContext,
  account: AccountContext,
  ids: string[],
  args: {
    utcStart: string;
    utcEnd: string;
    showDetails?: boolean;
    eventProperties?: string[];
  },
): Promise<Record<string, unknown>> {
  const responses: Record<string, unknown> = {};
  for (const id of ids) {
    responses[id] = await context.jmap.single(
      account,
      PRINCIPAL_USING,
      "Principal/getAvailability",
      {
        accountId: account.accountId,
        id,
        utcStart: args.utcStart,
        utcEnd: args.utcEnd,
        ...(args.showDetails !== undefined ? { showDetails: args.showDetails } : {}),
        ...(args.eventProperties ? { eventProperties: args.eventProperties } : {}),
      },
    );
  }
  return { accountId: account.accountId, list: responses };
}
