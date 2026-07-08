/**
 * JSCalendar (RFC 8984 + draft-ietf-jmap-calendars-26) Zod schemas.
 * Grounded in docs/rfc-notes/rfc8984-jscalendar.md and jmap-calendars-sharing-blob.md §3–6, §14.
 *
 * MUST-hold invariants (implemented as superRefine; see contracts doc):
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
 *
 * .passthrough() everywhere for spec-faithful round-tripping. Interfaces stay the exported
 * contract; schema consts are cast to z.ZodType<Iface> where zod's structural inference (open
 * object + passthrough index signature) diverges from the hand-written interface.
 */
import { z } from "zod";
import {
  DurationSchema,
  IdSchema,
  LocalDateTimeSchema,
  setOfTrue,
  SignedDurationSchema,
  TimeZoneIdSchema,
  UtcDateTimeSchema,
} from "./common.ts";

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

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

/** Weekday codes shared by NDay.day and RecurrenceRule.firstDayOfWeek (lowercase WKST). */
const WeekdaySchema = z.enum(["mo", "tu", "we", "th", "fr", "sa", "su"]);

/** byMonth entries: "1"-based month strings with optional uppercase "L" leap-month suffix. */
const ByMonthSchema = z.string().regex(
  /^([1-9]|1[0-2])L?$/,
  'expected month string like "3" or "3L"',
);

/** NDay: nthOfPeriod must be a non-zero integer when present. */
export const NDaySchema = z.object({
  "@type": z.literal("NDay").default("NDay"),
  day: WeekdaySchema,
  nthOfPeriod: z.number().int().refine((n) => n !== 0, "nthOfPeriod MUST NOT be 0").optional(),
}).passthrough() as unknown as z.ZodType<NDay>;

export const RecurrenceRuleSchema = z.object({
  "@type": z.literal("RecurrenceRule").default("RecurrenceRule"),
  frequency: z.enum([
    "yearly",
    "monthly",
    "weekly",
    "daily",
    "hourly",
    "minutely",
    "secondly",
  ]),
  interval: z.number().int().min(1).optional(),
  rscale: z.string().min(1).optional(),
  skip: z.enum(["omit", "backward", "forward"]).optional(),
  firstDayOfWeek: WeekdaySchema.optional(),
  byDay: z.array(NDaySchema).min(1).optional(),
  byMonthDay: z.array(z.number().int().min(-31).max(31).refine((n) => n !== 0, "0 is invalid"))
    .min(1).optional(),
  byMonth: z.array(ByMonthSchema).min(1).optional(),
  byYearDay: z.array(z.number().int().min(-366).max(366).refine((n) => n !== 0, "0 is invalid"))
    .min(1).optional(),
  byWeekNo: z.array(z.number().int().min(-53).max(53).refine((n) => n !== 0, "0 is invalid"))
    .min(1).optional(),
  byHour: z.array(z.number().int().min(0).max(23)).min(1).optional(),
  byMinute: z.array(z.number().int().min(0).max(59)).min(1).optional(),
  bySecond: z.array(z.number().int().min(0).max(60)).min(1).optional(),
  bySetPosition: z.array(z.number().int().refine((n) => n !== 0, "0 is invalid")).min(1).optional(),
  count: z.number().int().min(0).optional(),
  until: LocalDateTimeSchema.optional(),
}).passthrough().superRefine((rule, ctx) => {
  // count XOR until (both may be absent; both present is illegal).
  if (rule.count !== undefined && rule.until !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`count` and `until` are mutually exclusive on a RecurrenceRule",
      path: ["count"],
    });
  }
}) as unknown as z.ZodType<RecurrenceRule>;

/** Set-of-true keyed by non-empty strings (roles, keywords, features, delegatedTo/From…). */
function nonEmptySetOfTrue() {
  return z.record(z.string().min(1), z.literal(true));
}

export const ParticipantSchema = z.object({
  "@type": z.literal("Participant").optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  description: z.string().optional(),
  // Hybrid: RFC 8984 sendTo map. Omit rather than {} — enforce ≥1 method when present.
  sendTo: z.record(z.string().min(1), z.string()).refine(
    (m) => Object.keys(m).length >= 1,
    "sendTo MUST have ≥1 method or be omitted (not {})",
  ).optional(),
  // Hybrid: JSCalendar-bis / live-Stalwart single URI.
  calendarAddress: z.string().optional(),
  kind: z.enum(["individual", "group", "location", "resource"]).optional(),
  // roles: ≥1 entry, values true, UNKNOWN role keys accepted (Stalwart serves "required").
  roles: nonEmptySetOfTrue().refine(
    (m) => Object.keys(m).length >= 1,
    "participant MUST have ≥1 role",
  ),
  locationId: z.string().optional(),
  language: z.string().optional(),
  participationStatus: z.enum([
    "needs-action",
    "accepted",
    "declined",
    "tentative",
    "delegated",
  ]).optional(),
  participationComment: z.string().optional(),
  expectReply: z.boolean().optional(),
  scheduleAgent: z.enum(["server", "client", "none"]).optional(),
  scheduleSequence: z.number().int().min(0).optional(),
  delegatedTo: nonEmptySetOfTrue().optional(),
  delegatedFrom: nonEmptySetOfTrue().optional(),
  memberOf: nonEmptySetOfTrue().optional(),
}).passthrough() as unknown as z.ZodType<Participant>;

