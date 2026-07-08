/**
 * v2 typed JMAP client: request/call/batch + per-actor session cache + back-references +
 * invisible maxObjectsInGet/InSet chunking.
 * CONTRACT STUB — TODO(builder: B1-jmap). Signatures are normative; bodies throw.
 * See docs/v2-contracts.md §core/jmap/client. Reuse patterns from v1 src/jmap.ts.
 *
 * Auth: every method takes a JmapAuth — the client holds NO credential state beyond the
 * fingerprint-keyed session cache (multi-actor MCP deployments share one client instance).
 */
import type { V2Config } from "../config.ts";
import type { JmapSession } from "./session.ts";
import { SessionCache } from "./session.ts";
import type { MethodResponse } from "./envelopes.ts";
import type { Id } from "./types.ts";

/** Minimal actor slice the client needs (core/ops/registry.ts Actor satisfies this). */
export interface JmapAuth {
  /** Full Authorization header value; forwarded verbatim. NEVER log. */
  authorization: string;
  /** Cache/isolation key — HMAC fingerprint, safe to log. */
  fingerprint: string;
}

export type MethodCall = [string, Record<string, unknown>, string];

export interface JmapRequestResult {
  methodResponses: MethodResponse[];
  sessionState?: string;
}

export interface AccountRef {
  accountId: Id;
  session: JmapSession;
  apiUrl: string;
}

/**
 * RFC 8620 §3.7 ResultReference builder — `ref("c1", "Email/query", "/ids")` for use as a
 * `#argument` value. `*` in path maps over an array and flattens one level.
 */
export function ref(resultOf: string, name: string, path: string): {
  resultOf: string;
  name: string;
  path: string;
} {
  return { resultOf, name, path };
}

export class JmapClient {
  protected readonly sessions: SessionCache;

  constructor(protected readonly config: V2Config) {
    this.sessions = new SessionCache(config.sessionCacheTtlMs);
  }

  /** Fetch (or reuse cached) session for this actor. TTL = config.sessionCacheTtlMs. */
  session(_auth: JmapAuth): Promise<JmapSession> {
    throw new Error("not implemented: core/jmap/client session");
  }

  /** Drop the cached session (call when sessionState changes or on 401). */
  invalidateSession(_auth: JmapAuth): void {
    throw new Error("not implemented: core/jmap/client invalidateSession");
  }

  /**
   * Resolve the account to operate on: explicit account_id arg > primaryAccounts[capability] >
   * config.defaultAccountId > first account holding the capability. Throws when the account
   * lacks the required capability.
   */
  resolveAccount(
    _auth: JmapAuth,
    _requiredCapability?: string,
    _requestedAccountId?: string,
  ): Promise<AccountRef> {
    throw new Error("not implemented: core/jmap/client resolveAccount");
  }

  /**
   * POST one JMAP request (multiple method calls, back-references welcome). Retries once on a
   * stale cached session (401/`urn:ietf:params:jmap:error:*`). Throws on HTTP-level failure;
   * method-level errors stay in methodResponses for the caller / expectResponse().
   */
  request(_auth: JmapAuth, _using: string[], _calls: MethodCall[]): Promise<JmapRequestResult> {
    throw new Error("not implemented: core/jmap/client request");
  }

  /** Single-method sugar: request() + expectResponse() for call id "c1". */
  call(
    _auth: JmapAuth,
    _using: string[],
    _method: string,
    _args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented: core/jmap/client call");
  }

  /**
   * Foo/get with invisible chunking to the session's maxObjectsInGet; merges list/notFound
   * across chunks. Order of `list` follows input ids where feasible (spec does not guarantee).
   */
  getChunked(
    _auth: JmapAuth,
    _using: string[],
    _method: string,
    _args: { accountId: Id; ids: Id[]; [key: string]: unknown },
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented: core/jmap/client getChunked");
  }

  /**
   * Foo/set with invisible chunking to maxObjectsInSet; merges created/updated/destroyed and
   * the not* maps across chunks. Uniform mutations only (same-shaped update entries).
   */
  setChunked(
    _auth: JmapAuth,
    _using: string[],
    _method: string,
    _args: {
      accountId: Id;
      create?: Record<string, unknown>;
      update?: Record<string, unknown>;
      destroy?: Id[];
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented: core/jmap/client setChunked");
  }

  /** Upload bytes via the session uploadUrl template → {accountId, blobId, type, size}. */
  uploadBlob(
    _auth: JmapAuth,
    _accountId: Id,
    _bytes: Uint8Array,
    _contentType: string,
  ): Promise<{ accountId: Id; blobId: Id; type: string; size: number }> {
    throw new Error("not implemented: core/jmap/client uploadBlob");
  }

  /**
   * Expand the session downloadUrl template ({accountId},{blobId},{type},{name}) into an
   * authenticated-download URL string (the read_attachment "url" mode payload).
   */
  downloadUrlFor(
    _session: JmapSession,
    _accountId: Id,
    _blobId: Id,
    _name: string,
    _type: string,
  ): string {
    throw new Error("not implemented: core/jmap/client downloadUrlFor");
  }

  /** GET a blob's bytes via downloadUrlFor (CLI save-to-disk path; content mode for small). */
  downloadBlob(
    _auth: JmapAuth,
    _accountId: Id,
    _blobId: Id,
    _name?: string,
    _type?: string,
  ): Promise<Uint8Array> {
    throw new Error("not implemented: core/jmap/client downloadBlob");
  }
}
