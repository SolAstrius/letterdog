import { load } from "@std/dotenv";
import { Client } from "@mcp/client";
import { StreamableHTTPClientTransport } from "@mcp/client/streamable-http";

interface ToolJsonResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface ProbeResult {
  tool: string;
  ok: boolean;
  summary?: unknown;
  error?: string;
}

await main();

async function main(): Promise<void> {
  await load({ export: true });
  const endpoint = Deno.env.get("MCP_ENDPOINT") ?? "http://127.0.0.1:8787/mcp";
  const bearer = Deno.env.get("MCP_BEARER") ?? Deno.env.get("TEST_BEARER") ??
    Deno.env.get("STALWART_BEARER");
  if (!bearer) throw new Error("Set MCP_BEARER, TEST_BEARER, or STALWART_BEARER");

  const client = new Client({ name: "stalwart-jmap-mcp-live-probe", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  const results: ProbeResult[] = [];
  let exitCode = 0;

  try {
    const tools = await client.listTools();
    results.push({
      tool: "tools/list",
      ok: true,
      summary: { count: tools.tools.length },
    });

    const session = await probe(results, client, "stalwart_session_info", {});
    await probe(results, client, "stalwart_account_resolve", {
      capability: "urn:ietf:params:jmap:calendars",
    });

    const calendars = await probe(results, client, "calendar_list", { limit: 20, fetch: true });
    const calendarGet = objectAt(calendars, "get");
    const calendarList = arrayAt(calendarGet, "list");
    const calendarIds = calendarList
      .map((calendar) => stringAt(calendar, "id"))
      .filter((id): id is string => !!id);
    const firstCalendarId = calendarIds[0];
    const calendarState = stringAt(calendarGet, "state");

    if (calendarIds.length) {
      await probe(results, client, "calendar_get", { ids: calendarIds });
    }
    if (calendarState) {
      await probe(results, client, "calendar_changes", { since_state: calendarState });
    }

    const events = await probe(results, client, "calendar_event_search", {
      calendar_ids: firstCalendarId ? [firstCalendarId] : undefined,
      limit: 10,
      fetch: true,
    });
    const eventQuery = objectAt(events, "query");
    const eventGet = objectAt(events, "get");
    const eventIds = arrayAt(eventQuery, "ids").map(String);
    const eventState = stringAt(eventGet, "state");
    const eventQueryState = stringAt(eventQuery, "queryState");
    if (eventIds.length) {
      await probe(results, client, "calendar_event_get", { event_id: eventIds[0] });
      await probe(results, client, "calendar_event_batch_get", { event_ids: eventIds.slice(0, 3) });
    }
    if (eventState) {
      await probe(results, client, "calendar_event_changes", { since_state: eventState });
    }
    if (eventQueryState) {
      await probe(results, client, "calendar_event_query_changes", {
        since_query_state: eventQueryState,
        filter: firstCalendarId ? { inCalendar: firstCalendarId } : {},
      });
    }

    const identities = await probe(results, client, "participant_identity_list", {});
    const identityState = stringAt(identities, "state");
    if (identityState) {
      await probe(results, client, "participant_identity_changes", { since_state: identityState });
    }

    const principals = await probe(results, client, "principal_search", {
      query: "sol",
      limit: 5,
      fetch: true,
    });
    const principalIds = arrayAt(objectAt(principals, "query"), "ids").map(String);
    if (principalIds.length) {
      await probe(results, client, "principal_get", { ids: principalIds.slice(0, 3) });
      const now = new Date();
      const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      await probe(results, client, "principal_availability_get", {
        principal_ids: principalIds.slice(0, 1),
        utc_start: now.toISOString(),
        utc_end: end.toISOString(),
        show_details: false,
      });
      await probe(results, client, "availability_get", {
        principal_ids: principalIds.slice(0, 1),
        utc_start: now.toISOString(),
        utc_end: end.toISOString(),
        show_details: false,
      });
    }

    const notifications = await probe(results, client, "event_notification_list", {
      limit: 10,
      fetch: true,
    });
    const notificationQuery = objectAt(notifications, "query");
    const notificationState = stringAt(objectAt(notifications, "get"), "state");
    const notificationQueryState = stringAt(notificationQuery, "queryState");
    if (notificationState) {
      await probe(results, client, "event_notification_changes", {
        since_state: notificationState,
      });
    }
    if (notificationQueryState && booleanAt(notificationQuery, "canCalculateChanges")) {
      await probeExpectedError(
        results,
        client,
        "event_notification_query_changes",
        { since_query_state: notificationQueryState },
        "cannotCalculateChanges",
      );
    }

    await probe(results, client, "caldav_discover", {});
    const caldavCalendars = await probe(results, client, "caldav_calendar_list", {});
    const firstCalDavCalendar = firstCalendarPath(caldavCalendars);
    if (firstCalDavCalendar) {
      const resources = await probe(results, client, "caldav_calendar_resources", {
        calendar_path: firstCalDavCalendar,
      });
      await probe(results, client, "caldav_event_search", {
        calendar_path: firstCalDavCalendar,
        component: "VEVENT",
      });
      const hrefs = arrayAt(resources, "objects")
        .map((object) => stringAt(object, "url"))
        .filter(Boolean)
        .slice(0, 2);
      if (hrefs.length) {
        await probe(results, client, "caldav_event_get_raw", { href: hrefs[0] });
        await probe(results, client, "caldav_event_multiget_raw", {
          calendar_path: firstCalDavCalendar,
          hrefs,
        });
      }
    }

    await probe(results, client, "icalendar_parse", {
      icalendar: minimalICalendar(),
    });
    await probe(results, client, "file_node_list", { limit: 10, fetch: true });
    await probe(results, client, "calendar_server_settings_get", {});
    await probe(results, client, "jmap_call", {
      using: ["urn:ietf:params:jmap:core"],
      method_calls: [["Core/echo", { probe: true }, "c1"]],
    });

    const authSource = stringAt(session, "authSource");
    console.log(JSON.stringify({ endpoint, authSource, results }, null, 2));
    if (results.some((result) => !result.ok)) exitCode = 1;
  } finally {
    await client.close();
  }
  Deno.exit(exitCode);
}

async function probe(
  results: ProbeResult[],
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  try {
    const value = await callTool(client, tool, pruneUndefined(args));
    results.push({ tool, ok: true, summary: summarize(value) });
    return value;
  } catch (error) {
    results.push({
      tool,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

async function probeExpectedError(
  results: ProbeResult[],
  client: Client,
  tool: string,
  args: Record<string, unknown>,
  expectedText: string,
): Promise<unknown> {
  try {
    const value = await callTool(client, tool, pruneUndefined(args));
    results.push({ tool, ok: true, summary: summarize(value) });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedText)) {
      results.push({ tool, ok: true, summary: { expectedServerError: expectedText } });
      return {};
    }
    results.push({ tool, ok: false, error: message });
    return {};
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args }) as ToolJsonResult;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError) throw new Error(text ?? `${name} failed`);
  return text ? JSON.parse(text) : null;
}

function summarize(value: unknown): unknown {
  if (Array.isArray(value)) return { length: value.length };
  if (!value || typeof value !== "object") return value;
  const data = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(data)
      .filter(([key, val]) =>
        ["authSource", "state", "oldState", "newState", "accountId", "notFound"].includes(key) ||
        key.endsWith("State") ||
        Array.isArray(val)
      )
      .map(([key, val]) => [key, Array.isArray(val) ? { length: val.length } : val]),
  );
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" && !Array.isArray(child)
    ? child as Record<string, unknown>
    : {};
}

function arrayAt(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child : [];
}

function stringAt(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : undefined;
}

function booleanAt(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  return (value as Record<string, unknown>)[key] === true;
}

function firstCalendarPath(value: unknown): string | undefined {
  const homes = arrayAt(value, "homes");
  for (const home of homes) {
    for (const calendar of arrayAt(home, "calendars")) {
      const url = stringAt(calendar, "url");
      if (url) return url;
    }
  }
  return undefined;
}

function minimalICalendar(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//stalwart-jmap-mcp//probe//EN",
    "BEGIN:VEVENT",
    "UID:probe@example.invalid",
    "DTSTAMP:20260707T000000Z",
    "DTSTART:20260707T010000Z",
    "DTEND:20260707T020000Z",
    "SUMMARY:Probe",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function pruneUndefined(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}
