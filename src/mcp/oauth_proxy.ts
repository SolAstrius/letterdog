/**
 * OAuth 2.0 authorization-server PROXY (OAUTH_PROXY mode).
 *
 * The connector presents itself to MCP clients as the authorization server (issuer = this connector)
 * and forwards each leg to Stalwart, patching the three things that otherwise break a direct Stalwart
 * flow for clients like claude.ai:
 *   /register  — DOWNGRADES the client's Dynamic Client Registration to a *public* PKCE client
 *                (token_endpoint_auth_method="none") before forwarding, so anonymous registration is
 *                allowed (Stalwart refuses to mint a *secret* to an unauthenticated caller, but public
 *                clients register fine, and PKCE — not a secret — is the proof-of-possession). No API
 *                key needed. Also adds this connector's /callback to the client's redirect_uris so the
 *                code comes back here first. (Optional REGISTRATION_BEARER forces confidential instead.)
 *   /authorize — 302 to Stalwart's login, rewriting `resource` to the Stalwart issuer (Stalwart rejects
 *                any other resource indicator) and carrying an HMAC-signed state that remembers the
 *                client's real redirect_uri + state.
 *   /callback  — receives Stalwart's code and re-emits it to the client's real redirect_uri with
 *                `iss` = this connector (so the client's RFC 9207 issuer check passes).
 *   /token     — proxies to Stalwart's token endpoint, rewriting `redirect_uri` (to /callback, which the
 *                code was bound to) and `resource`.
 *
 * Everything is stateless: the only cross-request state (the client's redirect_uri/state) round-trips
 * inside the signed `state` parameter, so it survives restarts and needs no store.
 */
import type { V2Config } from "../core/config.ts";

