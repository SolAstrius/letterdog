/**
 * MCP frontend: compiles ops tagged "mcp" into tools — near-zero code of its own.
 *
 * Per tool registration (server.registerTool(op.mcpName, …)):
 * - inputSchema = op.input (+ confirm_token where the op's confirmClass can two-phase).
 * - annotations: readOnlyHint/destructiveHint/idempotentHint from op.annotations + title.
 * - handler: build Actor from the request Authorization header (v1 src/auth.ts pattern —
 *   forward verbatim, env fallback only when config.allowEnvBearerFallback), assemble
 *   OpContext {config, actor, jmap, caldav, provider, policy}, run op.handler, print result
 *   via projections.compactJson. Errors → {isError, {error, details}}.
 * - Gating: admin.* and sieve.* ops require config.enableAdminTools; sync.* require
 *   config.enableSyncTools (they are CLI-surface anyway; filter regardless for safety).
 *
 * Transports mirror v1 src/server/transports.ts: HTTP (WebStandardStreamableHTTPServerTransport,
 * stateless, /healthz + /readyz, 401 without Authorization) and stdio.
 *
 * Auth is REIMPLEMENTED in the v2 namespace here (not imported from v1 src/auth.ts) so the two
 * codebases stay independent, per the builder brief.
 */
import { McpServer } from "@mcp/server/mcp";
import { StdioServerTransport } from "@mcp/server/stdio";
import { WebStandardStreamableHTTPServerTransport } from "@mcp/server/web-standard-streamable-http";
import type { RequestHandlerExtra } from "@mcp/shared/protocol";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@mcp/types";
import { z } from "zod";

import type { V2Config } from "../core/config.ts";
import { allOps } from "../core/ops/index.ts";
import { opsForSurface } from "../core/ops/registry.ts";
import type { Actor, OpContext, OpDefinition } from "../core/ops/registry.ts";
import { JmapClient } from "../core/jmap/client.ts";
import { CalDavClient } from "../../src/caldav.ts";
import { stalwartProvider } from "../core/provider/stalwart.ts";
import { actorFingerprint } from "../core/safety.ts";
import { compactJson } from "../core/projections.ts";

/** Server metadata (design "Naming": Letterdog is the product). */
export const SERVER_NAME = "letterdog";
export const SERVER_VERSION = "2.0.0";

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** confirm_token arg injected onto gated ops (self-contained signed token from a prior challenge). */
const CONFIRM_TOKEN_SHAPE = {
  confirm_token: z.string().min(16).optional().describe(
    "Self-contained confirmation token echoed from a prior two-phase challenge. Repeat the " +
      "identical call carrying this token to execute a gated (destructive / high-blast / strict " +
      "outward) operation.",
  ),
};

/** Ops the MCP surface must never expose regardless of enable flags — none today, kept explicit. */
function isGatedOut(op: OpDefinition, config: V2Config): boolean {
  if (op.name.startsWith("admin.") || op.name.startsWith("sieve.")) return !config.enableAdminTools;
  if (op.name.startsWith("sync.")) return !config.enableSyncTools;
  return false;
}

/** Map v2 OpAnnotations → MCP ToolAnnotations (hints only). */
function toolAnnotations(op: OpDefinition): ToolAnnotations {
  const a = op.annotations;
  const annotations: ToolAnnotations = { title: op.mcpName };
  if (a.readOnly !== undefined) annotations.readOnlyHint = a.readOnly;
  if (a.destructive !== undefined) annotations.destructiveHint = a.destructive;
  if (a.idempotent !== undefined) annotations.idempotentHint = a.idempotent;
  return annotations;
}

// --- auth (v2 reimplementation of the v1 forwarding pattern) -------------------------------------

interface ResolvedAuth {
  authorization: string;
  bearer?: string;
  source: "http" | "env";
}

function parseAuthorizationHeader(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  return /^[A-Za-z][A-Za-z0-9+.-]*\s+.+$/.test(trimmed) ? trimmed : undefined;
}

function parseBearerHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function headerFromExtra(extra: ToolExtra, name: string): string | null {
  const headers = extra.requestInfo?.headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
}

/** Resolve the caller's Authorization from the request, falling back to env only when allowed. */
function resolveAuth(config: V2Config, extra: ToolExtra): ResolvedAuth {
  const fromHeader = parseAuthorizationHeader(headerFromExtra(extra, "authorization")) ??
    parseAuthorizationHeader(authInfoToken(extra));
  if (fromHeader) {
    return { authorization: fromHeader, bearer: parseBearerHeader(fromHeader), source: "http" };
  }
  if (config.allowEnvBearerFallback && config.fallbackAuthorization) {
    return {
      authorization: config.fallbackAuthorization,
      bearer: parseBearerHeader(config.fallbackAuthorization),
      source: "env",
    };
  }
  throw new Error("Missing Authorization header.");
}

