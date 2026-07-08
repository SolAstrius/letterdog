/**
 * Letterdog v2 — calendar + event ops (builder B9-ops-calendar).
 *
 * Backend: the user's personal self-hosted mail/calendar/contacts over JMAP (Stalwart v0.16
 * hybrid). All calendar reads go through core/projections.ts (brief default); all scheduling
 * shapes are normalized through ctx.provider.normalize (NEVER hardcode the 8984/bis split here).
 *
 * Op inventory (docs/v2-contracts.md §ops inventory):
 * - calendar.list         → list_calendars           [mcp]  none         calendar
 * - event.search          → search_events            [mcp]  none         event
 * - event.read            → read_events              [mcp]  none         event
 * - event.create          → create_events            [mcp]  outward      event
 * - event.update          → update_event             [mcp]  outward      event
 * - event.delete          → delete_events            [mcp]  destructive  event
 * - event.rsvp            → respond_to_event         [mcp]  outward      event
 * - calendar.availability → get_availability         [mcp]  none         busy
 * - calendar.create       → create_calendar          [cli]  none         calendar
 * - calendar.update       → update_calendar          [cli]  none         calendar
 * - calendar.delete       → delete_calendar          [cli]  destructive  calendar
 * - calendar.share        → share_calendar           [cli]  blast        calendar
 * - calendar.identity_set → set_participant_identity  [cli]  none         identity
 *
 * Hard rules honored: no updateScope/destroyScope; occurrence edits use synthetic instance ids
 * (server maps update→recurrenceOverride, destroy→exclude occurrence); expandRecurrences requires
 * BOTH after+before (enforced in schema AND re-checked here); snake_case args, spec camelCase only
 * inside JMAP payloads; batch-first id arrays with per-item failures in `failed`.
 */
import { z } from "zod";
import { defineOp, type OpContext, type OpDefinition } from "./registry.ts";
import { USING } from "../jmap/session.ts";
import { ref } from "../jmap/client.ts";
import type { JmapAuth } from "../jmap/client.ts";
import {
  type Envelope,
  envelopeFromGet,
  envelopeFromQuery,
  expectResponse,
  type SetError,
  type SetOutcome,
  setOutcome,
} from "../jmap/envelopes.ts";
import type { Id, ParticipantIdentity } from "../jmap/types.ts";
import {
  AccountIdSchema,
  FieldsSchema,
  IdsSchema,
  JmapIdSchema,
  LimitSchema,
  LocalDateTimeSchema,
  PatchObjectSchema,
  ProjectionSchema,
  TimeZoneIdSchema,
  UtcDateTimeSchema,
} from "../schemas/common.ts";
import { EventCreateSchema, EventFilterConditionSchema } from "../schemas/jscalendar.ts";
import type { TypedEvent } from "../schemas/jscalendar.ts";
import { project, type ProjectionContext, type ProjectionMode } from "../projections.ts";
import {
  type ConfirmChallenge,
  type ConfirmIntent,
  effectiveGate,
  mintConfirmToken,
  verifyConfirmToken,
} from "../safety.ts";

// =================================================================================================
// Shared helpers
// =================================================================================================

/** Mutable `using` sets (USING.* are readonly tuples; request/call want string[]). */
const USING_CALENDARS: string[] = [...USING.calendars];
const USING_PRINCIPALS: string[] = [...USING.principals];
/** The calendars capability URN (for resolveAccount). */
const CAP_CALENDARS: string = USING.calendars[1];
const CAP_PRINCIPALS: string = USING.principals[1];

/** The confirm_token arg every gated op accepts (added alongside the op's own input shape). */
const ConfirmTokenArg = { confirm_token: z.string().min(16).optional() } as const;

/** Resolve the projection mode from a validated `projection` arg (defaults to brief). */
function modeOf(args: { projection?: ProjectionMode }): ProjectionMode {
  return args.projection ?? "brief";
}

/**
 * Build a ProjectionContext for calendar ops: attaches the requested `fields`, a display time
 * zone, an optional calendar-id → name map, and the caller's own addresses (for own_status).
 */
function calendarCtx(
  args: { fields?: string[]; time_zone?: string | null },
  extra?: Partial<ProjectionContext>,
): ProjectionContext {
  const ctx: ProjectionContext = {};
  if (args.fields) ctx.fields = args.fields;
  if (typeof args.time_zone === "string") ctx.timeZone = args.time_zone;
  return { ...ctx, ...extra };
}

/** Project a list of raw items through the op's projector, honoring projection/fields. */
function projectList(
  kind: OpDefinition["projection"],
  items: unknown[],
  mode: ProjectionMode,
  ctx: ProjectionContext,
): unknown[] {
  return items.map((raw) => project(kind, raw, mode, ctx));
}

/** Fetch calendar id → name map for resolving BriefEvent.calendar (single round trip, cached-ish). */
async function calendarNameMap(
  ctx: OpContext,
  auth: JmapAuth,
  accountId: Id,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await ctx.jmap.call(auth, USING_CALENDARS, "Calendar/get", {
      accountId,
      ids: null,
      properties: ["id", "name"],
    });
    const list = Array.isArray(res.list) ? res.list as Array<{ id?: string; name?: string }> : [];
    for (const cal of list) {
      if (cal.id) map.set(cal.id, cal.name ?? cal.id);
    }
  } catch {
    // Name resolution is best-effort; on failure ids are surfaced verbatim by the projector.
  }
  return map;
}

/** Fetch the caller's own ParticipantIdentity calendarAddresses (lowercased, for rsvp matching). */
async function ownParticipantAddresses(
  ctx: OpContext,
  auth: JmapAuth,
  accountId: Id,
): Promise<string[]> {
  const res = await ctx.jmap.call(auth, USING_CALENDARS, "ParticipantIdentity/get", {
    accountId,
    ids: null,
  });
  const list = Array.isArray(res.list) ? res.list as ParticipantIdentity[] : [];
  return list
    .map((pi) => pi.calendarAddress)
    .filter((a): a is string => typeof a === "string" && a.length > 0)
    .map((a) => a.toLowerCase());
}

/**
 * Turn a normalized /set SetOutcome into a mutation Envelope carrying the affected items
 * (brief-projected) + `failed`. `getBackFilled` optionally supplies fully-read items to project.
 */
