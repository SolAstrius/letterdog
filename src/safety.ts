import type { ActorContext } from "./auth.ts";
import type { EnvConfig } from "./config.ts";

export interface DestructiveIntent {
  toolName: string;
  actorFingerprint: string;
  accountId: string;
  operation: "delete" | "update" | "send" | "move" | "admin" | "create";
  resourceKind: string;
  resourceIds: string[];
  payload: unknown;
  precondition?: Record<string, unknown>;
  expiresAt: string;
}

export interface ConfirmationChallenge {
  confirmationRequired: true;
  summary: string;
  confirmFingerprint: string;
  expiresAt: string;
  destructiveIntent: Omit<DestructiveIntent, "payload"> & { payloadHash: string };
}

export async function confirmationChallenge(
  config: EnvConfig,
  actor: ActorContext,
  intent: Omit<DestructiveIntent, "actorFingerprint" | "expiresAt">,
  summary: string,
): Promise<ConfirmationChallenge> {
  const fullIntent: DestructiveIntent = {
    ...intent,
    actorFingerprint: actor.actorFingerprint,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
  const payloadHash = await hashJson(fullIntent.payload);
  const confirmFingerprint = await signIntent(config.confirmationSecret, fullIntent);
  const { payload: _payload, ...withoutPayload } = fullIntent;
  return {
    confirmationRequired: true,
    summary,
    confirmFingerprint,
    expiresAt: fullIntent.expiresAt,
    destructiveIntent: { ...withoutPayload, payloadHash },
  };
}

export async function verifyConfirmation(
  config: EnvConfig,
  actor: ActorContext,
  intent: Omit<DestructiveIntent, "actorFingerprint" | "expiresAt">,
  confirmFingerprint: string,
  expiresAt: string,
): Promise<void> {
  const fullIntent: DestructiveIntent = {
    ...intent,
    actorFingerprint: actor.actorFingerprint,
    expiresAt,
  };
  if (Date.parse(expiresAt) < Date.now()) throw new Error("Confirmation fingerprint expired");
  const expected = await signIntent(config.confirmationSecret, fullIntent);
  if (expected !== confirmFingerprint) throw new Error("Confirmation fingerprint mismatch");
}

async function signIntent(secret: string, intent: DestructiveIntent): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalJson(intent)),
  );
  return base64Url(new Uint8Array(sig));
}

async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return base64Url(new Uint8Array(digest));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, sortValue(val)]),
    );
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
