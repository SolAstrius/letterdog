/**
 * Letterdog v2 MCP entrypoint (HTTP by default; MCP_TRANSPORT=stdio for local).
 * The CLI entrypoint is src/cli/main.ts (`deno task cli -- …`).
 */
import { loadV2Config } from "./src/core/config.ts";
import { startMcp } from "./src/mcp/server.ts";

const config = await loadV2Config();
await startMcp(config);
