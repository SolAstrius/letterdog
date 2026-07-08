/**
 * JSCalendar (RFC 8984 + draft-ietf-jmap-calendars-26) Zod schemas.
 * CONTRACT STUB — TODO(builder: B3-schemas-calendar). Interfaces are normative; schema consts
 * are todoSchema() placeholders to replace.
 * Grounded in docs/rfc-notes/rfc8984-jscalendar.md and jmap-calendars-sharing-blob.md §3–6, §14.
 *
 * MUST-hold invariants (implement as superRefine; see contracts doc):
 * - RecurrenceRule: count ⟂ until.
 * - recurrenceId ⟂ recurrenceRules/recurrenceOverrides on one object; recurrenceIdTimeZone iff
 *   recurrenceId.
 * - utcStart/utcEnd (write-convenience) ⟂ start/duration; never inside recurrenceOverrides.
 * - Sets are maps-to-true (keywords, roles, features, delegatedTo/From, memberOf, relation).
 * - "Omit rather than empty {}": replyTo, sendTo, delegatedTo/From, memberOf, links.
 * - Stalwart v0.16 HYBRID (no invented semantics): Participant carries sendTo (map) OR
 *   calendarAddress (string); Event carries replyTo (map) OR organizerCalendarAddress (string).
 *   Model as tolerant unions here; NORMALIZE only in the provider adapter.
 * - NO updateScope/destroyScope anywhere. Occurrence edits = synthetic instance ids.
 */
import { z } from "zod";
import { todoSchema } from "./common.ts";

export interface NDay {
  "@type": "NDay";
  day: "mo" | "tu" | "we" | "th" | "fr" | "sa" | "su";
  /** Positive or negative, never 0 (−1 = last in period). */
  nthOfPeriod?: number;
}

export interface RecurrenceRule {
  "@type": "RecurrenceRule";
  frequency: "yearly" | "monthly" | "weekly" | "daily" | "hourly" | "minutely" | "secondly";
  interval?: number;
  rscale?: string;
  skip?: "omit" | "backward" | "forward";
  firstDayOfWeek?: NDay["day"];
  byDay?: NDay[];
  byMonthDay?: number[];
  /** Strings, "1"-based, optional "L" leap-month suffix ("3L"). */
  byMonth?: string[];
  byYearDay?: number[];
  byWeekNo?: number[];
  byHour?: number[];
  byMinute?: number[];
  bySecond?: number[];
  bySetPosition?: number[];
  /** Mutually exclusive with until. */
  count?: number;
  /** LocalDateTime in the event's timeZone; mutually exclusive with count. */
  until?: string;
}

/**
 * Participant — tolerant of the Stalwart v0.16 hybrid: RFC 8984 `sendTo` map OR bis-style
 * `calendarAddress` single URI. `roles` accepts unknown keys (Stalwart serves e.g. "required").
 */
export interface Participant {
  "@type"?: "Participant";
  name?: string;
  email?: string;
  description?: string;
  /** RFC 8984 shape: method → URI ("imip" → mailto:). Omit rather than {}. */
  sendTo?: Record<string, string>;
  /** JSCalendar-bis / live-Stalwart shape: single URI. */
  calendarAddress?: string;
  kind?: "individual" | "group" | "location" | "resource";
  /** ≥1 role; values true; unknown role keys MUST be preserved. */
  roles: Record<string, true>;
  locationId?: string;
  language?: string;
  participationStatus?: "needs-action" | "accepted" | "declined" | "tentative" | "delegated";
  participationComment?: string;
  expectReply?: boolean;
  scheduleAgent?: "server" | "client" | "none";
  scheduleSequence?: number;
  delegatedTo?: Record<string, true>;
  delegatedFrom?: Record<string, true>;
  memberOf?: Record<string, true>;
  [key: string]: unknown;
}

export interface Location {
  "@type"?: "Location";
  name?: string;
  description?: string;
  locationTypes?: Record<string, true>;
  relativeTo?: "start" | "end";
  timeZone?: string;
  /** geo: URI. */
  coordinates?: string;
  [key: string]: unknown;
}

export interface VirtualLocation {
  "@type"?: "VirtualLocation";
  uri: string;
  name?: string;
  description?: string;
  features?: Record<string, true>;
  [key: string]: unknown;
}