function mutationEnvelope(
  outcome: SetOutcome,
  kind: OpDefinition["projection"],
  mode: ProjectionMode,
  ctx: ProjectionContext,
  readItems?: unknown[],
): Envelope {
  const items = readItems ? projectList(kind, readItems, mode, ctx) : [
    ...Object.values(outcome.created),
    ...Object.entries(outcome.updated).map(([id, v]) => (v && typeof v === "object" ? v : { id })),
  ].map((raw) => project(kind, raw, mode, ctx));
  const envelope: Envelope = { items };
  if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
  if (outcome.new_state) envelope.state = outcome.new_state;
  return envelope;
}

/** Build a ConfirmChallenge for a two-phase gated op. */
async function challenge(
  ctx: OpContext,
  intent: ConfirmIntent,
  summary: string,
  preview: unknown,
): Promise<ConfirmChallenge> {
  const token = await mintConfirmToken(ctx.config.confirmationSecret, intent);
  // The token embeds its own expiry; recompute the display value from the same default TTL.
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return {
    confirmation_required: true,
    summary,
    preview,
    confirm_token: token,
    expires_at: expiresAt,
  };
}

/**
 * Decide whether a gated mutation may proceed. Returns either:
 *  - {ok:true} to execute, or
 *  - {ok:false, challenge} (two-phase, no valid token) to return to the caller.
 * When a token IS present but invalid, throws with an actionable diff (safety contract).
 */
async function gateMutation(
  ctx: OpContext,
  opName: string,
  intent: ConfirmIntent,
  gateInputs: {
    confirmClass: OpDefinition["confirmClass"];
    recipientCount?: number;
    queryPowered?: boolean;
    itemCount?: number;
    effectiveClassOverride?: OpDefinition["confirmClass"];
  },
  confirmToken: string | undefined,
  summary: string,
  preview: unknown,
): Promise<{ ok: true } | { ok: false; challenge: ConfirmChallenge }> {
  const gate = effectiveGate({ policy: ctx.policy, ...gateInputs });
  if (gate === "direct") return { ok: true };

  if (!confirmToken) {
    return { ok: false, challenge: await challenge(ctx, intent, summary, preview) };
  }
  const verdict = await verifyConfirmToken(ctx.config.confirmationSecret, confirmToken, intent);
  if (!verdict.ok) {
    const detail = verdict.reason === "mismatch" && verdict.diff
      ? ` The request changed since the token was issued: ${JSON.stringify(verdict.diff)}`
      : "";
    throw new Error(
      `Confirmation token ${verdict.reason ?? "invalid"} for ${opName}.${detail} ` +
        `Re-run without confirm_token to obtain a fresh challenge.`,
    );
  }
  return { ok: true };
}

/** Recipient count = distinct non-owner participants an outward scheduling message would reach. */
function participantRecipientCount(event: TypedEvent | undefined): number {
  if (!event?.participants) return 0;
  return Object.keys(event.participants).length;
}

/** Merge notFound arrays from a /get into a mutation envelope's not_found. */
function attachNotFound(envelope: Envelope, res: Record<string, unknown>): void {
  if (Array.isArray(res.notFound) && res.notFound.length > 0) {
    envelope.not_found = res.notFound as Id[];
  }
}

// =================================================================================================
// calendar.list → list_calendars
// =================================================================================================

const listCalendarsInput = {
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

const listCalendars = defineOp({
  name: "calendar.list",
  mcpName: "list_calendars",
  description:
    "List the user's calendars (their personal JMAP calendar account). Returns typed calendars " +
    "with name, isDefault, and myRights (read/write/share/delete). Note: freeBusy-only shared " +
    "calendars are invisible here — 'not listed' does not mean 'does not exist' when reasoning " +
    "about availability (use get_availability for that). Use before create_events/search_events " +
    "when you need a calendar id or to pick the default calendar.",
  input: listCalendarsInput,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "calendar",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const res = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/get", {
      accountId,
      ids: null,
    });
    const raw = envelopeFromGet(res);
    const mode = modeOf(args);
    const ctxProj = calendarCtx(args);
    const envelope: Envelope = { items: projectList("calendar", raw.items, mode, ctxProj) };
    if (raw.not_found) envelope.not_found = raw.not_found;
    if (raw.state) envelope.state = raw.state;
    return envelope;
  },
});

// =================================================================================================
// event.search → search_events
// =================================================================================================

