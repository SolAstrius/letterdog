/**
 * JMAP session types, capability constants, and the per-actor session cache.
 * CONTRACT STUB — TODO(builder: B1-jmap). Types are normative; function/class bodies throw.
 * See docs/v2-contracts.md §core/jmap/session.
 */

/** Capability URNs (RFC 8620/8621, draft-ietf-jmap-calendars-26, RFC 9670, RFC 9404, Stalwart). */
export const CAPABILITIES = {
  core: "urn:ietf:params:jmap:core",
  mail: "urn:ietf:params:jmap:mail",
  submission: "urn:ietf:params:jmap:submission",
  vacationResponse: "urn:ietf:params:jmap:vacationresponse",
  calendars: "urn:ietf:params:jmap:calendars",
  calendarsParse: "urn:ietf:params:jmap:calendars:parse",
  contacts: "urn:ietf:params:jmap:contacts",
  contactsParse: "urn:ietf:params:jmap:contacts:parse",
  principals: "urn:ietf:params:jmap:principals",
  principalsAvailability: "urn:ietf:params:jmap:principals:availability",
  principalsOwner: "urn:ietf:params:jmap:principals:owner",
  blob: "urn:ietf:params:jmap:blob",
  sieve: "urn:ietf:params:jmap:sieve",
  fileNode: "urn:ietf:params:jmap:filenode",
  stalwart: "urn:stalwart:jmap",
} as const;

/** Ready-made `using` sets for request(). */
export const USING = {
  mail: [CAPABILITIES.core, CAPABILITIES.mail],
  mailBlob: [CAPABILITIES.core, CAPABILITIES.mail, CAPABILITIES.blob],
  submission: [CAPABILITIES.core, CAPABILITIES.mail, CAPABILITIES.submission],
  vacation: [CAPABILITIES.core, CAPABILITIES.mail, CAPABILITIES.vacationResponse],
  calendars: [CAPABILITIES.core, CAPABILITIES.calendars],
  calendarsParse: [CAPABILITIES.core, CAPABILITIES.calendars, CAPABILITIES.calendarsParse],
  contacts: [CAPABILITIES.core, CAPABILITIES.contacts],
  principals: [
    CAPABILITIES.core,
    CAPABILITIES.principals,
    CAPABILITIES.principalsAvailability,
    CAPABILITIES.calendars,
  ],
  blob: [CAPABILITIES.core, CAPABILITIES.blob],
  stalwart: [CAPABILITIES.core, CAPABILITIES.stalwart],
} as const;

export interface JmapAccount {
  name?: string;
  isPersonal?: boolean;
  isReadOnly?: boolean;
  accountCapabilities: Record<string, unknown>;
}

/** RFC 8620 §2 Session object (URI Template level 1 urls). */
export interface JmapSession {
  apiUrl: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  state?: string;
  username?: string;
  capabilities: Record<string, unknown>;
  accounts: Record<string, JmapAccount>;
  primaryAccounts: Record<string, string>;
}

/** Core capability limits, parsed with defaults for absent values (rfc-notes 8620 §1.1). */
export interface CoreLimits {
  maxSizeUpload: number;
  maxSizeRequest: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
}

/**
 * RFC 8620 §1.1 suggested minimums, used when a limit is absent from the core capability object.
 * (maxObjectsInGet/InSet default 500; if the server omits them we still chunk conservatively.)
 */
const CORE_LIMIT_DEFAULTS: CoreLimits = {
  maxSizeUpload: 50_000_000,
  maxSizeRequest: 10_000_000,
  maxCallsInRequest: 16,
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
};

/** Extract CoreLimits from a session's urn:ietf:params:jmap:core capability object. */
export function coreLimits(session: JmapSession): CoreLimits {
  const core = session.capabilities?.[CAPABILITIES.core] as Record<string, unknown> | undefined;
  const num = (key: keyof CoreLimits): number => {
    const raw = core?.[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0
      ? raw
      : CORE_LIMIT_DEFAULTS[key];
  };
  return {
    maxSizeUpload: num("maxSizeUpload"),
    maxSizeRequest: num("maxSizeRequest"),
    maxCallsInRequest: num("maxCallsInRequest"),
    maxObjectsInGet: num("maxObjectsInGet"),
    maxObjectsInSet: num("maxObjectsInSet"),
  };
}

interface CacheEntry {
  session: JmapSession;
  expiresAt: number;
}

/**
 * Per-actor session cache. Key = actor fingerprint; TTL = config.sessionCacheTtlMs (default
 * 60s). `sessionState` echoed on API responses SHOULD invalidate the cached entry when it
 * changes. Never key by (or store) the raw credential.
 */
export class SessionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number) {}

  get(fingerprint: string): JmapSession | undefined {
    const entry = this.entries.get(fingerprint);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(fingerprint);
      return undefined;
    }
    return entry.session;
  }

  put(fingerprint: string, session: JmapSession): void {
    this.entries.set(fingerprint, { session, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(fingerprint: string): void {
    this.entries.delete(fingerprint);
  }
}
