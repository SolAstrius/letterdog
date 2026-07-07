import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import type { AccountContext } from "../jmap.ts";
import { CALENDAR_USING } from "../jmap.ts";
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

const queryShape = {
  account_id: accountIdSchema,
  filter: objectSchema.optional(),
  sort: z.array(objectSchema).optional(),
  position: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).optional(),
  anchor: z.string().optional(),
  anchorOffset: z.number().int().optional(),
  calculateTotal: z.boolean().optional(),
};

const mutationShape = {
  account_id: accountIdSchema,
  if_in_state: z.string().optional(),
  ...confirmSchema,
};

export function registerCalendarTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "calendar_list",
    "List calendars with Calendar/query followed by Calendar/get.",
    {
      ...queryShape,
      properties: propertiesSchema,
      fetch: z.boolean().default(true).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const query = await context.jmap.single(account, CALENDAR_USING, "Calendar/query", {
        accountId: account.accountId,
        ...pickQuery(args),
      });
      if (args.fetch === false) return { query };
      const ids = asIds(query.ids);
      const get = ids.length
        ? await context.jmap.single(account, CALENDAR_USING, "Calendar/get", {
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
    "calendar_get",
    "Read one or more calendars with Calendar/get.",
    {
      account_id: accountIdSchema,
      ids: idsSchema.optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/get", {
        accountId: account.accountId,
        ids: args.ids ?? null,
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_create",
    "Create a calendar with Calendar/set create.",
    {
      ...mutationShape,
      calendar: objectSchema,
      create_id: z.string().default("new").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const create = { [args.create_id ?? "new"]: args.calendar };
      const payload = setArgs(account.accountId, { create, ifInState: args.if_in_state });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_create",
        accountId: account.accountId,
        operation: "create",
        resourceKind: "Calendar",
        resourceIds: Object.keys(create),
        payload,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: "Create a calendar.",
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_update",
    "Update a calendar with Calendar/set update.",
    {
      ...mutationShape,
      calendar_id: z.string(),
      patch: objectSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        update: { [args.calendar_id]: args.patch },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_update",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "Calendar",
        resourceIds: [args.calendar_id],
        payload,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Update calendar ${args.calendar_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_delete",
    "Delete calendars with Calendar/set destroy.",
    {
      ...mutationShape,
      ids: idsSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        destroy: args.ids,
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_delete",
        accountId: account.accountId,
        operation: "delete",
        resourceKind: "Calendar",
        resourceIds: args.ids,
        payload,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Delete ${args.ids.length} calendar(s).`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_set_default",
    "Set the default calendar using the Calendar/set default-calendar option exposed by Stalwart/JMAP.",
    {
      ...mutationShape,
      calendar_id: z.string(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        extra: { onSuccessSetDefaultCalendar: args.calendar_id },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_set_default",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "Calendar",
        resourceIds: [args.calendar_id],
        payload,
        summary: `Set calendar ${args.calendar_id} as default.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_subscribe",
    "Subscribe/unsubscribe or show/hide a calendar using Calendar/set update.",
    {
      ...mutationShape,
      calendar_id: z.string(),
      isSubscribed: z.boolean().optional(),
      isVisible: z.boolean().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const patch: Record<string, unknown> = {};
      if (args.isSubscribed !== undefined) patch.isSubscribed = args.isSubscribed;
      if (args.isVisible !== undefined) patch.isVisible = args.isVisible;
      const payload = setArgs(account.accountId, {
        update: { [args.calendar_id]: patch },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_subscribe",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "Calendar",
        resourceIds: [args.calendar_id],
        payload,
        summary: `Update subscription flags for calendar ${args.calendar_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_share",
    "Update calendar sharing metadata with Calendar/set update shareWith.",
    {
      ...mutationShape,
      calendar_id: z.string(),
      shareWith: objectSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        update: { [args.calendar_id]: { shareWith: args.shareWith } },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_share",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "Calendar",
        resourceIds: [args.calendar_id],
        payload,
        summary: `Update sharing for calendar ${args.calendar_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_changes",
    "Read calendar state changes with Calendar/changes.",
    {
      account_id: accountIdSchema,
      since_state: z.string(),
      max_changes: z.number().int().positive().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_USING, "Calendar/changes", {
        accountId: account.accountId,
        sinceState: args.since_state,
        ...(args.max_changes ? { maxChanges: args.max_changes } : {}),
      });
    },
  );

  registerEventTools(server, config);
}

function registerEventTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "calendar_event_search",
    "Search events with CalendarEvent/query and optionally fetch matching events.",
    {
      ...queryShape,
      calendar_ids: z.array(z.string()).optional(),
      time_min: z.string().optional(),
      time_max: z.string().optional(),
      query: z.string().optional(),
      expand_recurrences: z.boolean().optional(),
      properties: propertiesSchema,
      fetch: z.boolean().default(true).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const query = await context.jmap.single(
        account,
        CALENDAR_USING,
        "CalendarEvent/query",
        calendarEventQueryArgs({ ...args, accountId: account.accountId }),
      );
      if (args.fetch === false) return { query };
      const ids = asIds(query.ids);
      const get = ids.length
        ? await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/get", {
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
    "calendar_event_get",
    "Read an event with CalendarEvent/get.",
    {
      account_id: accountIdSchema,
      event_id: z.string(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/get", {
        accountId: account.accountId,
        ids: [args.event_id],
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_batch_get",
    "Read multiple events with CalendarEvent/get.",
    {
      account_id: accountIdSchema,
      event_ids: idsSchema,
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/get", {
        accountId: account.accountId,
        ids: args.event_ids,
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_create",
    "Create an event with CalendarEvent/set create.",
    {
      ...mutationShape,
      event: objectSchema,
      create_id: z.string().default("new").optional(),
      sendSchedulingMessages: z.boolean().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const create = { [args.create_id ?? "new"]: args.event };
      const payload = setArgs(account.accountId, {
        create,
        ifInState: args.if_in_state,
        extra: schedulingExtra(args.sendSchedulingMessages),
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_event_create",
        accountId: account.accountId,
        operation: args.sendSchedulingMessages ? "send" : "create",
        resourceKind: "CalendarEvent",
        resourceIds: Object.keys(create),
        payload,
        summary: "Create a calendar event.",
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_update",
    "Update an event with CalendarEvent/set update.",
    {
      ...mutationShape,
      event_id: z.string(),
      patch: objectSchema,
      update_scope: z.enum(["this", "future", "all"]).optional(),
      sendSchedulingMessages: z.boolean().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        update: { [args.event_id]: args.patch },
        ifInState: args.if_in_state,
        extra: {
          ...schedulingExtra(args.sendSchedulingMessages),
          ...(args.update_scope ? { updateScope: args.update_scope } : {}),
        },
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_event_update",
        accountId: account.accountId,
        operation: args.sendSchedulingMessages ? "send" : "update",
        resourceKind: "CalendarEvent",
        resourceIds: [args.event_id],
        payload,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Update event ${args.event_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_delete",
    "Delete one or more events with CalendarEvent/set destroy.",
    {
      ...mutationShape,
      ids: idsSchema,
      scope: z.enum(["this", "future", "all"]).optional(),
      sendSchedulingMessages: z.boolean().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        destroy: args.ids,
        ifInState: args.if_in_state,
        extra: {
          ...schedulingExtra(args.sendSchedulingMessages),
          ...(args.scope ? { destroyScope: args.scope } : {}),
        },
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_event_delete",
        accountId: account.accountId,
        operation: "delete",
        resourceKind: "CalendarEvent",
        resourceIds: args.ids,
        payload,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Delete ${args.ids.length} calendar event(s).`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_copy",
    "Copy an event with CalendarEvent/copy.",
    {
      ...mutationShape,
      source_account_id: z.string().optional(),
      dest_account_id: z.string().optional(),
      event_id: z.string(),
      calendar_id: z.string().optional(),
      patch: objectSchema.optional(),
      create_id: z.string().default("copy").optional(),
    },
    async (args, context) => {
      const source = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.source_account_id ?? args.account_id,
      );
      const destAccountId = args.dest_account_id ?? source.accountId;
      const payload = {
        fromAccountId: source.accountId,
        accountId: destAccountId,
        blobIds: undefined,
        create: {
          [args.create_id ?? "copy"]: {
            id: args.event_id,
            ...(args.calendar_id ? { calendarId: args.calendar_id } : {}),
            ...(args.patch ? { patch: args.patch } : {}),
          },
        },
        ...(args.if_in_state ? { ifInState: args.if_in_state } : {}),
      };
      delete (payload as Record<string, unknown>).blobIds;
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_event_copy",
        accountId: destAccountId,
        operation: "create",
        resourceKind: "CalendarEvent",
        resourceIds: [args.event_id],
        payload,
        summary: `Copy event ${args.event_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(source, CALENDAR_USING, "CalendarEvent/copy", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_changes",
    "Read event state changes with CalendarEvent/changes.",
    {
      account_id: accountIdSchema,
      since_state: z.string(),
      max_changes: z.number().int().positive().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/changes", {
        accountId: account.accountId,
        sinceState: args.since_state,
        ...(args.max_changes ? { maxChanges: args.max_changes } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_query_changes",
    "Read query-relative event changes with CalendarEvent/queryChanges.",
    {
      ...queryShape,
      since_query_state: z.string(),
      max_changes: z.number().int().positive().optional(),
      up_to_id: z.string().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/queryChanges", {
        accountId: account.accountId,
        filter: args.filter ?? {},
        ...(args.sort ? { sort: args.sort } : {}),
        sinceQueryState: args.since_query_state,
        ...(args.max_changes ? { maxChanges: args.max_changes } : {}),
        ...(args.up_to_id ? { upToId: args.up_to_id } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_event_respond",
    "RSVP to an event by patching a participant status on CalendarEvent/set update.",
    {
      ...mutationShape,
      event_id: z.string(),
      participant_id: z.string().optional(),
      participant_identity_id: z.string().optional(),
      status: z.enum(["needs-action", "accepted", "declined", "tentative", "delegated"]),
      comment: z.string().optional(),
      scope: z.enum(["this", "future", "all"]).optional(),
      sendSchedulingMessages: z.boolean().default(true).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const participantId = args.participant_id ??
        await findParticipantId(context, account, args.event_id, args.participant_identity_id);
      if (!participantId) {
        throw new Error(
          "participant_id was not provided and could not be inferred from participant_identity_id",
        );
      }
      const patch: Record<string, unknown> = {
        [`participants/${participantId}/participationStatus`]: args.status,
      };
      if (args.comment) patch[`participants/${participantId}/scheduleComment`] = args.comment;
      const payload = setArgs(account.accountId, {
        update: { [args.event_id]: patch },
        ifInState: args.if_in_state,
        extra: {
          ...schedulingExtra(args.sendSchedulingMessages),
          ...(args.scope ? { updateScope: args.scope } : {}),
        },
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_event_respond",
        accountId: account.accountId,
        operation: args.sendSchedulingMessages ? "send" : "update",
        resourceKind: "CalendarEvent",
        resourceIds: [args.event_id, participantId],
        payload,
        summary: `Respond ${args.status} to event ${args.event_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/set", payload);
    },
  );
}

function pickQuery(args: {
  filter?: Record<string, unknown>;
  sort?: Record<string, unknown>[];
  position?: number;
  limit?: number;
  anchor?: string;
  anchorOffset?: number;
  calculateTotal?: boolean;
  expandRecurrences?: boolean;
}): Record<string, unknown> {
  return {
    ...(args.filter ? { filter: args.filter } : {}),
    ...(args.sort ? { sort: args.sort } : {}),
    ...(args.position !== undefined ? { position: args.position } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.anchor ? { anchor: args.anchor } : {}),
    ...(args.anchorOffset !== undefined ? { anchorOffset: args.anchorOffset } : {}),
    ...(args.calculateTotal !== undefined ? { calculateTotal: args.calculateTotal } : {}),
    ...(args.expandRecurrences !== undefined ? { expandRecurrences: args.expandRecurrences } : {}),
  };
}

export function calendarEventQueryArgs(args: {
  accountId: string;
  filter?: Record<string, unknown>;
  sort?: Record<string, unknown>[];
  position?: number;
  limit?: number;
  anchor?: string;
  anchorOffset?: number;
  calculateTotal?: boolean;
  calendar_ids?: string[];
  time_min?: string;
  time_max?: string;
  query?: string;
  expand_recurrences?: boolean;
}): Record<string, unknown> {
  const filter = combineFilters(
    args.filter,
    calendarIdsFilter(args.calendar_ids),
    compactFilter({
      ...(args.time_min ? { after: args.time_min } : {}),
      ...(args.time_max ? { before: args.time_max } : {}),
      ...(args.query ? { text: args.query } : {}),
    }),
  );
  const expandRecurrences = args.expand_recurrences ??
    (args.time_min && args.time_max ? true : undefined);
  return {
    accountId: args.accountId,
    ...pickQuery({ ...args, filter, expandRecurrences }),
  };
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function schedulingExtra(sendSchedulingMessages?: boolean): Record<string, unknown> {
  return sendSchedulingMessages === undefined ? {} : { sendSchedulingMessages };
}

function compactFilter(filter: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(filter).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function calendarIdsFilter(calendarIds?: string[]): Record<string, unknown> | undefined {
  if (!calendarIds?.length) return undefined;
  if (calendarIds.length === 1) return { inCalendar: calendarIds[0] };
  return {
    operator: "OR",
    conditions: calendarIds.map((calendarId) => ({ inCalendar: calendarId })),
  };
}

function combineFilters(
  ...filters: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const present = filters.filter((filter): filter is Record<string, unknown> =>
    !!filter && Object.keys(filter).length > 0
  );
  if (!present.length) return {};
  if (present.length === 1) return present[0];
  return { operator: "AND", conditions: present };
}

async function findParticipantId(
  context: ToolContext,
  account: AccountContext,
  eventId: string,
  identityId?: string,
): Promise<string | undefined> {
  if (!identityId) return undefined;
  const [eventGet, identityGet] = await Promise.all([
    context.jmap.single(account, CALENDAR_USING, "CalendarEvent/get", {
      accountId: account.accountId,
      ids: [eventId],
      properties: ["participants"],
    }),
    context.jmap.single(account, CALENDAR_USING, "ParticipantIdentity/get", {
      accountId: account.accountId,
      ids: [identityId],
    }),
  ]);
  const event = Array.isArray(eventGet.list)
    ? eventGet.list[0] as Record<string, unknown> | undefined
    : undefined;
  const identity = Array.isArray(identityGet.list)
    ? identityGet.list[0] as Record<string, unknown> | undefined
    : undefined;
  const identityAddress = String(identity?.email ?? identity?.calendarAddress ?? "").toLowerCase();
  const participants = event?.participants;
  if (!identityAddress || !participants || typeof participants !== "object") return undefined;
  for (
    const [id, participant] of Object.entries(
      participants as Record<string, Record<string, unknown>>,
    )
  ) {
    const addresses = [
      participant.email,
      participant.calendarAddress,
      (participant.sendTo as Record<string, unknown> | undefined)?.imip,
    ].filter((value): value is string => typeof value === "string");
    if (addresses.some((address) => address.toLowerCase() === identityAddress)) return id;
  }
  return undefined;
}