const searchEventsInput = {
  account_id: AccountIdSchema,
  in_calendar: JmapIdSchema.optional(),
  /** LocalDateTime, compared against event END (overlap semantics). */
  after: LocalDateTimeSchema.optional(),
  /** LocalDateTime, compared against event START. */
  before: LocalDateTimeSchema.optional(),
  text: z.string().optional(),
  title: z.string().optional(),
  location: z.string().optional(),
  uid: z.string().optional(),
  /** Interpretation zone for after/before AND for computed brief.end. */
  time_zone: TimeZoneIdSchema.optional(),
  /**
   * Expand recurring events into per-instance synthetic ids (usable in read/update/delete_events).
   * REQUIRES both `after` and `before` (server errors otherwise); enforced here.
   */
  expand: z.boolean().optional(),
  limit: LimitSchema,
  calculate_total: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

const searchEvents = defineOp({
  name: "event.search",
  mcpName: "search_events",
  description:
    "Search the user's calendar events with a typed filter. Time bounds are LocalDateTime in the " +
    "time_zone arg (default Etc/UTC), NOT UTC: `after` is compared against each event's END and " +
    "`before` against its START (overlap semantics). Set expand:true to expand recurring events " +
    "into individual occurrences — this REQUIRES both after and before, and returns synthetic " +
    "per-instance ids plus utcStart/utcEnd. Those synthetic ids address a single occurrence in " +
    "read_events / update_event / delete_events. Follow up with read_events for details.",
  input: searchEventsInput,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "event",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );

    // Build the bare FilterCondition (draft-26: no operators when expanding).
    const filterRaw: Record<string, unknown> = {};
    if (args.in_calendar) filterRaw.inCalendar = args.in_calendar;
    if (args.after) filterRaw.after = args.after;
    if (args.before) filterRaw.before = args.before;
    if (args.text) filterRaw.text = args.text;
    if (args.title) filterRaw.title = args.title;
    if (args.location) filterRaw.location = args.location;
    if (args.uid) filterRaw.uid = args.uid;
    const filter = EventFilterConditionSchema.parse(filterRaw);

    // expandRecurrences requires BOTH bounds (schema-enforced downstream + provider quirk). Fail
    // fast here with an actionable message rather than letting the server return invalidArguments.
    if (args.expand && (args.after === undefined || args.before === undefined)) {
      throw new Error(
        "search_events expand:true requires both `after` and `before` time bounds.",
      );
    }

    const queryArgs: Record<string, unknown> = {
      accountId,
      filter,
      sort: [{ property: "start" }],
      limit: args.limit,
    };
    if (args.calculate_total) queryArgs.calculateTotal = true;
    if (args.expand) queryArgs.expandRecurrences = true;
    if (args.time_zone) queryArgs.timeZone = args.time_zone;

    // query → get chain via back-reference (#ids). For expanded instances, opt in to utcStart/
    // utcEnd (safe: recurrenceOverrides is NOT requested for synthetic ids, so the fetch-time
    // mutual-exclusion rule is respected). Non-expanded reads use the server's default properties.
    const getArgs: Record<string, unknown> = {
      accountId,
      "#ids": ref("q", "CalendarEvent/query", "/ids"),
    };
    if (args.expand) {
      getArgs.properties = [
        "@type",
        "uid",
        "title",
        "description",
        "start",
        "duration",
        "timeZone",
        "status",
        "calendarIds",
        "baseEventId",
        "recurrenceId",
        "participants",
        "locations",
        "virtualLocations",
        "utcStart",
        "utcEnd",
      ];
    }

    const result = await ctx.jmap.request(ctx.actor, USING_CALENDARS, [
      ["CalendarEvent/query", queryArgs, "q"],
      ["CalendarEvent/get", getArgs, "g"],
    ]);
    const queryRes = expectResponse(result.methodResponses, "CalendarEvent/query", "q");
    const getRes = expectResponse(result.methodResponses, "CalendarEvent/get", "g");

    const queryEnvelope = envelopeFromQuery(queryRes);
    const getEnvelope = envelopeFromGet(getRes);

    const mode = modeOf(args);
    const calendars = mode === "raw" ? undefined : await calendarNameMap(ctx, ctx.actor, accountId);
    const ctxProj = calendarCtx(args, calendars ? { calendars } : undefined);

    const envelope: Envelope = { items: projectList("event", getEnvelope.items, mode, ctxProj) };
    if (queryEnvelope.total !== undefined) envelope.total = queryEnvelope.total;
    if (queryEnvelope.state) envelope.state = queryEnvelope.state;
    attachNotFound(envelope, getRes);
    return envelope;
  },
});

// =================================================================================================
// event.read → read_events
// =================================================================================================

const readEventsInput = {
  account_id: AccountIdSchema,
  ids: IdsSchema,
  /** UTCDateTime bound — only overrides whose recurrenceId is before this are returned. */
  recurrence_overrides_before: UtcDateTimeSchema.optional(),
  /** UTCDateTime bound — only overrides on-or-after this are returned. */
  recurrence_overrides_after: UtcDateTimeSchema.optional(),
  /** Return only owners + participants matching the caller's identities. */
  reduce_participants: z.boolean().optional(),
  /** TimeZone for interpreting floating events' utcStart/utcEnd and computed brief.end. */
  time_zone: TimeZoneIdSchema.optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

const readEvents = defineOp({
  name: "event.read",
  mcpName: "read_events",
  description:
    "Read full calendar events by id — accepts base event ids AND synthetic per-occurrence ids " +
    "from search_events(expand:true). For recurring base events, recurrence_overrides_before/" +
    "after bound which overrides are returned. reduce_participants trims to owners + you. Note: " +
    "utcStart/utcEnd and recurrenceOverrides are mutually exclusive at fetch time, so this op " +
    "does not request utcStart/utcEnd (the brief projection computes `end` from start+duration).",
  input: readEventsInput,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "event",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const getArgs: Record<string, unknown> = { accountId, ids: args.ids };
    if (args.recurrence_overrides_before) {
      getArgs.recurrenceOverridesBefore = args.recurrence_overrides_before;
    }
    if (args.recurrence_overrides_after) {
      getArgs.recurrenceOverridesAfter = args.recurrence_overrides_after;
    }
    if (args.reduce_participants) getArgs.reduceParticipants = true;
    if (args.time_zone) getArgs.timeZone = args.time_zone;

    const res = await ctx.jmap.getChunked(ctx.actor, USING_CALENDARS, "CalendarEvent/get", {
      accountId,
      ids: args.ids,
      ...getArgs,
    });
    const raw = envelopeFromGet(res);
    const mode = modeOf(args);
    const calendars = mode === "raw" ? undefined : await calendarNameMap(ctx, ctx.actor, accountId);
    const own = mode === "raw"
      ? undefined
      : await ownParticipantAddresses(ctx, ctx.actor, accountId).catch(() => undefined);
    const ctxProj = calendarCtx(args, {
      ...(calendars ? { calendars } : {}),
      ...(own ? { ownAddresses: own } : {}),
    });
    const envelope: Envelope = { items: projectList("event", raw.items, mode, ctxProj) };
    if (raw.not_found) envelope.not_found = raw.not_found;
    if (raw.state) envelope.state = raw.state;
    return envelope;
  },
});

// =================================================================================================
// event.create → create_events
// =================================================================================================

const createEventsInput = {
  account_id: AccountIdSchema,
  /** One or more TypedEvents (full RFC 8984 schema; server-set props rejected). */
  events: z.array(EventCreateSchema).min(1).max(100),
  /**
   * Send iTIP scheduling messages after create. DEFAULT false. WARNING both directions: true
   * emails every participant an invitation; false silently creates an event nobody is notified of.
   */
  send_invitations: z.boolean().optional(),
  /** Create as drafts (no scheduling messages / alert pushes regardless of send_invitations). */
  is_draft: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
  ...ConfirmTokenArg,
} as const;

