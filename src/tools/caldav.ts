import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import { calendarMultigetBody, calendarQueryBody, propfindBody } from "../caldav.ts";
import {
  confirmSchema,
  idsSchema,
  registerJsonTool,
  requireMutationConfirmation,
} from "./common.ts";

export function registerCalDavTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "caldav_discover",
    "Discover CalDAV principal, calendar homes, and advertised DAV features via cdav-library.",
    {},
    async (_args, context) => await context.caldav.discover(),
  );

  registerJsonTool(
    server,
    config,
    "caldav_calendar_list",
    "List CalDAV calendar collections grouped by type via cdav-library.",
    {
      home_path: z.string().optional(),
    },
    async (args, context) => await context.caldav.listCalendarCollections(args.home_path),
  );

  registerJsonTool(
    server,
    config,
    "caldav_calendar_resources",
    "List raw calendar resources in a CalDAV collection via cdav-library.",
    {
      calendar_path: z.string(),
    },
    async (args, context) => await context.caldav.listCalendarObjects(args.calendar_path),
  );

  registerJsonTool(
    server,
    config,
    "caldav_event_search",
    "Run a CalDAV calendar-query for events, optionally bounded by a UTC time range.",
    {
      calendar_path: z.string(),
      component: z.string().default("VEVENT").optional(),
      utc_start: z.string().optional(),
      utc_end: z.string().optional(),
      fallback_raw_report: z.boolean().default(false).optional(),
    },
    async (args, context) => {
      if (args.fallback_raw_report) {
        return await context.caldav.report(
          args.calendar_path,
          "1",
          calendarQueryBody(toICalUtc(args.utc_start), toICalUtc(args.utc_end)),
        );
      }
      return await context.caldav.queryCalendarObjects(args.calendar_path, {
        component: args.component,
        start: args.utc_start,
        end: args.utc_end,
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "caldav_event_get_raw",
    "Read the raw iCalendar text for one CalDAV event resource.",
    {
      href: z.string(),
    },
    async (args, context) => await context.caldav.get(args.href),
  );

  registerJsonTool(
    server,
    config,
    "caldav_event_multiget_raw",
    "Read multiple raw iCalendar resources with calendar-multiget via cdav-library or raw REPORT.",
    {
      calendar_path: z.string(),
      hrefs: idsSchema,
      fallback_raw_report: z.boolean().default(false).optional(),
    },
    async (args, context) => {
      if (args.fallback_raw_report) {
        return await context.caldav.report(
          args.calendar_path,
          "1",
          calendarMultigetBody(args.hrefs),
        );
      }
      return await context.caldav.multigetCalendarObjects(args.calendar_path, args.hrefs);
    },
  );

  registerJsonTool(
    server,
    config,
    "caldav_propfind",
    "Run a constrained CalDAV PROPFIND for diagnostics.",
    {
      path: z.string(),
      depth: z.enum(["0", "1", "infinity"]).default("0").optional(),
      properties: z.array(z.string()).min(1),
    },
    async (args, context) =>
      await context.caldav.propfind(args.path, args.depth ?? "0", propfindBody(args.properties)),
  );

  registerJsonTool(
    server,
    config,
    "caldav_event_put_raw",
    "Create or replace a raw CalDAV iCalendar resource with PUT.",
    {
      href: z.string(),
      icalendar: z.string(),
      content_type: z.string().default("text/calendar; charset=utf-8").optional(),
      if_match: z.string().optional(),
      if_none_match_star: z.boolean().optional(),
      ...confirmSchema,
    },
    async (args, context) => {
      const guard = await requireMutationConfirmation(context, {
        toolName: "caldav_event_put_raw",
        accountId: "caldav",
        operation: args.if_none_match_star ? "create" : "update",
        resourceKind: "CalDAVResource",
        resourceIds: [args.href],
        payload: {
          href: args.href,
          icalendar: args.icalendar,
          content_type: args.content_type,
          if_match: args.if_match,
          if_none_match_star: args.if_none_match_star,
        },
        precondition: args.if_match ? { ifMatch: args.if_match } : undefined,
        summary: `PUT raw iCalendar resource ${args.href}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.caldav.put(args.href, args.icalendar, {
        contentType: args.content_type,
        ifMatch: args.if_match,
        ifNoneMatch: args.if_none_match_star ? "*" : undefined,
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "caldav_event_delete_raw",
    "Delete a raw CalDAV iCalendar resource with DELETE.",
    {
      href: z.string(),
      if_match: z.string().optional(),
      ...confirmSchema,
    },
    async (args, context) => {
      const guard = await requireMutationConfirmation(context, {
        toolName: "caldav_event_delete_raw",
        accountId: "caldav",
        operation: "delete",
        resourceKind: "CalDAVResource",
        resourceIds: [args.href],
        payload: { href: args.href, if_match: args.if_match },
        precondition: args.if_match ? { ifMatch: args.if_match } : undefined,
        summary: `Delete raw iCalendar resource ${args.href}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.caldav.delete(args.href, args.if_match);
    },
  );
}

function toICalUtc(value?: string): string | undefined {
  if (!value) return undefined;
  return new Date(value).toISOString().replaceAll("-", "").replaceAll(":", "").replace(".000", "");
}