function authInfoToken(extra: ToolExtra): string | undefined {
  const token = extra.authInfo?.token;
  if (!token) return undefined;
  return parseAuthorizationHeader(token) ?? `Bearer ${token}`;
}

/** Build the registry Actor from a resolved auth (fingerprint binds confirm tokens to the actor). */
async function buildActor(
  config: V2Config,
  auth: ResolvedAuth,
  requestId?: string,
): Promise<Actor> {
  return {
    authorization: auth.authorization,
    bearer: auth.bearer,
    source: auth.source,
    fingerprint: await actorFingerprint(config.confirmationSecret, auth.authorization),
    requestId,
  };
}

/**
 * The v1 CalDavClient wants an `ActorContext["auth"]` whose `source` is one of its own literals.
 * Map the v2 actor source onto that shape (only `authorization` is actually read by the client).
 */
function caldavAuth(actor: Actor): { authorization: string; bearer?: string; source: string } {
  return {
    authorization: actor.authorization,
    bearer: actor.bearer,
    source: actor.source === "http" ? "http-authorization" : "env-fallback",
  };
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: compactJson(value) }] };
}

function errorResult(message: string, details?: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: compactJson({ error: message, details }) }],
  };
}

// --- server assembly ----------------------------------------------------------------------------

/** Assemble an McpServer with every mcp-surface op registered. */
export function createMcpServer(config: V2Config): McpServer {
  allOps(); // assemble the registry once
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  // One shared JMAP client across all actors — it holds no credential state beyond the
  // fingerprint-keyed session cache.
  const jmap = new JmapClient(config);
  const provider = stalwartProvider();

  for (const op of opsForSurface("mcp")) {
    if (isGatedOut(op, config)) continue;

    const inputSchema = op.confirmClass === "none"
      ? { ...op.input }
      : { ...op.input, ...CONFIRM_TOKEN_SHAPE };

    server.registerTool(
      op.mcpName,
      {
        description: op.description,
        // deno-lint-ignore no-explicit-any -- op.input is an erased ZodRawShape; the SDK's
        // ZodRawShapeCompat generic cannot be satisfied statically across the loop.
        inputSchema: inputSchema as any,
        annotations: toolAnnotations(op),
      },
      // deno-lint-ignore no-explicit-any
      (async (args: any, extra: ToolExtra): Promise<CallToolResult> => {
        try {
          const auth = resolveAuth(config, extra);
          const actor = await buildActor(config, auth, String(extra.requestId));
          const ctx: OpContext = {
            config,
            actor,
            jmap,
            caldav: new CalDavClient(
              config as never,
              caldavAuth(actor) as never,
            ),
            provider,
            policy: config.confirmPolicy,
          };
          const result = await op.handler(args, ctx);
          return jsonResult(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const details = error instanceof Error && "details" in error
            ? (error as { details?: unknown }).details
            : undefined;
          return errorResult(message, details);
        }
        // deno-lint-ignore no-explicit-any
      }) as any,
    );
  }

  return server;
}

// --- transports ---------------------------------------------------------------------------------

function authInfoFromRequest(request: Request) {
  const authorization = parseAuthorizationHeader(request.headers.get("authorization"));
  if (!authorization) return undefined;
  return {
    token: parseBearerHeader(authorization) ?? authorization,
    clientId: "authorization-pass-through",
    scopes: [],
  };
}

/** HTTP transport (deployed shape): per-request bearer forwarding, multi-actor. */
export function startHttp(config: V2Config): void {
  Deno.serve({ hostname: "0.0.0.0", port: config.port }, async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (url.pathname === "/readyz") {
      return Response.json({
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        stalwartBaseUrl: config.stalwartBaseUrl,
        confirmPolicy: config.confirmPolicy,
        envBearerFallback: config.allowEnvBearerFallback,
      });
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });

    if (
      !parseAuthorizationHeader(request.headers.get("authorization")) &&
      !(config.allowEnvBearerFallback && config.fallbackAuthorization)
    ) {
      return Response.json(
        { error: "Missing Authorization header." },
        {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer realm="${SERVER_NAME}", Basic realm="${SERVER_NAME}"`,
          },
        },
      );
    }

    const server = createMcpServer(config);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return await transport.handleRequest(request, {
      authInfo: authInfoFromRequest(request),
    });
  });
}

/** stdio transport (local shape): env-fallback auth allowed by default. */
export async function startStdio(config: V2Config): Promise<void> {
  const server = createMcpServer(config);
  await server.connect(new StdioServerTransport());
}

/** Entry used by v2.ts — dispatches on config.transport. */
export async function startMcp(config: V2Config): Promise<void> {
  if (config.transport === "stdio") {
    await startStdio(config);
  } else {
    startHttp(config);
  }
}