const createEvents = defineOp({
  name: "event.create",
  mcpName: "create_events",
  description:
    "Create one or more calendar events from full RFC 8984 JSCalendar bodies — the schema is the " +
    "whole spec, not just basics: recurrenceRules (byDay/byMonthDay/bySetPosition for 'last " +
    "Friday monthly', count/until, non-Gregorian rscale, skip) plus recurrenceOverrides to " +
    "add/skip/reshape single occurrences; alerts (offset or absolute triggers); multiple " +
    "locations (relativeTo start/end + per-location timeZone for travel legs) and " +
    "virtualLocations (video-call URIs); links/attachments; all-day (showWithoutTime), floating " +
    "time (timeZone null), freeBusyStatus, privacy, priority, color, keywords; utcStart/utcEnd " +
    "write shortcut. `start` is wall-clock LocalDateTime interpreted in timeZone. Server-set " +
    "props (id/uid/created/…) are rejected. send_invitations (default false) controls iTIP: true " +
    "emails every participant an invitation, false creates the event WITHOUT notifying anyone — " +
    "pick deliberately. Confirmation is only required when send_invitations is true. Use is_draft " +
    "to stage without any scheduling side effects.",
  input: createEventsInput,
  annotations: { destructive: false },
  confirmClass: "outward",
  projection: "event",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );

    // Build the create map (creationId → event body). Fold is_draft into each body.
    const create: Record<string, TypedEvent> = {};
    let recipientCount = 0;
    args.events.forEach((event, i) => {
      const body: TypedEvent = { ...(event as TypedEvent) };
      if (args.is_draft) body.isDraft = true;
      create[`e${i}`] = body;
      recipientCount += participantRecipientCount(body);
    });

    const intent: ConfirmIntent = {
      op: "event.create",
      account_id: accountId,
      resource_ids: Object.keys(create),
      payload: { create, send_invitations: !!args.send_invitations },
      actor_fingerprint: ctx.actor.fingerprint,
    };
    // Confirmation only ever applies when actually sending invitations.
    const gateResult = await gateMutation(
      ctx,
      "event.create",
      intent,
      {
        confirmClass: "outward",
        recipientCount,
        effectiveClassOverride: args.send_invitations ? "outward" : "none",
      },
      args.confirm_token,
      `Create ${args.events.length} event(s)` +
        (args.send_invitations ? ` and email ${recipientCount} participant(s)` : ""),
      args.events.map((e) => project("event", e, "brief", calendarCtx(args))),
    );
    if (!gateResult.ok) return gateResult.challenge;

    const setArgs: Record<string, unknown> = { accountId, create };
    if (args.send_invitations) setArgs.sendSchedulingMessages = true;

    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "CalendarEvent/set", setArgs);
    const outcome = setOutcome(setRes);

    // Re-read created events for a faithful projection (server fills uid/created/etc.).
    const createdIds = Object.values(outcome.created)
      .map((v) => (v as { id?: string }).id)
      .filter((id): id is string => typeof id === "string");
    const mode = modeOf(args);
    let readItems: unknown[] | undefined;
    if (createdIds.length > 0) {
      const getRes = await ctx.jmap.getChunked(ctx.actor, USING_CALENDARS, "CalendarEvent/get", {
        accountId,
        ids: createdIds,
      });
      readItems = Array.isArray(getRes.list) ? getRes.list : undefined;
    }
    const calendars = mode === "raw" ? undefined : await calendarNameMap(ctx, ctx.actor, accountId);
    const ctxProj = calendarCtx(args, calendars ? { calendars } : undefined);
    return mutationEnvelope(outcome, "event", mode, ctxProj, readItems);
  },
});

// =================================================================================================
// event.update → update_event
// =================================================================================================

const eventPatchFieldsInput = {
  title: z.string().optional(),
  /** LocalDateTime. */
  start: LocalDateTimeSchema.optional(),
  duration: z.string().optional(),
  time_zone: TimeZoneIdSchema.nullable().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["confirmed", "cancelled", "tentative"]).optional(),
} as const;

const updateEventInput = {
  account_id: AccountIdSchema,
  /** Base event id OR a synthetic per-occurrence id (= "just this occurrence"). */
  id: JmapIdSchema,
  /** Convenience typed patch fields (mutually usable with `patch` — `patch` wins on conflict). */
  ...eventPatchFieldsInput,
  /**
   * JSCalendar PatchObject reaching any writable RFC 8984 property (JSON-Pointer keys with
   * implicit leading `/`, null = remove; pointers MUST NOT reference inside arrays — replace the
   * array wholesale; intermediate objects must already exist).
   */
  patch: PatchObjectSchema.optional(),
  /** Send iTIP updates to participants after the change (REQUEST if origin, else REPLY). */
  send_updates: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
  ...ConfirmTokenArg,
} as const;