const LocationSchema = z.object({
  "@type": z.literal("Location").optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  locationTypes: nonEmptySetOfTrue().optional(),
  relativeTo: z.enum(["start", "end"]).optional(),
  timeZone: TimeZoneIdSchema.optional(),
  coordinates: z.string().optional(),
}).passthrough() as unknown as z.ZodType<Location>;

const VirtualLocationSchema = z.object({
  "@type": z.literal("VirtualLocation").optional(),
  uri: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  // Registered feature keys per RFC 8984 §5; unknown keys tolerated via passthrough on the map is
  // not possible, so accept any non-empty key with literal-true value.
  features: nonEmptySetOfTrue().optional(),
}).passthrough() as unknown as z.ZodType<VirtualLocation>;

const LinkSchema = z.object({
  "@type": z.literal("Link").optional(),
  href: z.string().optional(),
  blobId: z.string().optional(),
  cid: z.string().optional(),
  contentType: z.string().optional(),
  size: z.number().int().min(0).optional(),
  rel: z.string().optional(),
  display: z.enum(["badge", "graphic", "fullsize", "thumbnail"]).optional(),
  title: z.string().optional(),
}).passthrough() as unknown as z.ZodType<Link>;

/** Discriminated Alert trigger: OffsetTrigger | AbsoluteTrigger | preserved UnknownTrigger. */
const OffsetTriggerSchema = z.object({
  "@type": z.literal("OffsetTrigger"),
  offset: SignedDurationSchema,
  relativeTo: z.enum(["start", "end"]).optional(),
}).passthrough();

const AbsoluteTriggerSchema = z.object({
  "@type": z.literal("AbsoluteTrigger"),
  when: UtcDateTimeSchema,
}).passthrough();

/**
 * Any object whose @type is neither of the two known triggers — preserved, SHOULD NOT trigger
 * (RFC 8984 §6). Excluding the known literals stops a MALFORMED OffsetTrigger/AbsoluteTrigger from
 * silently falling through to this catch-all instead of surfacing its own validation error.
 */
const UnknownTriggerSchema = z.object({
  "@type": z.string().refine(
    (t) => t !== "OffsetTrigger" && t !== "AbsoluteTrigger",
    "known trigger @type must satisfy its specific schema",
  ),
}).passthrough();

const AlertTriggerSchema = z.union([
  OffsetTriggerSchema,
  AbsoluteTriggerSchema,
  UnknownTriggerSchema,
]);

const RelationSchema = z.object({
  "@type": z.literal("Relation").optional(),
  relation: nonEmptySetOfTrue().optional(),
}).passthrough();

export const AlertSchema = z.object({
  "@type": z.literal("Alert").optional(),
  trigger: AlertTriggerSchema,
  acknowledged: UtcDateTimeSchema.optional(),
  relatedTo: z.record(z.string().min(1), RelationSchema).optional(),
  action: z.enum(["display", "email"]).optional(),
}).passthrough() as unknown as z.ZodType<Alert>;

// ---------------------------------------------------------------------------------------------
// Event shapes: shared body → create / patch specializations
// ---------------------------------------------------------------------------------------------

/**
 * Fields a caller MAY set on create OR patch. Server-set / read-only props are absent here
 * (id, uid, baseEventId, isOrigin, updated, sequence, method, requestStatus, prodId, created,
 * organizerCalendarAddress) and Task/Group-only props are excluded entirely.
 */
const eventWritableShape = {
  "@type": z.literal("Event").optional(),
  calendarIds: setOfTrue().optional(),
  isDraft: z.boolean().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  descriptionContentType: z.string().optional(),
  start: LocalDateTimeSchema.optional(),
  duration: DurationSchema.optional(),
  timeZone: TimeZoneIdSchema.nullable().optional(),
  showWithoutTime: z.boolean().optional(),
  status: z.enum(["confirmed", "cancelled", "tentative"]).optional(),
  freeBusyStatus: z.enum(["free", "busy"]).optional(),
  privacy: z.enum(["public", "private", "secret"]).optional(),
  priority: z.number().int().min(0).max(9).optional(),
  color: z.string().optional(),
  locale: z.string().optional(),
  keywords: setOfTrue().optional(),
  categories: setOfTrue().optional(),
  locations: z.record(IdSchema, LocationSchema).optional(),
  virtualLocations: z.record(IdSchema, VirtualLocationSchema).optional(),
  links: z.record(IdSchema, LinkSchema).optional(),
  // Hybrid union members — accept either the RFC 8984 replyTo map or the bis single URI.
  replyTo: z.record(z.string().min(1), z.string()).optional(),
  participants: z.record(IdSchema, ParticipantSchema).optional(),
  recurrenceId: LocalDateTimeSchema.optional(),
  recurrenceIdTimeZone: TimeZoneIdSchema.nullable().optional(),
  recurrenceRules: z.array(RecurrenceRuleSchema).optional(),
  excludedRecurrenceRules: z.array(RecurrenceRuleSchema).optional(),
  // Key = LocalDateTime recurrence id; value = PatchObject (kept loose per RFC 6901).
  recurrenceOverrides: z.record(LocalDateTimeSchema, z.record(z.string(), z.unknown())).optional(),
  excluded: z.boolean().optional(),
  useDefaultAlerts: z.boolean().optional(),
  alerts: z.record(IdSchema, AlertSchema).optional(),
  mayInviteSelf: z.boolean().optional(),
  mayInviteOthers: z.boolean().optional(),
  hideAttendees: z.boolean().optional(),
  // Write-convenience; mutually exclusive with start/duration (enforced in superRefine).
  utcStart: UtcDateTimeSchema.optional(),
  utcEnd: UtcDateTimeSchema.optional(),
} as const;

