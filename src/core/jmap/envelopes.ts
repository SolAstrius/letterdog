/**
 * Response normalization: /get, /query, /set → uniform envelopes; SetError discriminated union.
 * CONTRACT STUB — TODO(builder: B1-jmap). Types are normative; function bodies throw.
 * Grounded in docs/rfc-notes/rfc8620-8621-jmap-core-mail.md §1.2–1.6.
 *
 * Rule (design "Output economy"): op responses NEVER expose raw {query, get} method pairs —
 * they return an Envelope. Keys are snake_case because envelopes are model-facing.
 */
import type { Id } from "./types.ts";

/** RFC 8620 §3.6.2 per-item SetError + registered extras (typed, passthrough for the rest). */
export interface SetError {
  type:
    | "forbidden"
    | "overQuota"
    | "tooLarge"
    | "rateLimit"
    | "notFound"
    | "invalidPatch"
    | "willDestroy"
    | "invalidProperties"
    | "singleton"
    | "alreadyExists"
    | "blobNotFound"
    | "tooManyKeywords"
    | "tooManyMailboxes"
    | "invalidEmail"
    | "tooManyRecipients"
    | "noRecipients"
    | "invalidRecipients"
    | "forbiddenMailFrom"
    | "forbiddenFrom"
    | "forbiddenToSend"
    | "cannotUnsend"
    | "mailboxHasChild"
    | "mailboxHasEmail"
    | "calendarHasEvent"
    | "noSupportedScheduleMethods"
    | string;
  description?: string | null;
  properties?: string[];
  existingId?: Id;
  notFound?: Id[];
  maxRecipients?: number;
  invalidRecipients?: string[];
  maxSize?: number;
  [key: string]: unknown;
}

/** RFC 8620 §3.6.2 method-level error object (["error", {...}, callId]). */
export interface MethodError {
  type: string;
  description?: string;
  [key: string]: unknown;
}

/** Thrown by the client when a method call in a request came back as ["error", ...]. */
export class JmapMethodError extends Error {
  constructor(
    readonly method: string,
    readonly callId: string,
    readonly detail: MethodError,
  ) {
    super(
      `JMAP ${method} error: ${detail.type}${detail.description ? ` ${detail.description}` : ""}`,
    );
    this.name = "JmapMethodError";
  }
}

/**
 * The uniform read envelope every op returns (design: {items, total?, not_found?, failed?,
 * state}). `items` are already projected by the op handler.
 */
export interface Envelope<T = unknown> {
  items: T[];
  /** Present only when the caller requested calculateTotal. */
  total?: number;
  not_found?: Id[];
  /** Per-item failures for batch mutations, keyed by input id / creation id. */
  failed?: Record<string, SetError>;
  state?: string;
}

/** Normalized /set outcome — the mutation-side envelope building block. */
export interface SetOutcome<T = Record<string, unknown>> {
  /** creationId → server-set props (incl. id). */
  created: Record<string, T>;
  /** id → server-changed-beyond-patch props (or null). */
  updated: Record<string, T | null>;
  destroyed: Id[];
  /** merged notCreated + notUpdated + notDestroyed. */
  failed: Record<string, SetError>;
  old_state?: string | null;
  new_state?: string;
}

/** Raw method response triple. */
export type MethodResponse = [string, Record<string, unknown>, string];

/**
 * Normalize a Foo/get response body into an Envelope (list → items, notFound → not_found,
 * state → state). Does NOT project — callers map items through core/projections.ts.
 */
export function envelopeFromGet<T = Record<string, unknown>>(
  _response: Record<string, unknown>,
): Envelope<T> {
  throw new Error("not implemented: core/jmap/envelopes envelopeFromGet");
}

/** Normalize a Foo/query response body: ids → items, total?, queryState → state, position. */
export function envelopeFromQuery(
  _response: Record<string, unknown>,
): Envelope<Id> & { position?: number } {
  throw new Error("not implemented: core/jmap/envelopes envelopeFromQuery");
}

/**
 * Normalize a Foo/set response body into a SetOutcome, merging the three not* maps into
 * `failed`. Never throws on per-item failures — that is the point.
 */
export function setOutcome<T = Record<string, unknown>>(
  _response: Record<string, unknown>,
): SetOutcome<T> {
  throw new Error("not implemented: core/jmap/envelopes setOutcome");
}

/**
 * Pick a named method response out of methodResponses (first match by callId), throwing
 * JmapMethodError when the slot holds ["error", ...].
 */
export function expectResponse(
  _responses: MethodResponse[],
  _method: string,
  _callId: string,
): Record<string, unknown> {
  throw new Error("not implemented: core/jmap/envelopes expectResponse");
}