const updateEvent = defineOp({
  name: "event.update",
  mcpName: "update_event",
  description:
    "Update ONE event. Target a base event id to change the whole series, OR a synthetic " +
    "per-occurrence id from search_events(expand:true) to change just that occurrence (the " +
    "server records it as a recurrenceOverride — there is no updateScope/destroyScope). " +
    "Convenience fields cover the basics; `patch` reaches EVERY writable RFC 8984 property — " +
    "recurrenceRules, recurrenceOverrides, alerts, locations/virtualLocations, links, " +
    "participants (deep pointers like participants/<id>/participationStatus), showWithoutTime, " +
    "freeBusyStatus, privacy, color, keywords — as JSON-Pointer keys, null removes. Time-zone " +
    "footgun: `start` is wall-clock in time_zone, so patching time_zone alone SHIFTS the actual " +
    "instant; to relabel the zone keeping the same moment, convert start in the same call. " +
    "send_updates emails participants; without it, scheduled attendees silently desync. " +
    "Confirmation applies only when messaging.",
  input: updateEventInput,
  annotations: { idempotent: true },
  confirmClass: "outward",
  projection: "event",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );

    // Assemble the patch: convenience fields → top-level property patches, merged under `patch`.
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.start !== undefined) patch.start = args.start;
    if (args.duration !== undefined) patch.duration = args.duration;
    if (args.time_zone !== undefined) patch.timeZone = args.time_zone;
    if (args.description !== undefined) patch.description = args.description;
    if (args.status !== undefined) patch.status = args.status;
    if (args.location !== undefined) {
      // A bare location string is set as a single Location object (replace the whole map, since
      // PatchObject pointers cannot create intermediate objects).
      patch.locations = { l1: { "@type": "Location", name: args.location } };
    }
    if (args.patch) Object.assign(patch, args.patch);

    if (Object.keys(patch).length === 0) {
      throw new Error("update_event requires at least one field or a `patch` object.");
    }

    const intent: ConfirmIntent = {
      op: "event.update",
      account_id: accountId,
      resource_ids: [args.id],
      payload: { patch, send_updates: !!args.send_updates },
      actor_fingerprint: ctx.actor.fingerprint,
    };
    const gateResult = await gateMutation(
      ctx,
      "event.update",
      intent,
      {
        confirmClass: "outward",
        // Recipient count is unknown before reading the event; treat "messaging" as gated unless
        // policy is minimal. Not messaging → de-escalate to none.
        recipientCount: args.send_updates ? Number.MAX_SAFE_INTEGER : 0,
        effectiveClassOverride: args.send_updates ? "outward" : "none",
      },
      args.confirm_token,
      `Update event ${args.id}` + (args.send_updates ? " and notify participants" : ""),
      { id: args.id, patch },
    );
    if (!gateResult.ok) return gateResult.challenge;

    const setArgs: Record<string, unknown> = { accountId, update: { [args.id]: patch } };
    if (args.send_updates) setArgs.sendSchedulingMessages = true;

    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "CalendarEvent/set", setArgs);
    const outcome = setOutcome(setRes);

    const mode = modeOf(args);
    let readItems: unknown[] | undefined;
    if (!outcome.allFailed) {
      const getRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "CalendarEvent/get", {
        accountId,
        ids: [args.id],
      });
      readItems = Array.isArray(getRes.list) ? getRes.list : undefined;
    }
    const calendars = mode === "raw" ? undefined : await calendarNameMap(ctx, ctx.actor, accountId);
    const own = mode === "raw"
      ? undefined
      : await ownParticipantAddresses(ctx, ctx.actor, accountId).catch(() => undefined);
    const ctxProj = calendarCtx(args, {
      ...(calendars ? { calendars } : {}),
      ...(own ? { ownAddresses: own } : {}),
    });
    return mutationEnvelope(outcome, "event", mode, ctxProj, readItems);
  },
});

// =================================================================================================
// event.delete → delete_events
// =================================================================================================

const deleteEventsInput = {
  account_id: AccountIdSchema,
  /** Base ids (destroy the event) or synthetic instance ids (exclude that one occurrence). */
  ids: IdsSchema,
  /** Send iTIP CANCEL to participants (origin) after destroy. */
  send_cancellations: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
  ...ConfirmTokenArg,
} as const;

const deleteEvents = defineOp({
  name: "event.delete",
  mcpName: "delete_events",
  description:
    "Delete calendar events by id. A base event id destroys the whole event; a synthetic " +
    "per-occurrence id from search_events(expand:true) excludes just that one occurrence from a " +
    "recurring series (the rest remain). send_cancellations emails participants an iTIP CANCEL. " +
    "This is destructive and always requires confirmation: call once to get a confirm_token, then " +
    "repeat the identical call with confirm_token to execute.",
  input: deleteEventsInput,
  annotations: { destructive: true, idempotent: true },
  confirmClass: "destructive",
  projection: "event",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );

    const intent: ConfirmIntent = {
      op: "event.delete",
      account_id: accountId,
      resource_ids: [...args.ids].sort(),
      payload: { send_cancellations: !!args.send_cancellations },
      actor_fingerprint: ctx.actor.fingerprint,
    };
    // Preview: brief-read the targets before destroying (best effort).
    let preview: unknown;
    try {
      const previewRes = await ctx.jmap.getChunked(
        ctx.actor,
        USING_CALENDARS,
        "CalendarEvent/get",
        { accountId, ids: args.ids },
      );
      const items = Array.isArray(previewRes.list) ? previewRes.list : [];
      preview = projectList("event", items, "brief", calendarCtx(args));
    } catch {
      preview = args.ids;
    }

    const gateResult = await gateMutation(
      ctx,
      "event.delete",
      intent,
      { confirmClass: "destructive", itemCount: args.ids.length },
      args.confirm_token,
      `Delete ${args.ids.length} event(s)` +
        (args.send_cancellations ? " and send cancellations" : ""),
      preview,
    );
    if (!gateResult.ok) return gateResult.challenge;

    const setRes = await ctx.jmap.setChunked(ctx.actor, USING_CALENDARS, "CalendarEvent/set", {
      accountId,
      destroy: args.ids,
      ...(args.send_cancellations ? { sendSchedulingMessages: true } : {}),
    });
    const outcome = setOutcome(setRes);
    const envelope: Envelope = {
      items: outcome.destroyed.map((id) => ({ id, deleted: true })),
    };
    if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
    if (outcome.new_state) envelope.state = outcome.new_state;
    return envelope;
  },
});

// =================================================================================================
// event.rsvp → respond_to_event
// =================================================================================================

const rsvpInput = {
  account_id: AccountIdSchema,
  /** Base event id (or synthetic instance id) to respond to. */
  id: JmapIdSchema,
  /** Your response. */
  status: z.enum(["accepted", "declined", "tentative"]),
  /** Optional free-text comment attached to your participation. */
  comment: z.string().optional(),
  /**
   * For a recurring event, respond to just one occurrence by its LocalDateTime recurrence id
   * (an override is written at participants/<you>/participationStatus for that occurrence).
   */
  occurrence_id: LocalDateTimeSchema.optional(),
  /** Send an iTIP REPLY to the organizer. DEFAULT true. */
  notify_organizer: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
  ...ConfirmTokenArg,
} as const;