/** Server-set / read-only props rejected on create. */
const SERVER_SET_KEYS = [
  "id",
  "uid",
  "baseEventId",
  "isOrigin",
  "updated",
  "created",
  "sequence",
  "method",
  "requestStatus",
  "prodId",
  "organizerCalendarAddress",
] as const;

/** Cross-field invariants shared by create and patch. */
function refineEventInvariants(
  ev: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  const has = (k: string) => ev[k] !== undefined && ev[k] !== null;

  // recurrenceId ⟂ recurrenceRules/recurrenceOverrides on one object.
  if (has("recurrenceId")) {
    if (has("recurrenceRules")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`recurrenceId` present ⇒ `recurrenceRules` MUST NOT be set (single occurrence)",
        path: ["recurrenceRules"],
      });
    }
    if (has("recurrenceOverrides")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`recurrenceId` present ⇒ `recurrenceOverrides` MUST NOT be set",
        path: ["recurrenceOverrides"],
      });
    }
  }

  // recurrenceIdTimeZone iff recurrenceId (both directions).
  const hasRid = has("recurrenceId");
  const hasRidTz = "recurrenceIdTimeZone" in ev && ev.recurrenceIdTimeZone !== undefined;
  if (hasRidTz && !hasRid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`recurrenceIdTimeZone` MUST be set only when `recurrenceId` is set",
      path: ["recurrenceIdTimeZone"],
    });
  }
  if (hasRid && !hasRidTz) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`recurrenceIdTimeZone` MUST be set when `recurrenceId` is set",
      path: ["recurrenceIdTimeZone"],
    });
  }

  // utcStart/utcEnd (write-convenience) ⟂ start/duration.
  const usesUtc = has("utcStart") || has("utcEnd");
  const usesLocal = has("start") || has("duration");
  if (usesUtc && usesLocal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "`utcStart`/`utcEnd` are mutually exclusive with `start`/`duration`",
      path: ["utcStart"],
    });
  }
}

/**
 * Create shape: start required (unless utcStart is used); server-set props rejected; all invariants
 * enforced. Passthrough keeps unrecognized (extension) props for spec-faithful round-tripping.
 */
export const EventCreateSchema = z.object(eventWritableShape).passthrough().superRefine(
  (ev, ctx) => {
    const record = ev as Record<string, unknown>;
    // Reject server-set props on create.
    for (const key of SERVER_SET_KEYS) {
      if (key in record && record[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `\`${key}\` is server-set and MUST NOT be provided on create`,
          path: [key],
        });
      }
    }
    // start required unless the utcStart write-convenience is used.
    const hasStart = record.start !== undefined && record.start !== null;
    const hasUtcStart = record.utcStart !== undefined && record.utcStart !== null;
    if (!hasStart && !hasUtcStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`start` (LocalDateTime) is required on create (or use `utcStart`)",
        path: ["start"],
      });
    }
    refineEventInvariants(record, ctx);
  },
) as unknown as z.ZodType<TypedEvent>;

/**
 * Typed partial patch for update_event's structured mode (a raw PatchObject is also accepted by the
 * op). Every writable field optional; no `start` requirement; server-set props still rejected;
 * cross-field invariants still enforced on whatever is present.
 */
export const EventPatchSchema = z.object(eventWritableShape).passthrough().superRefine(
  (ev, ctx) => {
    const record = ev as Record<string, unknown>;
    for (const key of SERVER_SET_KEYS) {
      if (key in record && record[key] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `\`${key}\` is server-set and MUST NOT be patched`,
          path: [key],
        });
      }
    }
    refineEventInvariants(record, ctx);
  },
) as unknown as z.ZodType<Partial<TypedEvent>>;

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

export const EventFilterConditionSchema = z.object({
  inCalendar: z.string().min(1).optional(),
  // after compared against event END, before against event START — both LocalDateTime in the
  // query timeZone arg (NOT UTCDateTime).
  after: LocalDateTimeSchema.optional(),
  before: LocalDateTimeSchema.optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  owner: z.string().optional(),
  attendee: z.string().optional(),
  uid: z.string().optional(),
}).passthrough() as unknown as z.ZodType<EventFilterCondition>;
