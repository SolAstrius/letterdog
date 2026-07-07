import type { RequestHandlerExtra } from "@mcp/shared/protocol";
import type { ServerNotification, ServerRequest } from "@mcp/types";
import type { EnvConfig } from "./config.ts";

export interface RequestAuth {
  bearer: string;
  source: "http-authorization" | "env-fallback";
}

export interface ActorContext {
  auth: RequestAuth;
  requestId: string;
  actorFingerprint: string;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function authInfoFromRequest(request: Request) {
  const bearer = parseBearerHeader(request.headers.get("authorization"));
  if (!bearer) return undefined;
  return {
    token: bearer,
    clientId: "bearer-pass-through",
    scopes: [],
  };
}

export function parseBearerHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

export async function buildActorContext(
  config: EnvConfig,
  extra: ToolExtra,
): Promise<ActorContext> {
  const bearer = extra.authInfo?.token ||
    parseBearerHeader(extra.requestInfo?.headers.get("authorization") ?? null);

  if (bearer) {
    return {
      auth: { bearer, source: "http-authorization" },
      requestId: String(extra.requestId),
      actorFingerprint: await tokenFingerprint(config.confirmationSecret, bearer),
    };
  }

  if (config.allowEnvBearerFallback && config.fallbackBearer) {
    return {
      auth: { bearer: config.fallbackBearer, source: "env-fallback" },
      requestId: String(extra.requestId),
      actorFingerprint: await tokenFingerprint(config.confirmationSecret, config.fallbackBearer),
    };
  }

  throw new Error("Missing bearer token. Send Authorization: Bearer <token>.");
}

async function tokenFingerprint(secret: string, bearer: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(bearer));
  return base64Url(new Uint8Array(sig)).slice(0, 24);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