const respondToEvent = defineOp({
  name: "event.rsvp",
  mcpName: "respond_to_event",
  description:
    "RSVP to an event invitation on the user's calendar. Set status to accepted/declined/" +
    "tentative; the op finds your own participant entry by matching your ParticipantIdentity " +
    "calendarAddress (hybrid-tolerant). For a recurring event, occurrence_id (a LocalDateTime " +
    "recurrence id) responds to just that occurrence. notify_organizer (default true) sends an " +
    "iTIP REPLY. Confirmation applies only when notifying. There is no counter-proposal mechanism.",
  input: rsvpInput,
  annotations: { idempotent: true },
  confirmClass: "outward",
  projection: "event",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );

    // Read the event and find the caller's own participant id via the provider normalizer.
    const getRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "CalendarEvent/get", {
      accountId,
      ids: [args.id],
    });
    const event = Array.isArray(getRes.list) ? getRes.list[0] as TypedEvent | undefined : undefined;
    if (!event) throw new Error(`Event ${args.id} not found.`);

    const ownAddresses = await ownParticipantAddresses(ctx, ctx.actor, accountId);
    const own = ctx.provider.normalize.ownParticipant(event, ownAddresses);
    if (!own) {
      throw new Error(
        `No participant entry on event ${args.id} matches your calendar identities — cannot RSVP.`,
      );
    }

    // Build the patch. Whole-series → patch participant status directly; single occurrence →
    // patch inside a recurrenceOverride keyed by the LocalDateTime recurrence id (JSON-Pointer
    // `~1` escapes the `/` in the deep path segment).
    const escId = own.participantId.replaceAll("~", "~0").replaceAll("/", "~1");
    const notify = args.notify_organizer !== false;
    const patch: Record<string, unknown> = {};
    if (args.occurrence_id) {
      const key = args.occurrence_id.replaceAll("~", "~0").replaceAll("/", "~1");
      patch[`recurrenceOverrides/${key}/participants/${escId}/participationStatus`] = args.status;
      if (args.comment !== undefined) {
        patch[`recurrenceOverrides/${key}/participants/${escId}/participationComment`] =
          args.comment;
      }
    } else {
      patch[`participants/${escId}/participationStatus`] = args.status;
      if (args.comment !== undefined) {
        patch[`participants/${escId}/participationComment`] = args.comment;
      }
    }

    const intent: ConfirmIntent = {
      op: "event.rsvp",
      account_id: accountId,
      resource_ids: [args.id],
      payload: { patch, notify_organizer: notify },
      actor_fingerprint: ctx.actor.fingerprint,
    };
    const gateResult = await gateMutation(
      ctx,
      "event.rsvp",
      intent,
      {
        confirmClass: "outward",
        recipientCount: 1, // the organizer
        effectiveClassOverride: notify ? "outward" : "none",
      },
      args.confirm_token,
      `RSVP ${args.status} to event ${args.id}` + (notify ? " and notify the organizer" : ""),
      { id: args.id, status: args.status, own_participant: own.participantId },
    );
    if (!gateResult.ok) return gateResult.challenge;

    const setArgs: Record<string, unknown> = { accountId, update: { [args.id]: patch } };
    if (notify) setArgs.sendSchedulingMessages = true;
    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "CalendarEvent/set", setArgs);
    const outcome = setOutcome(setRes);

    const mode = modeOf(args);
    let readItems: unknown[] | undefined;
    if (!outcome.allFailed) {
      const reread = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "CalendarEvent/get", {
        accountId,
        ids: [args.id],
      });
      readItems = Array.isArray(reread.list) ? reread.list : undefined;
    }
    const calendars = mode === "raw" ? undefined : await calendarNameMap(ctx, ctx.actor, accountId);
    const ctxProj = calendarCtx(args, {
      ...(calendars ? { calendars } : {}),
      ownAddresses,
    });
    return mutationEnvelope(outcome, "event", mode, ctxProj, readItems);
  },
});

// =================================================================================================
// calendar.availability → get_availability
// =================================================================================================

const availabilityInput = {
  account_id: AccountIdSchema,
  /** Calendar addresses (e.g. "mailto:daria@…") to look up availability for. */
  addresses: z.array(z.string().min(1)).optional(),
  /** Principal ids (from search_people) to look up availability for. */
  principal_ids: z.array(JmapIdSchema).optional(),
  /** Window start (inclusive), UTCDateTime. */
  utc_start: UtcDateTimeSchema,
  /** Window end (exclusive), UTCDateTime. */
  utc_end: UtcDateTimeSchema,
  /** Include the underlying event for each busy period (subject to privacy/rights). */
  show_details: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

const getAvailability = defineOp({
  name: "calendar.availability",
  mcpName: "get_availability",
  description:
    "Get free/busy availability for people over a UTC window, for scheduling. Identify people by " +
    "`addresses` (calendar addresses like mailto:x@y) and/or `principal_ids` (from search_people). " +
    "Returns normalized busy periods {start, end, status} where status precedence is " +
    "confirmed > unavailable > tentative. show_details attaches the event when privacy and your " +
    "rights allow. Use this before create_events to find open slots — do not guess from " +
    "search_events, which only sees your own calendars.",
  input: availabilityInput,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "busy",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    if (!args.addresses?.length && !args.principal_ids?.length) {
      throw new Error("get_availability requires at least one address or principal_id.");
    }
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_PRINCIPALS,
      args.account_id,
    );

    // Resolve calendar addresses → principal ids via Principal/query (availability filter).
    const principalIds = new Set<string>(args.principal_ids ?? []);
    if (args.addresses?.length) {
      for (const address of args.addresses) {
        const qRes = await ctx.jmap.call(ctx.actor, USING_PRINCIPALS, "Principal/query", {
          accountId,
          filter: { calendarAddress: address },
          limit: 1,
        });
        const ids = Array.isArray(qRes.ids) ? qRes.ids as string[] : [];
        for (const id of ids) principalIds.add(id);
      }
    }
    if (principalIds.size === 0) {
      const empty: Envelope = { items: [] };
      return empty;
    }

    // One Principal/getAvailability per principal; merge busy periods.
    const busy: unknown[] = [];
    const failed: Record<string, SetError> = {};
    for (const id of principalIds) {
      try {
        const res = await ctx.jmap.call(
          ctx.actor,
          USING_PRINCIPALS,
          "Principal/getAvailability",
          {
            accountId,
            id,
            utcStart: args.utc_start,
            utcEnd: args.utc_end,
            ...(args.show_details ? { showDetails: true } : {}),
          },
        );
        if (Array.isArray(res.list)) busy.push(...res.list);
      } catch (err) {
        failed[id] = { type: "forbidden", description: (err as Error).message };
      }
    }

    const mode = modeOf(args);
    const ctxProj = calendarCtx(args);
    const envelope: Envelope = { items: projectList("busy", busy, mode, ctxProj) };
    if (Object.keys(failed).length > 0) envelope.failed = failed;
    return envelope;
  },
});

// =================================================================================================
// calendar.create → create_calendar  (CLI)
// =================================================================================================

