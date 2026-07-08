/**
 * MCP frontend: compiles ops tagged "mcp" into tools — near-zero code of its own.
 * CONTRACT STUB — TODO(builder: B11-frontends). Signatures normative; bodies throw.
 *
 * Per tool registration (server.registerTool(op.mcpName, …)):
 * - inputSchema = op.input (+ confirm_token where the op's confirmClass can two-phase).
 * - annotations: readOnlyHint/destructiveHint/idempotentHint from op.annotations.
 * - handler: build Actor from the request Authorization header (v1 src/auth.ts pattern —
 *   forward verbatim, env fallback only when config.allowEnvBearerFallback), assemble
 *   OpContext {config, actor, jmap, caldav, provider, policy}, run op.handler, print result
 *   via projections.compactJson. Errors → {isError, {error, details}}.
 * - Gating: admin.* and sieve.* ops require config.enableAdminTools; sync.* require
 *   config.enableSyncTools (they are CLI-surface anyway; filter regardless for safety).
 *
 * Transports mirror v1 src/server/transports.ts: HTTP (WebStandardStreamableHTTPServerTransport,
 * stateless, /healthz + /readyz, 401 without Authorization) and stdio.
 */
import type { McpServer } from "@mcp/server/mcp";
import type { V2Config } from "../core/config.ts";
import { allOps } from "../core/ops/index.ts";
import { opsForSurface } from "../core/ops/registry.ts";

/** Server metadata (design "Naming": Letterdog is the product). */
export const SERVER_NAME = "letterdog";
export const SERVER_VERSION = "2.0.0";

/** Assemble an McpServer with every mcp-surface op registered. */
export function createMcpServer(_config: V2Config): McpServer {
  allOps(); // assemble the registry
  const _mcpOps = opsForSurface("mcp");
  throw new Error("not implemented: mcp/server createMcpServer");
}

/** HTTP transport (deployed shape): per-request bearer forwarding, multi-actor. */
export function startHttp(_config: V2Config): void {
  throw new Error("not implemented: mcp/server startHttp");
}

/** stdio transport (local shape): env-fallback auth allowed by default. */
export function startStdio(_config: V2Config): Promise<void> {
  throw new Error("not implemented: mcp/server startStdio");
}

/** Entry used by v2.ts — dispatches on config.transport. */
export async function startMcp(config: V2Config): Promise<void> {
  if (config.transport === "stdio") {
    await startStdio(config);
  } else {
    startHttp(config);
  }
}
