import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import { CALENDAR_USING } from "../jmap.ts";
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

export function registerNotificationTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "event_notification_list",
    "List event notifications with CalendarEventNotification/query and get.",
    {
      account_id: accountIdSchema,
      filter: objectSchema.optional(),
      sort: z.array(objectSchema).optional(),
      position: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
      fetch: z.boolean().default(true).optional(),
      properties: propertiesSchema,
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
        "CalendarEventNotification/query",
        {
          accountId: account.accountId,
          ...(args.filter ? { filter: args.filter } : {}),
          ...(args.sort ? { sort: args.sort } : {}),
          ...(args.position !== undefined ? { position: args.position } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        },
      );
      if (args.fetch === false) return { query };
      const ids = asIds(query.ids);
      const get = ids.length
        ? await context.jmap.single(account, CALENDAR_USING, "CalendarEventNotification/get", {
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
    "event_notification_dismiss",
    "Dismiss event notifications with CalendarEventNotification/set destroy.",
    {
      account_id: accountIdSchema,
      ids: idsSchema,
      if_in_state: z.string().optional(),
      ...confirmSchema,
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
        toolName: "event_notification_dismiss",
        accountId: account.accountId,
        operation: "delete",
        resourceKind: "CalendarEventNotification",
        resourceIds: args.ids,
        payload,
        summary: `Dismiss ${args.ids.length} event notification(s).`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(
        account,
        CALENDAR_USING,
        "CalendarEventNotification/set",
        payload,
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "event_notification_changes",
    "Read event notification changes with CalendarEventNotification/changes.",
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
      return await context.jmap.single(
        account,
        CALENDAR_USING,
        "CalendarEventNotification/changes",
        {
          accountId: account.accountId,
          sinceState: args.since_state,
          ...(args.max_changes ? { maxChanges: args.max_changes } : {}),
        },
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "event_notification_query_changes",
    "Read query-relative notification changes with CalendarEventNotification/queryChanges.",
    {
      account_id: accountIdSchema,
      filter: objectSchema.optional(),
      sort: z.array(objectSchema).optional(),
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
      return await context.jmap.single(
        account,
        CALENDAR_USING,
        "CalendarEventNotification/queryChanges",
        {
          accountId: account.accountId,
          filter: args.filter ?? {},
          ...(args.sort ? { sort: args.sort } : {}),
          sinceQueryState: args.since_query_state,
          ...(args.max_changes ? { maxChanges: args.max_changes } : {}),
          ...(args.up_to_id ? { upToId: args.up_to_id } : {}),
        },
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "alert_acknowledge",
    "Acknowledge an event alert by patching CalendarEvent alerts.",
    {
      account_id: accountIdSchema,
      event_id: z.string(),
      alert_id: z.string(),
      acknowledged: z.string().optional(),
      if_in_state: z.string().optional(),
      ...confirmSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const acknowledged = args.acknowledged ?? new Date().toISOString();
      const payload = setArgs(account.accountId, {
        update: { [args.event_id]: { [`alerts/${args.alert_id}/acknowledged`]: acknowledged } },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "alert_acknowledge",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "CalendarEventAlert",
        resourceIds: [args.event_id, args.alert_id],
        payload,
        summary: `Acknowledge alert ${args.alert_id} on event ${args.event_id}.`,
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
    "alert_snooze",
    "Snooze an event alert by patching CalendarEvent alerts/relatedTo.",
    {
      account_id: accountIdSchema,
      event_id: z.string(),
      alert_id: z.string(),
      snoozed_until: z.string(),
      if_in_state: z.string().optional(),
      ...confirmSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_USING[1],
        args.account_id,
      );
      const payload = setArgs(account.accountId, {
        update: {
          [args.event_id]: {
            [`alerts/${args.alert_id}/relatedTo`]: {
              "@type": "Relation",
              relation: { snoozed: true },
              snoozedUntil: args.snoozed_until,
            },
          },
        },
        ifInState: args.if_in_state,
      });
      const guard = await requireMutationConfirmation(context, {
        toolName: "alert_snooze",
        accountId: account.accountId,
        operation: "update",
        resourceKind: "CalendarEventAlert",
        resourceIds: [args.event_id, args.alert_id],
        payload,
        summary: `Snooze alert ${args.alert_id} until ${args.snoozed_until}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, CALENDAR_USING, "CalendarEvent/set", payload);
    },
  );
}

function asIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