const calendarWritableInput = {
  name: z.string().min(1).max(255).optional(),
  description: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
  is_subscribed: z.boolean().optional(),
  is_visible: z.boolean().optional(),
  include_in_availability: z.enum(["all", "attending", "none"]).optional(),
  time_zone: TimeZoneIdSchema.nullable().optional(),
} as const;

/** Map snake_case calendar convenience fields → spec camelCase Calendar props. */
function calendarBody(args: {
  name?: string;
  description?: string | null;
  color?: string | null;
  sort_order?: number;
  is_subscribed?: boolean;
  is_visible?: boolean;
  include_in_availability?: string;
  time_zone?: string | null;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (args.name !== undefined) body.name = args.name;
  if (args.description !== undefined) body.description = args.description;
  if (args.color !== undefined) body.color = args.color;
  if (args.sort_order !== undefined) body.sortOrder = args.sort_order;
  if (args.is_subscribed !== undefined) body.isSubscribed = args.is_subscribed;
  if (args.is_visible !== undefined) body.isVisible = args.is_visible;
  if (args.include_in_availability !== undefined) {
    body.includeInAvailability = args.include_in_availability;
  }
  if (args.time_zone !== undefined) body.timeZone = args.time_zone;
  return body;
}

const createCalendar = defineOp({
  name: "calendar.create",
  mcpName: "create_calendar",
  description:
    "Create a calendar in the user's calendar account. Set name (required), and optionally " +
    "color, description, timeZone, sortOrder, subscription/visibility and includeInAvailability. " +
    "isDefault cannot be set here — use manage_calendar/set_default (onSuccessSetIsDefault).",
  input: {
    account_id: AccountIdSchema,
    ...calendarWritableInput,
    projection: ProjectionSchema,
    fields: FieldsSchema,
  },
  annotations: {},
  confirmClass: "none",
  projection: "calendar",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const body = calendarBody(args);
    if (body.name === undefined) throw new Error("create_calendar requires a name.");
    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/set", {
      accountId,
      create: { c0: body },
    });
    const outcome = setOutcome(setRes);
    const mode = modeOf(args);
    return mutationEnvelope(outcome, "calendar", mode, calendarCtx(args));
  },
});

// =================================================================================================
// calendar.update → update_calendar  (CLI)
// =================================================================================================

const updateCalendarInput = {
  account_id: AccountIdSchema,
  id: JmapIdSchema,
  ...calendarWritableInput,
  /** Set this calendar as the account default (via onSuccessSetIsDefault; silent no-op on failure). */
  set_default: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

const updateCalendar = defineOp({
  name: "calendar.update",
  mcpName: "update_calendar",
  description:
    "Update a calendar's per-user properties (name, color, description, timeZone, sortOrder, " +
    "subscription/visibility, includeInAvailability). isDefault is server-set: pass set_default:" +
    "true to request it via onSuccessSetIsDefault — that path fails SILENTLY, so the op re-reads " +
    "the calendar to confirm and reports the actual isDefault in the result.",
  input: updateCalendarInput,
  annotations: { idempotent: true },
  confirmClass: "none",
  projection: "calendar",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const body = calendarBody(args);
    const setArgs: Record<string, unknown> = { accountId };
    if (Object.keys(body).length > 0) setArgs.update = { [args.id]: body };
    if (args.set_default) setArgs.onSuccessSetIsDefault = args.id;
    if (!setArgs.update && !args.set_default) {
      throw new Error("update_calendar requires at least one field or set_default.");
    }
    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/set", setArgs);
    const outcome = setOutcome(setRes);

    // Re-read to verify (isDefault is server-set; onSuccessSetIsDefault is a silent no-op path).
    const getRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/get", {
      accountId,
      ids: [args.id],
    });
    const readItems = Array.isArray(getRes.list) ? getRes.list : undefined;
    const mode = modeOf(args);
    return mutationEnvelope(outcome, "calendar", mode, calendarCtx(args), readItems);
  },
});

// =================================================================================================
// calendar.delete → delete_calendar  (CLI)
// =================================================================================================

const deleteCalendarInput = {
  account_id: AccountIdSchema,
  id: JmapIdSchema,
  /** Required to destroy a non-empty calendar (onDestroyRemoveEvents); else `calendarHasEvent`. */
  delete_events: z.boolean().optional(),
  projection: ProjectionSchema,
  ...ConfirmTokenArg,
} as const;

const deleteCalendar = defineOp({
  name: "calendar.delete",
  mcpName: "delete_calendar",
  description: "Delete a calendar. If it still contains events you MUST pass delete_events:true " +
    "(onDestroyRemoveEvents) or the server refuses with calendarHasEvent; delete_events:true " +
    "removes those events (and destroys any that live in no other calendar). Destructive — always " +
    "two-phase: call once for a confirm_token, then repeat with confirm_token.",
  input: deleteCalendarInput,
  annotations: { destructive: true },
  confirmClass: "destructive",
  projection: "calendar",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const intent: ConfirmIntent = {
      op: "calendar.delete",
      account_id: accountId,
      resource_ids: [args.id],
      payload: { delete_events: !!args.delete_events },
      actor_fingerprint: ctx.actor.fingerprint,
    };
    const gateResult = await gateMutation(
      ctx,
      "calendar.delete",
      intent,
      { confirmClass: "destructive", itemCount: 1 },
      args.confirm_token,
      `Delete calendar ${args.id}` + (args.delete_events ? " and all its events" : ""),
      { id: args.id, delete_events: !!args.delete_events },
    );
    if (!gateResult.ok) return gateResult.challenge;

    const setArgs: Record<string, unknown> = { accountId, destroy: [args.id] };
    if (args.delete_events) setArgs.onDestroyRemoveEvents = true;
    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/set", setArgs);
    const outcome = setOutcome(setRes);
    const envelope: Envelope = {
      items: outcome.destroyed.map((id) => ({ id, deleted: true })),
    };
    if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
    if (outcome.new_state) envelope.state = outcome.new_state;
    return envelope;
  },
});

// =================================================================================================
// calendar.share → share_calendar  (CLI)
// =================================================================================================

