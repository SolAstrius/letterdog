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

/** Extract CoreLimits from a session's urn:ietf:params:jmap:core capability object. */
export function coreLimits(_session: JmapSession): CoreLimits {
  throw new Error("not implemented: core/jmap/session coreLimits");
}

/**
 * Per-actor session cache. Key = actor fingerprint; TTL = config.sessionCacheTtlMs (default
 * 60s). `sessionState` echoed on API responses SHOULD invalidate the cached entry when it
 * changes. Never key by (or store) the raw credential.
 */
export class SessionCache {
  constructor(private readonly ttlMs: number) {}

  get(_fingerprint: string): JmapSession | undefined {
    throw new Error("not implemented: core/jmap/session SessionCache.get");
  }

  put(_fingerprint: string, _session: JmapSession): void {
    throw new Error("not implemented: core/jmap/session SessionCache.put");
  }

  invalidate(_fingerprint: string): void {
    throw new Error("not implemented: core/jmap/session SessionCache.invalidate");
  }
}
