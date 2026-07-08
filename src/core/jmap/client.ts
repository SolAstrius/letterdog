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
import { coreLimits, SessionCache } from "./session.ts";
import type { MethodResponse } from "./envelopes.ts";
import { expectResponse } from "./envelopes.ts";
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

/** Expand a URI Template level 1 (RFC 6570) — `{var}` with percent-encoding of the value. */
export function expandUriTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined ? "" : encodeURIComponent(value);
  });
}

export class JmapClient {
  protected readonly sessions: SessionCache;

  constructor(protected readonly config: V2Config) {
    this.sessions = new SessionCache(config.sessionCacheTtlMs);
  }

  /** Fetch (or reuse cached) session for this actor. TTL = config.sessionCacheTtlMs. */
  async session(auth: JmapAuth): Promise<JmapSession> {
    const cached = this.sessions.get(auth.fingerprint);
    if (cached) return cached;
    const session = await this.fetchSession(auth);
    this.sessions.put(auth.fingerprint, session);
    return session;
  }

  /** GET /jmap/session, forwarding the Authorization header verbatim. NEVER log it. */
  private async fetchSession(auth: JmapAuth): Promise<JmapSession> {
    const response = await fetch(`${this.config.stalwartBaseUrl}/jmap/session`, {
      headers: { Authorization: auth.authorization },
    });
    if (!response.ok) {
      throw new Error(`JMAP session failed: HTTP ${response.status}`);
    }
    return await response.json() as JmapSession;
  }

  /** Drop the cached session (call when sessionState changes or on 401). */
  invalidateSession(auth: JmapAuth): void {
    this.sessions.invalidate(auth.fingerprint);
  }

  /**
   * Resolve the account to operate on: explicit account_id arg > primaryAccounts[capability] >
   * config.defaultAccountId > first account holding the capability. Throws when the account
   * lacks the required capability.
   */
  async resolveAccount(
    auth: JmapAuth,
    requiredCapability?: string,
    requestedAccountId?: string,
  ): Promise<AccountRef> {
    const session = await this.session(auth);
    const accountId = requestedAccountId ||
      (requiredCapability ? session.primaryAccounts?.[requiredCapability] : undefined) ||
      this.config.defaultAccountId ||
      firstAccountWithCapability(session, requiredCapability);

    if (!accountId || !session.accounts?.[accountId]) {
      throw new Error(`No JMAP account found for capability ${requiredCapability ?? "(any)"}`);
    }

    if (requiredCapability) {
      const account = session.accounts[accountId];
      if (!account.accountCapabilities?.[requiredCapability]) {
        throw new Error(`Account ${accountId} lacks capability ${requiredCapability}`);
      }
    }

    return {
      accountId,
      session,
      apiUrl: session.apiUrl || `${this.config.stalwartBaseUrl}/jmap/`,
    };
  }

  /**
   * POST one JMAP request (multiple method calls, back-references welcome). Retries once on a
   * stale cached session (401) after invalidating it. Throws on HTTP-level failure; method-level
   * errors stay in methodResponses for the caller / expectResponse().
   */
  async request(
    auth: JmapAuth,
    using: string[],
    calls: MethodCall[],
  ): Promise<JmapRequestResult> {
    const session = await this.session(auth);
    let result = await this.post(auth, session, using, calls);
    if (result.status === 401) {
      // Cached session may be stale (rotated credential / expired). Refetch once and retry.
      this.invalidateSession(auth);
      const fresh = await this.session(auth);
      result = await this.post(auth, fresh, using, calls);
    }
    if (!result.response.ok) {
      throw new Error(`JMAP call failed: HTTP ${result.response.status}`);
    }
    const body = result.body as JmapRequestResult;
    // A changed sessionState means cached session urls/accounts may be outdated — drop it so the
    // next call refetches (RFC 8620 §2: state changes when any Session property changes).
    if (body.sessionState && session.state && body.sessionState !== session.state) {
      this.invalidateSession(auth);
    }
    return body;
  }