/** The 8-field CalendarRights (draft-26). All optional; absent = leave unchanged / false on set. */
const CalendarRightsSchema = z.object({
  mayReadFreeBusy: z.boolean().optional(),
  mayReadItems: z.boolean().optional(),
  mayWriteAll: z.boolean().optional(),
  mayWriteOwn: z.boolean().optional(),
  mayUpdatePrivate: z.boolean().optional(),
  mayRSVP: z.boolean().optional(),
  mayShare: z.boolean().optional(),
  mayDelete: z.boolean().optional(),
}).strict();

const shareCalendarInput = {
  account_id: AccountIdSchema,
  id: JmapIdSchema,
  /** Principal id to grant/change rights for (the sharee). */
  principal_id: JmapIdSchema,
  /** The 8-field CalendarRights to grant. Omit/set null to REVOKE the sharee entirely. */
  rights: CalendarRightsSchema.nullable().optional(),
  projection: ProjectionSchema,
  ...ConfirmTokenArg,
} as const;

const shareCalendar = defineOp({
  name: "calendar.share",
  mcpName: "share_calendar",
  description:
    "Change who a calendar is shared with (its shareWith ACL). Grant a principal the 8-field " +
    "CalendarRights (mayReadFreeBusy/mayReadItems/mayWriteAll/mayWriteOwn/mayUpdatePrivate/" +
    "mayRSVP/mayShare/mayDelete); pass rights:null to revoke a sharee. You cannot grant a right " +
    "you do not hold. High blast radius — always two-phase (confirm_token).",
  input: shareCalendarInput,
  annotations: {},
  confirmClass: "blast",
  projection: "calendar",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const intent: ConfirmIntent = {
      op: "calendar.share",
      account_id: accountId,
      resource_ids: [args.id],
      payload: { principal_id: args.principal_id, rights: args.rights ?? null },
      actor_fingerprint: ctx.actor.fingerprint,
    };
    const gateResult = await gateMutation(
      ctx,
      "calendar.share",
      intent,
      { confirmClass: "blast", itemCount: 1 },
      args.confirm_token,
      (args.rights
        ? `Share calendar ${args.id} with `
        : `Revoke sharing of calendar ${args.id} from `) +
        `principal ${args.principal_id}`,
      { id: args.id, principal_id: args.principal_id, rights: args.rights ?? null },
    );
    if (!gateResult.ok) return gateResult.challenge;

    // Patch a single shareWith entry (null value removes the sharee).
    const escPid = args.principal_id.replaceAll("~", "~0").replaceAll("/", "~1");
    const patch: Record<string, unknown> = {
      [`shareWith/${escPid}`]: args.rights ?? null,
    };
    const setRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/set", {
      accountId,
      update: { [args.id]: patch },
    });
    const outcome = setOutcome(setRes);
    const getRes = await ctx.jmap.call(ctx.actor, USING_CALENDARS, "Calendar/get", {
      accountId,
      ids: [args.id],
    });
    const readItems = Array.isArray(getRes.list) ? getRes.list : undefined;
    const mode = modeOf(args);
    return mutationEnvelope(outcome, "calendar", mode, calendarCtx({}), readItems);
  },
});

// =================================================================================================
// calendar.identity_set → set_participant_identity  (CLI)
// =================================================================================================

const identitySetInput = {
  account_id: AccountIdSchema,
  /** Existing ParticipantIdentity id to update; omit to create a new one. */
  id: JmapIdSchema.optional(),
  name: z.string().optional(),
  /** The iTIP calendar address URI, e.g. "mailto:sol@astrius.ink". Required on create. */
  calendar_address: z.string().min(1).optional(),
  /** Make this the default participant identity (onSuccessSetIsDefault; silent no-op on failure). */
  set_default: z.boolean().optional(),
  projection: ProjectionSchema,
  fields: FieldsSchema,
} as const;

const setParticipantIdentity = defineOp({
  name: "calendar.identity_set",
  mcpName: "set_participant_identity",
  description:
    "Create or update one of the user's participant identities — the calendar addresses that " +
    "identify them as an event participant (used to match invitations for respond_to_event). " +
    "Provide calendar_address (required on create) and name. set_default:true requests default " +
    "status via onSuccessSetIsDefault (server-set, silent on failure); the op re-reads to confirm.",
  input: identitySetInput,
  annotations: {},
  confirmClass: "none",
  projection: "identity",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const { accountId } = await ctx.jmap.resolveAccount(
      ctx.actor,
      CAP_CALENDARS,
      args.account_id,
    );
    const body: Record<string, unknown> = {};
    if (args.name !== undefined) body.name = args.name;
    if (args.calendar_address !== undefined) body.calendarAddress = args.calendar_address;

    const setArgs: Record<string, unknown> = { accountId };
    let targetId: string | undefined = args.id;
    if (args.id) {
      if (Object.keys(body).length > 0) setArgs.update = { [args.id]: body };
    } else {
      if (body.calendarAddress === undefined) {
        throw new Error("set_participant_identity requires calendar_address on create.");
      }
      setArgs.create = { pi0: body };
    }
    if (args.set_default && args.id) setArgs.onSuccessSetIsDefault = args.id;
    else if (args.set_default && !args.id) setArgs.onSuccessSetIsDefault = "#pi0";

    const setRes = await ctx.jmap.call(
      ctx.actor,
      USING_CALENDARS,
      "ParticipantIdentity/set",
      setArgs,
    );
    const outcome = setOutcome(setRes);
    if (!targetId) {
      const created = Object.values(outcome.created)[0] as { id?: string } | undefined;
      targetId = created?.id;
    }

    let readItems: unknown[] | undefined;
    if (targetId) {
      const getRes = await ctx.jmap.call(
        ctx.actor,
        USING_CALENDARS,
        "ParticipantIdentity/get",
        { accountId, ids: [targetId] },
      );
      readItems = Array.isArray(getRes.list) ? getRes.list : undefined;
    }
    const mode = modeOf(args);
    return mutationEnvelope(outcome, "identity", mode, calendarCtx(args), readItems);
  },
});

// =================================================================================================
// Registry
// =================================================================================================

export const ops: OpDefinition[] = [
  listCalendars,
  searchEvents,
  readEvents,
  createEvents,
  updateEvent,
  deleteEvents,
  respondToEvent,
  getAvailability,
  createCalendar,
  updateCalendar,
  deleteCalendar,
  shareCalendar,
  setParticipantIdentity,
];
