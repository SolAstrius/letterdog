/**
 * Confirmation policy + self-contained signed confirm tokens.
 *
 * v2 tokens are SELF-CONTAINED: one opaque string embedding its own expiry (no confirmExpiresAt
 * echo). `verifyConfirmToken()` needs no extra timestamp argument — the expiry travels inside the
 * token.
 *
 * Token format: "ld2." + base64url(canonical JSON claims) + "." + base64url(HMAC-SHA256(secret,
 * "ld2." + base64url(claims-json))). Claims:
 *   {op, account_id, ids_hash, payload_hash, actor, exp}
 * The signature covers the versioned, encoded claims segment, so tampering with any claim (or the
 * version prefix) invalidates it. A mismatch on verify returns an ACTIONABLE DIFF of which claim
 * drifted (op / account_id / resource_ids / payload_hash / actor), not a bare
 * "fingerprint mismatch".
 *
 * Policy matrix (docs/v2-design.md "Confirmation policy — lighter by default"):
 *   class none        → direct under every policy (trash moves included — that's what Trash is
 *                       for).
 *   class outward     → strict: two-phase; balanced: direct when ≤3 recipients AND not
 *                       query-powered, else two-phase; minimal: direct.
 *   class destructive → two-phase under every policy.
 *   class blast       → two-phase under every policy.
 *   escalation        → query-powered bulk touching >100 items escalates ANY op to blast
 *                       (two-phase), overriding an otherwise-direct verdict.
 */
import type { ConfirmPolicy } from "./config.ts";
import type { ConfirmClass } from "./ops/registry.ts";

export type Gate = "direct" | "two_phase";

/** Token version tag. Bumped only on a breaking claims-shape change. */
const TOKEN_VERSION = "ld2";
const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Query-powered bulk above this item count escalates any op to blast. */
const BULK_BLAST_THRESHOLD = 100;

const textEncoder = new TextEncoder();

/** Canonical intent a token signs — everything that must not drift between phases. */
export interface ConfirmIntent {
  /** Dotted op name. */
  op: string;
  account_id: string;
  /** Sorted resource ids (or ["query"] for query-powered ops). */
  resource_ids: string[];
  /** The mutation payload (hashed into the token, not embedded). */
  payload: unknown;
  /** Actor fingerprint (registry.Actor.fingerprint). */
  actor_fingerprint: string;
}

/** Dynamic inputs that escalate/de-escalate the static confirmClass. */
export interface GateSignals {
  /** Static class from the OpDefinition. */
  confirmClass: ConfirmClass;
  policy: ConfirmPolicy;
  /** Outward recipient count (send/reply/forward/invite), when known. */
  recipientCount?: number;
  /** True when targets come from a query instead of explicit ids. */
  queryPowered?: boolean;
  /** Number of items the mutation touches. */
  itemCount?: number;
  /** Per-call de-escalation (e.g. delete_emails with permanent:false → none). */
  effectiveClassOverride?: ConfirmClass;
}

/**
 * Decide direct vs two-phase for one call. Pure function — unit-test the whole matrix.
 *
 * Order of reasoning:
 *  1. Start from `effectiveClassOverride ?? confirmClass` (per-call de-escalation, e.g. a
 *     non-permanent trash move on a "destructive" op collapses to "none").
 *  2. Query-powered bulk over the threshold escalates any class to "blast".
 *  3. Apply the class × policy table.
 */
export function effectiveGate(signals: GateSignals): Gate {
  let cls: ConfirmClass = signals.effectiveClassOverride ?? signals.confirmClass;

  if (
    signals.queryPowered === true &&
    (signals.itemCount ?? 0) > BULK_BLAST_THRESHOLD
  ) {
    cls = "blast";
  }

  switch (cls) {
    case "none":
      return "direct";
    case "destructive":
    case "blast":
      return "two_phase";
    case "outward": {
      switch (signals.policy) {
        case "strict":
          return "two_phase";
        case "minimal":
          return "direct";
        case "balanced": {
          const fewRecipients = (signals.recipientCount ?? 0) <= 3;
          const notQueryPowered = signals.queryPowered !== true;
          return fewRecipients && notQueryPowered ? "direct" : "two_phase";
        }
      }
      // Unreachable, but keeps the type checker satisfied for exotic policy values.
      return "two_phase";
    }
  }
}

/**
 * The two-phase challenge an op returns instead of executing. `preview` uses the BRIEF
 * projection of affected items; `confirm_token` is self-contained (embedded expiry, default
 * TTL 5 min).
 */
export interface ConfirmChallenge {
  confirmation_required: true;
  summary: string;
  preview?: unknown;
  confirm_token: string;
  expires_at: string;
}