  private async post(
    auth: JmapAuth,
    session: JmapSession,
    using: string[],
    calls: MethodCall[],
  ): Promise<{ status: number; response: Response; body: unknown }> {
    const apiUrl = session.apiUrl || `${this.config.stalwartBaseUrl}/jmap/`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: auth.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ using, methodCalls: calls }),
    });
    const status = response.status;
    let body: unknown = undefined;
    if (response.ok) {
      body = await response.json();
    } else {
      // Drain the body so the connection can be reused; ignore parse failures.
      await response.text().catch(() => {});
    }
    return { status, response, body };
  }

  /** Single-method sugar: request() + expectResponse() for call id "c1". */
  async call(
    auth: JmapAuth,
    using: string[],
    method: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const result = await this.request(auth, using, [[method, args, "c1"]]);
    return expectResponse(result.methodResponses, method, "c1");
  }

  /**
   * Foo/get with invisible chunking to the session's maxObjectsInGet; merges list/notFound
   * across chunks. Order of `list` follows input ids where feasible (spec does not guarantee).
   */
  async getChunked(
    auth: JmapAuth,
    using: string[],
    method: string,
    args: { accountId: Id; ids: Id[]; [key: string]: unknown },
  ): Promise<Record<string, unknown>> {
    const session = await this.session(auth);
    const limit = coreLimits(session).maxObjectsInGet;
    const chunks = chunk(args.ids, limit);
    if (chunks.length <= 1) {
      return this.call(auth, using, method, args);
    }

    const list: unknown[] = [];
    const notFound: Id[] = [];
    let state: string | undefined;
    for (const ids of chunks) {
      const res = await this.call(auth, using, method, { ...args, ids });
      if (Array.isArray(res.list)) list.push(...res.list);
      if (Array.isArray(res.notFound)) notFound.push(...res.notFound as Id[]);
      if (typeof res.state === "string") state = res.state;
    }
    return { accountId: args.accountId, list, notFound, state };
  }

  /**
   * Foo/set with invisible chunking to maxObjectsInSet; merges created/updated/destroyed and
   * the not* maps across chunks. Uniform mutations only (same-shaped update entries).
   */
  async setChunked(
    auth: JmapAuth,
    using: string[],
    method: string,
    args: {
      accountId: Id;
      create?: Record<string, unknown>;
      update?: Record<string, unknown>;
      destroy?: Id[];
      [key: string]: unknown;
    },
  ): Promise<Record<string, unknown>> {
    const session = await this.session(auth);
    const limit = coreLimits(session).maxObjectsInSet;

    // Flatten create/update/destroy into a single ordered list of operations, then repack into
    // chunks each ≤ limit combined operations (RFC 8620 §1.1: maxObjectsInSet is the combined
    // create+update+destroy count).
    const createEntries = Object.entries(args.create ?? {});
    const updateEntries = Object.entries(args.update ?? {});
    const destroyIds = args.destroy ?? [];
    const total = createEntries.length + updateEntries.length + destroyIds.length;

    const { create: _c, update: _u, destroy: _d, ...rest } = args;
    if (total <= limit) {
      return this.call(auth, using, method, args);
    }

    type Op =
      | { kind: "create"; id: string; value: unknown }
      | { kind: "update"; id: string; value: unknown }
      | { kind: "destroy"; id: string };
    const ops: Op[] = [
      ...createEntries.map(([id, value]) => ({ kind: "create", id, value } as Op)),
      ...updateEntries.map(([id, value]) => ({ kind: "update", id, value } as Op)),
      ...destroyIds.map((id) => ({ kind: "destroy", id } as Op)),
    ];

    const created: Record<string, unknown> = {};
    const updated: Record<string, unknown> = {};
    const destroyed: Id[] = [];
    const notCreated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const notDestroyed: Record<string, unknown> = {};
    let oldState: string | null | undefined;
    let newState: string | undefined;

    for (const group of chunk(ops, limit)) {
      const create: Record<string, unknown> = {};
      const update: Record<string, unknown> = {};
      const destroy: Id[] = [];
      for (const op of group) {
        if (op.kind === "create") create[op.id] = op.value;
        else if (op.kind === "update") update[op.id] = op.value;
        else destroy.push(op.id);
      }
      const res = await this.call(auth, using, method, {
        ...rest,
        ...(Object.keys(create).length ? { create } : {}),
        ...(Object.keys(update).length ? { update } : {}),
        ...(destroy.length ? { destroy } : {}),
      });
      Object.assign(created, res.created ?? {});
      Object.assign(updated, res.updated ?? {});
      if (Array.isArray(res.destroyed)) destroyed.push(...res.destroyed as Id[]);
      Object.assign(notCreated, res.notCreated ?? {});
      Object.assign(notUpdated, res.notUpdated ?? {});
      Object.assign(notDestroyed, res.notDestroyed ?? {});
      if (oldState === undefined && "oldState" in res) oldState = res.oldState as string | null;
      if (typeof res.newState === "string") newState = res.newState;
    }

    return {
      accountId: args.accountId,
      oldState,
      newState,
      created,
      updated,
      destroyed,
      notCreated,
      notUpdated,
      notDestroyed,
    };
  }

  /** Upload bytes via the session uploadUrl template → {accountId, blobId, type, size}. */
  async uploadBlob(
    auth: JmapAuth,
    accountId: Id,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ accountId: Id; blobId: Id; type: string; size: number }> {
    const session = await this.session(auth);
    if (!session.uploadUrl) throw new Error("JMAP session exposes no uploadUrl.");
    const url = expandUriTemplate(session.uploadUrl, { accountId });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: auth.authorization,
        "Content-Type": contentType,
      },
      body: bytes as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`JMAP blob upload failed: HTTP ${response.status}`);
    }
    return await response.json() as { accountId: Id; blobId: Id; type: string; size: number };
  }

  /**
   * Expand the session downloadUrl template ({accountId},{blobId},{type},{name}) into an
   * authenticated-download URL string (the read_attachment "url" mode payload).
   */
  downloadUrlFor(
    session: JmapSession,
    accountId: Id,
    blobId: Id,
    name: string,
    type: string,
  ): string {
    if (!session.downloadUrl) throw new Error("JMAP session exposes no downloadUrl.");
    return expandUriTemplate(session.downloadUrl, { accountId, blobId, name, type });
  }

  /** GET a blob's bytes via downloadUrlFor (CLI save-to-disk path; content mode for small). */
  async downloadBlob(
    auth: JmapAuth,
    accountId: Id,
    blobId: Id,
    name = "blob",
    type = "application/octet-stream",
  ): Promise<Uint8Array> {
    const session = await this.session(auth);
    const url = this.downloadUrlFor(session, accountId, blobId, name, type);
    const response = await fetch(url, { headers: { Authorization: auth.authorization } });
    if (!response.ok) {
      throw new Error(`JMAP blob download failed: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function firstAccountWithCapability(
  session: JmapSession,
  capability?: string,
): string | undefined {
  for (const [accountId, account] of Object.entries(session.accounts ?? {})) {
    if (!capability || account.accountCapabilities?.[capability]) return accountId;
  }
  return undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
