import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import { STALWART_USING } from "../jmap.ts";
import {
  confirmSchema,
  objectSchema,
  registerJsonTool,
  requireMutationConfirmation,
} from "./common.ts";

const STALWART_SINGLETON_IDS = ["singleton"];

export function registerAdminTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "calendar_server_settings_get",
    "Read Stalwart calendar server settings through x:Calendar/get, x:CalendarAlarm/get, and x:CalendarScheduling/get.",
    {
      include_alarm: z.boolean().default(true).optional(),
      include_scheduling: z.boolean().default(true).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(context.actor, STALWART_USING[1]);
      const calendar = await context.jmap.single(account, STALWART_USING, "x:Calendar/get", {
        ids: STALWART_SINGLETON_IDS,
      });
      const alarm = args.include_alarm === false
        ? undefined
        : await context.jmap.single(account, STALWART_USING, "x:CalendarAlarm/get", {
          ids: STALWART_SINGLETON_IDS,
        });
      const scheduling = args.include_scheduling === false
        ? undefined
        : await context.jmap.single(account, STALWART_USING, "x:CalendarScheduling/get", {
          ids: STALWART_SINGLETON_IDS,
        });
      return { calendar, alarm, scheduling };
    },
  );

  registerJsonTool(
    server,
    config,
    "calendar_server_settings_update",
    "Update Stalwart calendar server settings through x:* singleton set methods. Requires ENABLE_ADMIN_TOOLS=true and confirmation.",
    {
      calendar_patch: objectSchema.optional(),
      alarm_patch: objectSchema.optional(),
      scheduling_patch: objectSchema.optional(),
      ...confirmSchema,
    },
    async (args, context) => {
      if (!config.enableAdminTools) {
        throw new Error("Admin update tools are disabled. Set ENABLE_ADMIN_TOOLS=true to enable.");
      }
      const account = await context.jmap.resolveAccount(context.actor, STALWART_USING[1]);
      const methodCalls: [string, Record<string, unknown>, string][] = [];
      if (args.calendar_patch) {
        methodCalls.push([
          "x:Calendar/set",
          { update: { singleton: args.calendar_patch } },
          "calendar",
        ]);
      }
      if (args.alarm_patch) {
        methodCalls.push([
          "x:CalendarAlarm/set",
          { update: { singleton: args.alarm_patch } },
          "alarm",
        ]);
      }
      if (args.scheduling_patch) {
        methodCalls.push([
          "x:CalendarScheduling/set",
          { update: { singleton: args.scheduling_patch } },
          "scheduling",
        ]);
      }
      if (!methodCalls.length) throw new Error("No admin patch was provided");
      const invocation = { using: STALWART_USING, methodCalls };
      const guard = await requireMutationConfirmation(context, {
        toolName: "calendar_server_settings_update",
        accountId: "server",
        operation: "admin",
        resourceKind: "StalwartCalendarSettings",
        resourceIds: methodCalls.map(([method]) => method),
        payload: invocation,
        summary: `Update ${methodCalls.length} Stalwart calendar settings singleton(s).`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.call(account, invocation);
    },
  );
}
