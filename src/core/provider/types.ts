/**
 * Provider adapter contract. The PIM core targets JMAP-the-standard; anything
 * implementation-specific flows through this interface (docs/v2-design.md "Beyond Stalwart").
 * Types are normative — owned by builder B6-provider (extend, don't rename).
 */
import type { OpDefinition } from "../ops/registry.ts";
import type { Participant, TypedEvent } from "../schemas/jscalendar.ts";

/**
 * Canonical internal scheduling shapes the normalizers produce, independent of whether the
 * server speaks RFC 8984 (sendTo/replyTo maps) or JSCalendar-bis (calendarAddress/
 * organizerCalendarAddress strings). Stalwart v0.16 serves a HYBRID of both.
 */
export interface NormalizedOrganizer {
  /** Single canonical URI (imip preferred), e.g. "mailto:sol@astrius.ink". */
  calendarAddress?: string;
  /** The raw map when the server sent one. */
  replyTo?: Record<string, string>;
}

export interface NormalizedParticipantAddress {
  participantId: string;
  /** Canonical URI: participant.calendarAddress ?? sendTo.imip ?? first sendTo value. */
  calendarAddress?: string;
  email?: string;
}

export interface ShapeNormalizers {
  /** Normalize hybrid event shapes into RFC-8984-leaning canonical form (never mutates input). */
  event(raw: TypedEvent): TypedEvent;
  organizer(raw: TypedEvent): NormalizedOrganizer;
  participantAddress(participantId: string, raw: Participant): NormalizedParticipantAddress;
  /**
   * Find the caller's own participant entry by matching normalized calendarAddress against the
   * caller's ParticipantIdentity addresses (RFC 3986 §6.2.2 normalization) — the event.rsvp
   * core primitive.
   */
  ownParticipant(
    raw: TypedEvent,
    ownAddresses: string[],
  ): NormalizedParticipantAddress | undefined;
}

/** Implementation-specific behaviors ops must consult instead of hardcoding. */
export interface ProviderQuirks {
  /** Stalwart: expandRecurrences REQUIRES both after+before bounds (schema also enforces). */
  expandRequiresBounds: boolean;
  /** Server serves hybrid 8984/bis scheduling shapes (see §14 of the calendars rfc-note). */
  hybridSchedulingShapes: boolean;
  /** Unknown participant role keys occur (e.g. Stalwart "required") — preserve them. */
  unknownParticipantRoles: boolean;
  /** Invalid timeZone args degrade silently server-side — validate client-side first. */
  validateTimeZoneClientSide: boolean;
}

export interface Provider {
  /** e.g. "stalwart". */
  id: string;
  /** Session endpoint for a base URL (Stalwart: `${base}/jmap/session`). */
  sessionUrl(baseUrl: string): string;
  normalize: ShapeNormalizers;
  /** Provider-specific ops (Stalwart x:* admin, sieve specifics) — merged by ops/admin.ts. */
  extensions: OpDefinition[];
  quirks: ProviderQuirks;
}
