import { load } from "@std/dotenv";
import { Client } from "@mcp/client";
import { StreamableHTTPClientTransport } from "@mcp/client/streamable-http";

interface ToolJsonResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

await main();

async function main(): Promise<void> {
  await load({ export: true });
  const endpoint = Deno.env.get("MCP_ENDPOINT") ?? "http://127.0.0.1:8787/mcp";
  const bearer = Deno.env.get("MCP_BEARER") ?? Deno.env.get("TEST_BEARER") ??
    Deno.env.get("STALWART_BEARER");
  if (!bearer) throw new Error("Set MCP_BEARER, TEST_BEARER, or STALWART_BEARER");

  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: {
      headers: { Authorization: `Bearer ${bearer}` },
    },
  });
  const client = new Client({ name: "stalwart-jmap-mcp-smoke", version: "0.1.0" });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool: { name: string }) => tool.name).sort();
    console.log(`Connected to ${endpoint}`);
    console.log(`Server exposed ${toolNames.length} tools`);

    await callAndLog(client, "stalwart_session_info", {});
    await callAndLog(client, "calendar_list", { limit: 20, fetch: true });
    await callAndLog(client, "caldav_discover", {});
    await callAndLog(client, "jmap_call", {
      using: ["urn:ietf:params:jmap:core"],
      method_calls: [["Core/echo", { hello: "stalwart-mcp" }, "c1"]],
    });
  } finally {
    await client.close();
  }
}

async function callAndLog(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const result = await client.callTool({ name, arguments: args }) as ToolJsonResult;
  if (result.isError) {
    throw new Error(`${name} returned MCP error: ${JSON.stringify(result.content)}`);
  }
  const json = parseJsonResult(result);
  console.log(`${name}: ${summarize(name, json)}`);
}

function parseJsonResult(result: ToolJsonResult): unknown {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) return null;
  return JSON.parse(text);
}

function summarize(name: string, value: unknown): string {
  const data = value as Record<string, unknown>;
  switch (name) {
    case "stalwart_session_info":
      return JSON.stringify({
        authSource: data.authSource,
        accounts: Object.keys((data.session as Record<string, unknown>)?.accounts ?? {}).length,
      });
    case "calendar_list": {
      const get = data.get as { list?: unknown[] };
      return JSON.stringify({ calendars: get?.list?.length ?? 0 });
    }
    case "caldav_discover":
      return JSON.stringify({
        principal: (data.currentUserPrincipal as Record<string, unknown> | null)?.url,
        calendarHomes: (data.calendarHomes as unknown[])?.length ?? 0,
      });
    case "jmap_call":
      return JSON.stringify({ methodResponses: (data.methodResponses as unknown[])?.length ?? 0 });
    default:
      return JSON.stringify(data).slice(0, 240);
  }
}
