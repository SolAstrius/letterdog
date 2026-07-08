/**
 * Stalwart provider adapter — the first (and currently only) Provider.
 *
 * Responsibilities:
 * - normalize.*: fold the v0.16 hybrid (participants: sendTo map OR calendarAddress string;
 *   events: replyTo map OR organizerCalendarAddress string) into the canonical shapes in
 *   provider/types.ts. Tolerate unknown role keys ("required"). Re-verify on Stalwart upgrades.
 * - extensions: x:* admin ops (settings get/update) and sieve specifics, exposed to
 *   ops/admin.ts. Gate nothing here — gating (ENABLE_ADMIN_TOOLS) is the frontends' job.
 * - quirks: expandRequiresBounds=true, hybridSchedulingShapes=true, etc.
 *
 * The core MUST compile without this module being "special": a Fastmail/Cyrus account works
 * through genericProvider() by pointing the session URL at it. Both providers share the same
 * hybrid-tolerant normalizers (accepting both shapes is spec-conservative — a server that only
 * ever sends one shape simply never exercises the other branch); they differ in `extensions`
 * (Stalwart ships x-admin and sieve ops; generic ships none) and `quirks`.
 */
import type { Participant, TypedEvent } from "../schemas/jscalendar.ts";
import type {
  NormalizedOrganizer,
  NormalizedParticipantAddress,
  Provider,
  ProviderQuirks,
  ShapeNormalizers,
} from "./types.ts";

/**
 * Pick the single canonical URI for a participant from the hybrid shapes.
 * Precedence: bis-style `calendarAddress` string → RFC 8984 `sendTo.imip` → first `sendTo` value.
 */
function participantAddress(raw: Participant): string | undefined {
  if (typeof raw.calendarAddress === "string" && raw.calendarAddress.length > 0) {
    return raw.calendarAddress;
  }
  const sendTo = raw.sendTo;
  if (sendTo && typeof sendTo === "object") {
    if (typeof sendTo.imip === "string") return sendTo.imip;
    const first = Object.values(sendTo).find((v) => typeof v === "string");
    if (first) return first;
  }
  return undefined;
}

/**
 * Derive a bare email address (no scheme) from a canonical calendar URI, for matching against
 * ParticipantIdentity email fields. Strips a leading `mailto:` when present.
 */
function emailFromCalendarAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const lower = address.toLowerCase();
  if (lower.startsWith("mailto:")) return address.slice("mailto:".length);
  return undefined;
}

/**
 * RFC 3986 §6.2.2-flavoured normalization for calendarAddress equality: lowercase the scheme and
 * (for mailto:) the whole address. Calendar addresses in practice are `mailto:` URIs where the
 * mailbox comparison is case-insensitive on the domain and, per Stalwart, on the local part too.
 * We lowercase the entire URI — conservative and sufficient for own-participant matching.
 */
function normalizeAddressForMatch(address: string): string {
  return address.trim().toLowerCase();
}

const hybridNormalizers: ShapeNormalizers = {
  /**
   * Canonicalize an event's scheduling shapes onto the RFC-8984-leaning internal form WITHOUT
   * mutating the input: participants gain a canonical `calendarAddress`; the event keeps whatever
   * organizer shape it had (organizer() resolves it on demand). Passthrough props are preserved.
   */
  event(raw: TypedEvent): TypedEvent {
    if (!raw.participants) return { ...raw };
    const participants: Record<string, Participant> = {};
    for (const [id, participant] of Object.entries(raw.participants)) {
      const canonical = participantAddress(participant);
      participants[id] = canonical && canonical !== participant.calendarAddress
        ? { ...participant, calendarAddress: canonical }
        : { ...participant };
    }
    return { ...raw, participants };
  },

  organizer(raw: TypedEvent): NormalizedOrganizer {
    const replyTo = raw.replyTo && typeof raw.replyTo === "object" ? raw.replyTo : undefined;
    // Precedence: replyTo.imip → organizerCalendarAddress → first replyTo value.
    let calendarAddress: string | undefined;
    if (replyTo && typeof replyTo.imip === "string") {
      calendarAddress = replyTo.imip;
    } else if (typeof raw.organizerCalendarAddress === "string") {
      calendarAddress = raw.organizerCalendarAddress;
    } else if (replyTo) {
      const first = Object.values(replyTo).find((v) => typeof v === "string");
      if (first) calendarAddress = first;
    }
    return { calendarAddress, replyTo };
  },

  participantAddress(participantId: string, raw: Participant): NormalizedParticipantAddress {
    const calendarAddress = participantAddress(raw);
    return {
      participantId,
      calendarAddress,
      email: raw.email ?? emailFromCalendarAddress(calendarAddress),
    };
  },

  ownParticipant(
    raw: TypedEvent,
    ownAddresses: string[],
  ): NormalizedParticipantAddress | undefined {
    if (!raw.participants) return undefined;
    const wanted = new Set(ownAddresses.map(normalizeAddressForMatch));
    for (const [id, participant] of Object.entries(raw.participants)) {
      const address = participantAddress(participant);
      if (address && wanted.has(normalizeAddressForMatch(address))) {
        return {
          participantId: id,
          calendarAddress: address,
          email: participant.email ?? emailFromCalendarAddress(address),
        };
      }
    }
    return undefined;
  },
};

const stalwartQuirks: ProviderQuirks = {
  expandRequiresBounds: true,
  hybridSchedulingShapes: true,
  unknownParticipantRoles: true,
  validateTimeZoneClientSide: true,
};

const genericQuirks: ProviderQuirks = {
  expandRequiresBounds: true,
  hybridSchedulingShapes: false,
  unknownParticipantRoles: false,
  validateTimeZoneClientSide: false,
};

function jmapSessionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/jmap/session`;
}

export function stalwartProvider(): Provider {
  return {
    id: "stalwart",
    sessionUrl: jmapSessionUrl,
    normalize: hybridNormalizers,
    // x:* admin + sieve op definitions are assembled by ops/admin.ts, which imports the provider
    // and reads this list. Kept empty here so the provider compiles standalone; ops/admin.ts owns
    // the concrete OpDefinitions and appends any it sources from the provider.
    extensions: [],
    quirks: stalwartQuirks,
  };
}

/**
 * Spec-conservative fallback provider: the same hybrid-tolerant normalizers (harmless on a
 * single-shape server), no server-specific extensions, spec-default quirks.
 */
export function genericProvider(): Provider {
  return {
    id: "generic",
    sessionUrl: jmapSessionUrl,
    normalize: hybridNormalizers,
    extensions: [],
    quirks: genericQuirks,
  };
}