interface UpstreamMeta {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

let upstreamCache: UpstreamMeta | undefined;

/** Fetch (and cache) Stalwart's real OAuth endpoints from its authorization-server metadata. */
async function upstreamMeta(config: V2Config): Promise<UpstreamMeta> {
  if (upstreamCache) return upstreamCache;
  const res = await fetch(`${config.stalwartBaseUrl}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`upstream AS metadata ${res.status}`);
  const m = await res.json() as Partial<UpstreamMeta>;
  if (!m.authorization_endpoint || !m.token_endpoint || !m.registration_endpoint) {
    throw new Error("upstream AS metadata missing endpoints");
  }
  upstreamCache = {
    authorization_endpoint: m.authorization_endpoint,
    token_endpoint: m.token_endpoint,
    registration_endpoint: m.registration_endpoint,
  };
  return upstreamCache;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
};

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** Sign {redirectUri,state} into an opaque state string the client can't tamper with. */
async function packState(secret: string, redirectUri: string, state: string): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify({ r: redirectUri, s: state })));
  const sig = b64urlEncode(await hmac(secret, payload));
  return `${payload}.${sig}`;
}

async function unpackState(
  secret: string,
  packed: string,
): Promise<{ redirectUri: string; state: string } | undefined> {
  const [payload, sig] = packed.split(".");
  if (!payload || !sig) return undefined;
  const expected = b64urlEncode(await hmac(secret, payload));
  if (sig !== expected) return undefined;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    if (typeof obj?.r !== "string") return undefined;
    return { redirectUri: obj.r, state: typeof obj.s === "string" ? obj.s : "" };
  } catch {
    return undefined;
  }
}

/** AS metadata advertising THIS connector as the issuer; all endpoints resolve back here. */
function asMetadata(config: V2Config, baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: config.oauthScopesSupported,
    authorization_response_iss_parameter_supported: true,
  };
}

function callbackUri(baseUrl: string): string {
  return `${baseUrl}/callback`;
}

/**
 * POST /register — forward the DCR to Stalwart, adding our /callback redirect. By default the client
 * is DOWNGRADED to public (token_endpoint_auth_method="none") so anonymous registration is allowed
 * with no secret; PKCE is the proof-of-possession. If REGISTRATION_BEARER is set, keep the client's
 * requested (possibly confidential) auth method and authenticate the registration with that key.
 */
async function handleRegister(
  request: Request,
  config: V2Config,
  baseUrl: string,
): Promise<Response> {
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return Response.json({ error: "invalid_client_metadata" }, { status: 400, headers: CORS });
  }
  const clientRedirects = Array.isArray(body.redirect_uris) ? body.redirect_uris as string[] : [];
  const upstreamBody: Record<string, unknown> = {
    ...body,
    redirect_uris: Array.from(new Set([...clientRedirects, callbackUri(baseUrl)])),
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.registrationBearer) {
    headers["Authorization"] = `Bearer ${config.registrationBearer}`;
  } else {
    // Keyless path: register a public PKCE client (Stalwart allows anonymous public registration).
    upstreamBody.token_endpoint_auth_method = "none";
  }
  const meta = await upstreamMeta(config);
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
  });
  const text = await res.text();
  let out = text;
  try {
    const json = JSON.parse(text);
    // Echo the client's own redirect_uris back so it sees what it registered (not our /callback).
    if (clientRedirects.length && Array.isArray(json.redirect_uris)) {
      json.redirect_uris = clientRedirects;
    }
    out = JSON.stringify(json);
  } catch { /* pass upstream body through unchanged */ }
  return new Response(out, {
    status: res.status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** GET /authorize — 302 to Stalwart's login, rewriting resource + signing the client's redirect/state. */
async function handleAuthorize(
  request: Request,
  config: V2Config,
  baseUrl: string,
): Promise<Response> {
  const inParams = new URL(request.url).searchParams;
  const clientRedirect = inParams.get("redirect_uri");
  if (!clientRedirect) {
    return Response.json({ error: "invalid_request", error_description: "redirect_uri required" }, {
      status: 400,
    });
  }
  const meta = await upstreamMeta(config);
  const state = await packState(
    config.confirmationSecret,
    clientRedirect,
    inParams.get("state") ?? "",
  );
  const out = new URL(meta.authorization_endpoint);
  const p = out.searchParams;
  p.set("response_type", inParams.get("response_type") ?? "code");
  const clientId = inParams.get("client_id");
  if (clientId) p.set("client_id", clientId);
  p.set("redirect_uri", callbackUri(baseUrl));
  p.set("state", state);
  // Rewrite the resource indicator: Stalwart only accepts its own issuer.
  p.set("resource", config.stalwartBaseUrl);
  for (const k of ["scope", "code_challenge", "code_challenge_method", "nonce", "prompt"]) {
    const v = inParams.get(k);
    if (v !== null) p.set(k, v);
  }
  return Response.redirect(out.toString(), 302);
}

/** GET /callback — take Stalwart's code and re-emit it to the client with iss = this connector. */
async function handleCallback(
  request: Request,
  config: V2Config,
  baseUrl: string,
): Promise<Response> {
  const inParams = new URL(request.url).searchParams;
  const packed = inParams.get("state") ?? "";
  const unpacked = await unpackState(config.confirmationSecret, packed);
  if (!unpacked) return new Response("Invalid state", { status: 400 });

  const dest = new URL(unpacked.redirectUri);
  const error = inParams.get("error");
  if (error) {
    dest.searchParams.set("error", error);
    const desc = inParams.get("error_description");
    if (desc) dest.searchParams.set("error_description", desc);
  } else {
    const code = inParams.get("code");
    if (code) dest.searchParams.set("code", code);
  }
  if (unpacked.state) dest.searchParams.set("state", unpacked.state);
  dest.searchParams.set("iss", baseUrl);
  return Response.redirect(dest.toString(), 302);
}

/** POST /token — proxy to Stalwart, rewriting redirect_uri (to /callback) and resource. */
async function handleToken(
  request: Request,
  config: V2Config,
  baseUrl: string,
): Promise<Response> {
  const raw = await request.text();
  const form = new URLSearchParams(raw);
  if (form.has("redirect_uri")) form.set("redirect_uri", callbackUri(baseUrl));
  if (form.has("resource")) form.set("resource", config.stalwartBaseUrl);
  const meta = await upstreamMeta(config);
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json",
  };
  // Forward client authentication (client_secret_basic sends it as an Authorization header).
  const auth = request.headers.get("authorization");
  if (auth) headers["Authorization"] = auth;
  const res = await fetch(meta.token_endpoint, { method: "POST", headers, body: form.toString() });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      ...CORS,
      "Content-Type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

/**
 * Dispatch an OAuth-proxy request. Returns a Response for proxy paths, or null if the path is not
 * one this proxy owns (so the caller falls through to its normal routing). Only active when
 * config.oauthProxy is true.
 */
export function handleOAuthProxyRequest(
  request: Request,
  config: V2Config,
  baseUrl: string,
): Promise<Response | null> | Response | null {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === "OPTIONS" && ["/register", "/token"].includes(pathname)) {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (
    method === "GET" &&
    (pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/.well-known/openid-configuration")
  ) {
    return Response.json(asMetadata(config, baseUrl), { headers: CORS });
  }
  if (method === "POST" && pathname === "/register") {
    return handleRegister(request, config, baseUrl);
  }
  if (method === "GET" && pathname === "/authorize") {
    return handleAuthorize(request, config, baseUrl);
  }
  if (method === "GET" && pathname === "/callback") return handleCallback(request, config, baseUrl);
  if (method === "POST" && pathname === "/token") return handleToken(request, config, baseUrl);
  return null;
}
