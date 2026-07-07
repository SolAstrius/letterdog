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
  const authorization = Deno.env.get("MCP_AUTHORIZATION");
  const bearer = Deno.env.get("MCP_BEARER") ?? Deno.env.get("TEST_BEARER") ??
    Deno.env.get("STALWART_BEARER");
  const authHeader = authorization ?? (bearer ? `Bearer ${bearer}` : undefined);
  if (!authHeader) {
    throw new Error("Set MCP_AUTHORIZATION, MCP_BEARER, TEST_BEARER, or STALWART_BEARER");
  }

  const client = new Client({ name: "stalwart-jmap-mcp-live-probe", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: authHeader } },
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
      capability: "urn:ietf:params:jmap:mail",
    });
    await probe(results, client, "stalwart_account_resolve", {
      capability: "urn:ietf:params:jmap:submission",
    });
    await probe(results, client, "get_mail_profile", {});
    const mailboxes = await probe(results, client, "list_mailboxes", {});
    const mailboxList = arrayAt(mailboxes, "list");
    const junkMailboxId = mailboxIdByRole(mailboxList, "junk");
    const inboxMailboxId = mailboxIdByRole(mailboxList, "inbox");
    const mailSearch = await probe(results, client, "search_email_ids", {
      query: junkMailboxId ? "in:junk" : undefined,
      limit: 5,
      sort: [{ property: "receivedAt", isAscending: false }],
      calculate_total: true,
    });
    const mailIds = arrayAt(objectAt(mailSearch, "query"), "ids").map(String);
    const fetchedMail = await probe(results, client, "search_emails", {
      filter: inboxMailboxId ? { inMailbox: inboxMailboxId } : undefined,
      limit: 3,
      include_body: false,
      sort: [{ property: "receivedAt", isAscending: false }],
    });
    const fetchedMailList = arrayAt(objectAt(fetchedMail, "get"), "list");
    const firstEmailId = mailIds[0] ?? stringAt(fetchedMailList[0], "id");
    if (firstEmailId) {
      const email = await probe(results, client, "read_email", {
        email_id: firstEmailId,
        include_body: true,
        max_body_bytes: 20_000,
      });
      await probe(results, client, "batch_read_emails", {
        email_ids: [firstEmailId],
        include_body: false,
      });
      await probe(results, client, "read_email_thread", {
        email_id: firstEmailId,
        include_body: false,
      });
      const threadId = stringAt(firstObject(arrayAt(objectAt(email, "get"), "list")), "threadId");
      if (threadId) {
        await probe(results, client, "batch_read_email_threads", {
          thread_ids: [threadId],
          include_body: false,
        });
      }
      const attachmentBlobId = firstAttachmentBlobId(
        firstObject(arrayAt(objectAt(email, "get"), "list")),
      );
      if (attachmentBlobId) {
        await probe(results, client, "read_attachment", {
          email_id: firstEmailId,
          blob_id: attachmentBlobId,
          as: "base64",
          max_bytes: 2048,
        });
      }
    }
    await probe(results, client, "list_draft_emails", { limit: 5, include_body: false });
    await probe(results, client, "create_draft_email", {
      message: {
        to: [{ email: "nobody@example.invalid" }],
        subject: "Probe draft confirmation",
        body: { text: "This probe must return a confirmation challenge, not create a draft." },
      },
    });
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

function firstObject(value: unknown[]): Record<string, unknown> {
  const first = value[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? first as Record<string, unknown>
    : {};
}

function mailboxIdByRole(mailboxes: unknown[], role: string): string | undefined {
  for (const mailbox of mailboxes) {
    if (!mailbox || typeof mailbox !== "object" || Array.isArray(mailbox)) continue;
    const record = mailbox as Record<string, unknown>;
    if (record.role === role && typeof record.id === "string") return record.id;
  }
  return undefined;
}

function firstAttachmentBlobId(email: Record<string, unknown>): string | undefined {
  for (const part of arrayAt(email, "attachments")) {
    const blobId = stringAt(part, "blobId");
    if (blobId) return blobId;
  }
  return undefined;
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