export interface Link {
  "@type"?: "Link";
  href?: string;
  /** draft-26: client MAY set blobId instead of href (rel:"enclosure" attachments). */
  blobId?: string;
  cid?: string;
  contentType?: string;
  size?: number;
  rel?: string;
  display?: "badge" | "graphic" | "fullsize" | "thumbnail";
  title?: string;
  [key: string]: unknown;
}

export type AlertTrigger =
  | { "@type": "OffsetTrigger"; offset: string; relativeTo?: "start" | "end" }
  | { "@type": "AbsoluteTrigger"; when: string }
  | { "@type": string; [key: string]: unknown };

export interface Alert {
  "@type"?: "Alert";
  trigger: AlertTrigger;
  acknowledged?: string;
  relatedTo?: Record<string, { "@type"?: "Relation"; relation?: Record<string, true> }>;
  action?: "display" | "email";
  [key: string]: unknown;
}

/**
 * Event create/read shape (spec camelCase — this object goes inside JMAP payloads).
 * Server-set fields (id, baseEventId, isOrigin, uid, created, updated, sequence, method,
 * requestStatus, organizerCalendarAddress) are EXCLUDED from the create schema and typed
 * optional here for reads. Passthrough index signature keeps spec-faithfulness.
 */
export interface TypedEvent {
  "@type"?: "Event";
  id?: string;
  baseEventId?: string | null;
  uid?: string;
  calendarIds?: Record<string, true>;
  isDraft?: boolean;
  isOrigin?: boolean;
  title?: string;
  description?: string;
  descriptionContentType?: string;
  /** LocalDateTime — mandatory on create (unless utcStart used). */
  start?: string;
  duration?: string;
  /** null/omitted = floating time. */
  timeZone?: string | null;
  showWithoutTime?: boolean;
  status?: "confirmed" | "cancelled" | "tentative";
  freeBusyStatus?: "free" | "busy";
  privacy?: "public" | "private" | "secret";
  priority?: number;
  keywords?: Record<string, true>;
  categories?: Record<string, true>;
  color?: string;
  locations?: Record<string, Location>;
  virtualLocations?: Record<string, VirtualLocation>;
  links?: Record<string, Link>;
  /** RFC 8984 organizer response address map ({"imip": "mailto:…"}). Hybrid union member. */
  replyTo?: Record<string, string>;
  /** JSCalendar-bis / draft-26 shape. Server-set in Stalwart; hybrid union member. */
  organizerCalendarAddress?: string;
  participants?: Record<string, Participant>;
  recurrenceId?: string;
  recurrenceIdTimeZone?: string | null;
  recurrenceRules?: RecurrenceRule[];
  excludedRecurrenceRules?: RecurrenceRule[];
  recurrenceOverrides?: Record<string, Record<string, unknown>>;
  excluded?: boolean;
  useDefaultAlerts?: boolean;
  alerts?: Record<string, Alert>;
  /** Write-convenience; mutually exclusive with start/duration. Opt-in on reads. */
  utcStart?: string;
  utcEnd?: string;
  [key: string]: unknown;
}

export const NDaySchema: z.ZodType<NDay> = todoSchema("schemas/jscalendar NDaySchema");

export const RecurrenceRuleSchema: z.ZodType<RecurrenceRule> = todoSchema(
  "schemas/jscalendar RecurrenceRuleSchema (superRefine: count XOR until)",
);

export const ParticipantSchema: z.ZodType<Participant> = todoSchema(
  "schemas/jscalendar ParticipantSchema (hybrid sendTo|calendarAddress tolerant)",
);

export const AlertSchema: z.ZodType<Alert> = todoSchema("schemas/jscalendar AlertSchema");

/** Create shape: start required (XOR utcStart/utcEnd), server-set props rejected. */
export const EventCreateSchema: z.ZodType<TypedEvent> = todoSchema(
  "schemas/jscalendar EventCreateSchema",
);

/** Typed partial patch for update_event's structured mode (raw PatchObject also accepted). */
export const EventPatchSchema: z.ZodType<Partial<TypedEvent>> = todoSchema(
  "schemas/jscalendar EventPatchSchema",
);

/** draft-26 CalendarEvent/query FilterCondition (in_calendar singular; before/after overlap). */
export interface EventFilterCondition {
  inCalendar?: string;
  after?: string;
  before?: string;
  text?: string;
  title?: string;
  description?: string;
  location?: string;
  owner?: string;
  attendee?: string;
  uid?: string;
}

export const EventFilterConditionSchema: z.ZodType<EventFilterCondition> = todoSchema(
  "schemas/jscalendar EventFilterConditionSchema",
);