/** Internal claims shape encoded inside the token. */
interface TokenClaims {
  op: string;
  account_id: string;
  ids_hash: string;
  payload_hash: string;
  actor: string;
  /** Epoch milliseconds expiry. */
  exp: number;
}

async function claimsFromIntent(intent: ConfirmIntent, exp: number): Promise<TokenClaims> {
  return {
    op: intent.op,
    account_id: intent.account_id,
    ids_hash: await hashJson([...intent.resource_ids].sort()),
    payload_hash: await hashJson(intent.payload),
    actor: intent.actor_fingerprint,
    exp,
  };
}

export async function mintConfirmToken(
  secret: string,
  intent: ConfirmIntent,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<string> {
  const exp = Date.now() + ttlMs;
  const claims = await claimsFromIntent(intent, exp);
  const claimsSegment = base64UrlEncode(textEncoder.encode(canonicalJson(claims)));
  const signingInput = `${TOKEN_VERSION}.${claimsSegment}`;
  const sig = await hmac(secret, signingInput);
  return `${signingInput}.${sig}`;
}

export interface ConfirmVerdict {
  ok: boolean;
  reason?: "expired" | "mismatch" | "malformed";
  /** On mismatch: which claim drifted (e.g. resource_ids, payload_hash) and how. */
  diff?: Record<string, { expected: unknown; got: unknown }>;
}

export async function verifyConfirmToken(
  secret: string,
  token: string,
  intent: ConfirmIntent,
): Promise<ConfirmVerdict> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const [version, claimsSegment, providedSig] = parts;

  // Signature check first: an invalid signature means the token is forged/tampered, and we must
  // NOT trust its claims for the diff. Use constant-time compare.
  const signingInput = `${version}.${claimsSegment}`;
  const expectedSig = await hmac(secret, signingInput);
  if (!timingSafeEqualStrings(expectedSig, providedSig)) {
    return { ok: false, reason: "mismatch" };
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(textDecode(base64UrlDecode(claimsSegment))) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (typeof claims.exp !== "number" || Date.now() > claims.exp) {
    return { ok: false, reason: "expired" };
  }

  // Recompute what the claims SHOULD be for the intent presented now and diff any drift. The
  // signature already proved the token is authentic, so a difference here means the caller
  // changed the request between phases.
  const expected = await claimsFromIntent(intent, claims.exp);
  const diff: Record<string, { expected: unknown; got: unknown }> = {};
  if (expected.op !== claims.op) diff.op = { expected: expected.op, got: claims.op };
  if (expected.account_id !== claims.account_id) {
    diff.account_id = { expected: expected.account_id, got: claims.account_id };
  }
  if (expected.ids_hash !== claims.ids_hash) {
    diff.resource_ids = { expected: intent.resource_ids, got: "differs (ids_hash mismatch)" };
  }
  if (expected.payload_hash !== claims.payload_hash) {
    diff.payload_hash = { expected: expected.payload_hash, got: claims.payload_hash };
  }
  if (expected.actor !== claims.actor) {
    diff.actor = { expected: expected.actor, got: claims.actor };
  }

  if (Object.keys(diff).length > 0) {
    return { ok: false, reason: "mismatch", diff };
  }
  return { ok: true };
}

/** Deterministic JSON (sorted keys, arrays in order) — token/hash canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** SHA-256 → base64url of canonicalJson(value). */
export async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(canonicalJson(value)),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * HMAC-derived actor fingerprint (24 base64url chars) — same construction as v1
 * src/auth.ts tokenFingerprint. Used by both frontends to build registry.Actor.
 */
export async function actorFingerprint(secret: string, credential: string): Promise<string> {
  const sig = await hmac(secret, credential);
  return sig.slice(0, 24);
}

/** Read-only JMAP method classifier for raw.jmap (v1 READ_ONLY_METHOD_RE semantics). */
export function isReadOnlyJmapMethod(method: string): boolean {
  return READ_ONLY_METHOD_RE.test(method);
}

/**
 * Read-only allowlist: any method ending in /get, /query, /changes, /queryChanges, /parse,
 * /lookup, plus Core/echo and Principal/getAvailability. Everything else is treated as mutating.
 * Mirrors v1 src/constants.ts READ_ONLY_METHOD_RE.
 */
const READ_ONLY_METHOD_RE =
  /\/(get|query|changes|queryChanges|parse|lookup)$|^Core\/echo$|^Principal\/getAvailability$/;

// --- internal crypto/encoding helpers -----------------------------------------------------------

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, textEncoder.encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => [key, sortValue(val)]),
    );
  }
  return value;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function textDecode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Length-independent-leak-free string compare over equal-length base64url signatures. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
