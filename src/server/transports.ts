import { McpServer } from "@mcp/server/mcp";
import { StdioServerTransport } from "@mcp/server/stdio";
import { WebStandardStreamableHTTPServerTransport } from "@mcp/server/web-standard-streamable-http";
import type { EnvConfig } from "../config.ts";
import { authInfoFromRequest } from "../auth.ts";
import { registerAllTools } from "../tools/index.ts";

function createServer(config: EnvConfig): McpServer {
  const server = new McpServer({
    name: "stalwart-jmap-mcp",
    version: "0.1.0",
  });
  registerAllTools(server, config);
  return server;
}

export async function startHttp(config: EnvConfig): Promise<void> {
  const server = createServer(config);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);

  Deno.serve({ hostname: "0.0.0.0", port: config.port }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (url.pathname === "/readyz") {
      return Response.json({
        ok: true,
        stalwartBaseUrl: config.stalwartBaseUrl,
        envBearerFallback: config.allowEnvBearerFallback,
      });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    return await transport.handleRequest(request, {
      authInfo: authInfoFromRequest(request),
    });
  });
}

export async function startStdio(config: EnvConfig): Promise<void> {
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
}
