/**
 * Confirmation policy + self-contained signed confirm tokens.
 * CONTRACT STUB — TODO(builder: B5-safety-compose). Types normative; bodies throw. Reuse the
 * HMAC/canonical-JSON machinery from v1 src/safety.ts, but v2 tokens are SELF-CONTAINED: one
 * opaque string embedding its own expiry (no confirmExpiresAt echo).
 *
 * Token format: "ld2." + base64url(canonical JSON claims) + "." + base64url(HMAC-SHA256(secret,
 * claims-json)). Claims: {op, account_id, ids_hash, payload_hash, actor, exp}. A mismatch on
 * verify returns an ACTIONABLE DIFF of what changed, not a bare "fingerprint mismatch".
 *
 * Policy matrix (docs/v2-design.md "Confirmation policy — lighter by default"):
 *   class none        → direct under every policy (trash moves included — that's what Trash is
 *                       for).
 *   class outward     → strict: two-phase; balanced: direct when ≤3 recipients AND not
 *                       query-powered, else two-phase; minimal: direct.
 *   class destructive → two-phase under every policy.
 *   class blast       → two-phase under every policy (also: query-powered bulk >100 items
 *                       escalates any op to blast).
 */
import type { ConfirmPolicy } from "./config.ts";
import type { ConfirmClass } from "./ops/registry.ts";

export type Gate = "direct" | "two_phase";

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

/** Decide direct vs two-phase for one call. Pure function — unit-test the whole matrix. */
export function effectiveGate(_signals: GateSignals): Gate {
  throw new Error("not implemented: core/safety effectiveGate");
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

export function mintConfirmToken(
  _secret: string,
  _intent: ConfirmIntent,
  _ttlMs?: number,
): Promise<string> {
  throw new Error("not implemented: core/safety mintConfirmToken");
}

export interface ConfirmVerdict {
  ok: boolean;
  reason?: "expired" | "mismatch" | "malformed";
  /** On mismatch: which claim drifted (e.g. resource_ids, payload_hash) and how. */
  diff?: Record<string, { expected: unknown; got: unknown }>;
}

export function verifyConfirmToken(
  _secret: string,
  _token: string,
  _intent: ConfirmIntent,
): Promise<ConfirmVerdict> {
  throw new Error("not implemented: core/safety verifyConfirmToken");
}

/** Deterministic JSON (sorted keys, arrays in order) — token/hash canonical form. */
export function canonicalJson(_value: unknown): string {
  throw new Error("not implemented: core/safety canonicalJson");
}

/** SHA-256 → base64url of canonicalJson(value). */
export function hashJson(_value: unknown): Promise<string> {
  throw new Error("not implemented: core/safety hashJson");
}

/**
 * HMAC-derived actor fingerprint (24 base64url chars) — same construction as v1
 * src/auth.ts tokenFingerprint. Used by both frontends to build registry.Actor.
 */
export function actorFingerprint(_secret: string, _credential: string): Promise<string> {
  throw new Error("not implemented: core/safety actorFingerprint");
}

/** Read-only JMAP method classifier for raw.jmap (v1 READ_ONLY_METHOD_RE semantics). */
export function isReadOnlyJmapMethod(_method: string): boolean {
  throw new Error("not implemented: core/safety isReadOnlyJmapMethod");
}
