import type { RequestHandlerExtra } from "@mcp/shared/protocol";
import type { ServerNotification, ServerRequest } from "@mcp/types";
import type { EnvConfig } from "./config.ts";

export interface RequestAuth {
  authorization: string;
  bearer?: string;
  source: "http-authorization" | "env-fallback";
}

export interface ActorContext {
  auth: RequestAuth;
  requestId: string;
  actorFingerprint: string;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export function authInfoFromRequest(request: Request) {
  const authorization = parseAuthorizationHeader(request.headers.get("authorization"));
  if (!authorization) return undefined;
  return {
    token: parseBearerHeader(authorization) ?? authorization,
    clientId: "authorization-pass-through",
    scopes: [],
  };
}

export function parseAuthorizationHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  return /^[A-Za-z][A-Za-z0-9+.-]*\s+.+$/.test(trimmed) ? trimmed : undefined;
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
  const authorization = parseAuthorizationHeader(headerFromExtra(extra, "authorization")) ??
    authorizationFromAuthInfo(extra.authInfo?.token);

  if (authorization) {
    return {
      auth: {
        authorization,
        bearer: parseBearerHeader(authorization),
        source: "http-authorization",
      },
      requestId: String(extra.requestId),
      actorFingerprint: await tokenFingerprint(config.confirmationSecret, authorization),
    };
  }

  if (config.allowEnvBearerFallback && config.fallbackAuthorization) {
    return {
      auth: {
        authorization: config.fallbackAuthorization,
        bearer: parseBearerHeader(config.fallbackAuthorization),
        source: "env-fallback",
      },
      requestId: String(extra.requestId),
      actorFingerprint: await tokenFingerprint(
        config.confirmationSecret,
        config.fallbackAuthorization,
      ),
    };
  }

  throw new Error("Missing Authorization header.");
}

function authorizationFromAuthInfo(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return parseAuthorizationHeader(token) ?? `Bearer ${token}`;
}

function headerFromExtra(extra: ToolExtra, name: string): string | null {
  const headers = extra.requestInfo?.headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const exact = record[name] ?? record[name.toLowerCase()];
  if (Array.isArray(exact)) return exact.join(", ");
  return exact ?? null;
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
