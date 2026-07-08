/**
 * notification + alert ops — builder ops:aux (B10-ops-misc). CLI-only surfaces.
 *
 * Ops (docs/v2-contracts.md §ops inventory):
 * - notify.list     → list_notifications     [cli]  none  readOnly  projection: notification
 *     CalendarEventNotification/query+get (or ShareNotification via kind arg); typed filter
 *     after/before (UTCDateTime on `created`), type, event ids. Includes eventPatch so the caller
 *     sees what changed. Live-probed: CalendarEventNotification/query works on account "b".
 * - notify.dismiss  → dismiss_notifications  [cli]  none            projection: notification
 *     destroy-only /set; ids array; per-item failures surfaced in `failed`.
 * - alert.ack       → ack_alert              [cli]  none            projection: raw
 *     Set `acknowledged` (UTCDateTime) on the BASE event's alert via CalendarEvent/set — never
 *     creates a recurrenceOverride (rfc-notes calendars §8).
 * - alert.snooze    → snooze_alert           [cli]  none            projection: raw
 *     Acknowledge + add an AbsoluteTrigger alert (snooze) with relatedTo pointing at the parent
 *     alert relation.
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import { CAPABILITIES, USING } from "../jmap/session.ts";
import { envelopeFromGet, setOutcome } from "../jmap/envelopes.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { ref } from "../jmap/client.ts";
import { AccountIdSchema, LimitSchema, UtcDateTimeSchema } from "../schemas/common.ts";

function authOf(ctx: OpContext): { authorization: string; fingerprint: string } {
  return { authorization: ctx.actor.authorization, fingerprint: ctx.actor.fingerprint };
}

/** Notification object type by `kind`. */
function notificationType(kind: "event" | "share"): string {
  return kind === "share" ? "ShareNotification" : "CalendarEventNotification";
}

// --- notify.list --------------------------------------------------------------------------------

const NotifyListShape = {
  kind: z.enum(["event", "share"]).default("event").describe(
    "event: CalendarEventNotification (invites, reschedules, cancellations). share: ShareNotification.",
  ),
  after: UtcDateTimeSchema.optional().describe(
    "Only notifications created at/after this UTCDateTime.",
  ),
  before: UtcDateTimeSchema.optional().describe(
    "Only notifications created before this UTCDateTime.",
  ),
  type: z.string().optional().describe(
    "Filter by notification type (e.g. created|updated|destroyed).",
  ),
  calendar_event_ids: z.array(z.string().min(1)).optional().describe(
    "Restrict to notifications about these calendar event ids.",
  ),
  account_id: AccountIdSchema,
  limit: LimitSchema,
  calculate_total: z.boolean().default(false).describe("Opt-in query total."),
};

/** Build the CalendarEventNotification/query FilterCondition from typed args. */
function buildNotifFilter(args: {
  after?: string;
  before?: string;
  type?: string;
  calendar_event_ids?: string[];
}): Record<string, unknown> | undefined {
  const conds: Record<string, unknown>[] = [];
  if (args.after) conds.push({ after: args.after });
  if (args.before) conds.push({ before: args.before });
  if (args.type) conds.push({ type: args.type });
  if (args.calendar_event_ids && args.calendar_event_ids.length > 0) {
    conds.push({ calendarEventIds: args.calendar_event_ids });
  }
  if (conds.length === 0) return undefined;
  if (conds.length === 1) return conds[0];
  return { operator: "AND", conditions: conds };
}

const notifyList = defineOp({
  name: "notify.list",
  mcpName: "list_notifications",
  description:
    "List Letterdog calendar/share notifications (incoming invites, reschedules, cancellations, " +
    "share grants). Typed filter: after/before on the `created` time (UTCDateTime), type, and " +
    "specific calendar_event_ids. Each item includes the eventPatch so you can see what changed. " +
    "Follow up with dismiss_notifications once handled. CLI-only.",
  input: NotifyListShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "notification",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const type = notificationType(args.kind);
    const acct = await ctx.jmap.resolveAccount(
      authOf(ctx),
      CAPABILITIES.calendars,
      args.account_id,
    );

    const queryArgs: Record<string, unknown> = { accountId: acct.accountId, limit: args.limit };
    const filter = buildNotifFilter(args);
    if (filter) queryArgs.filter = filter;
    if (args.calculate_total) queryArgs.calculateTotal = true;

    const result = await ctx.jmap.request(authOf(ctx), [...USING.calendars], [
      [`${type}/query`, queryArgs, "q"],
      [`${type}/get`, {
        accountId: acct.accountId,
        "#ids": ref("q", `${type}/query`, "/ids"),
      }, "g"],
    ]);
    const queryRes = result.methodResponses.find((r) => r[2] === "q");
    const getRes = result.methodResponses.find((r) => r[2] === "g");
    if (!getRes || getRes[0] === "error") {
      // Surface an actionable message rather than a raw method error the CLI can't interpret.
      const detail = getRes && getRes[0] === "error" ? JSON.stringify(getRes[1]) : "no response";
      throw new Error(`${type}/get failed: ${detail}`);
    }
    // Notifications pass through untouched (projection "notification" = passthrough).
    const env = envelopeFromGet(getRes[1]);
    const envelope: Envelope<unknown> = { items: env.items };
    if (queryRes && queryRes[0] !== "error" && typeof queryRes[1].total === "number") {
      envelope.total = queryRes[1].total as number;
    }
    if (env.state) envelope.state = env.state;
    return envelope;
  },
});

// --- notify.dismiss -----------------------------------------------------------------------------

const NotifyDismissShape = {
  ids: z.array(z.string().min(1)).min(1).max(500).describe(
    "Notification ids to dismiss (destroy).",
  ),
  kind: z.enum(["event", "share"]).default("event").describe(
    "Which notification type these ids are.",
  ),
  account_id: AccountIdSchema,
};

const notifyDismiss = defineOp({
  name: "notify.dismiss",
  mcpName: "dismiss_notifications",
  description:
    "Dismiss (permanently remove) calendar/share notifications by id — the follow-up to " +
    "list_notifications once you have acted on them. Destroy-only; per-id failures are surfaced " +
    "in `failed`, never thrown. Dismissing does NOT decline an invite — use respond_to_event for " +
    "that. CLI-only.",
  input: NotifyDismissShape,
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "none",
  projection: "notification",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const type = notificationType(args.kind);
    const acct = await ctx.jmap.resolveAccount(
      authOf(ctx),
      CAPABILITIES.calendars,
      args.account_id,
    );
    const res = await ctx.jmap.setChunked(authOf(ctx), [...USING.calendars], `${type}/set`, {
      accountId: acct.accountId,
      destroy: args.ids,
    });
    const outcome = setOutcome(res);
    const envelope: Envelope<unknown> = {
      items: outcome.destroyed.map((id) => ({ id, dismissed: true })),
    };
    if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
    if (outcome.new_state) envelope.state = outcome.new_state;
    return envelope;
  },
});

// --- alert.ack ----------------------------------------------------------------------------------

const AlertAckShape = {
  event_id: z.string().min(1).describe("The BASE CalendarEvent id whose alert to acknowledge."),
  alert_id: z.string().min(1).describe("The alert id (map key within the event's `alerts`)."),
  acknowledged_at: UtcDateTimeSchema.optional().describe(
    "UTCDateTime to record as the acknowledgement time; defaults to now.",
  ),
  account_id: AccountIdSchema,
};

/** ISO UTCDateTime for `now`, RFC 8984 canonical (no trailing-zero fractions). */
function nowUtc(): string {
  return new Date().toISOString().replace(/\.000Z$/, "Z");
}

const alertAck = defineOp({
  name: "alert.ack",
  mcpName: "ack_alert",
  description:
    "Acknowledge a calendar event alert (mark a reminder as seen) by setting its `acknowledged` " +
    "timestamp on the BASE event via a JSON-Pointer patch. Never creates a recurrenceOverride — " +
    "acknowledging one occurrence's reminder does not fork the series. CLI-only.",
  input: AlertAckShape,
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(
      authOf(ctx),
      CAPABILITIES.calendars,
      args.account_id,
    );
    const when = args.acknowledged_at ?? nowUtc();
    const res = await ctx.jmap.call(authOf(ctx), [...USING.calendars], "CalendarEvent/set", {
      accountId: acct.accountId,
      update: {
        [args.event_id]: {
          [`alerts/${args.alert_id}/acknowledged`]: when,
        },
      },
    });
    const outcome = setOutcome(res);
    if (outcome.failed[args.event_id]) {
      const envelope: Envelope<unknown> = {
        items: [],
        failed: { [args.event_id]: outcome.failed[args.event_id] },
      };
      return envelope;
    }
    return { items: [{ event_id: args.event_id, alert_id: args.alert_id, acknowledged: when }] };
  },
});

// --- alert.snooze -------------------------------------------------------------------------------

const AlertSnoozeShape = {
  event_id: z.string().min(1).describe("The BASE CalendarEvent id whose alert to snooze."),
  alert_id: z.string().min(1).describe("The alert id to snooze (acknowledged + re-armed)."),
  until: UtcDateTimeSchema.describe("Absolute UTCDateTime to re-fire the reminder at."),
  snooze_alert_id: z.string().optional().describe(
    "Id for the new snooze alert (default: <alert_id>-snooze).",
  ),
  account_id: AccountIdSchema,
};

const alertSnooze = defineOp({
  name: "alert.snooze",
  mcpName: "snooze_alert",
  description:
    "Snooze a calendar event alert: acknowledge the original reminder and add a new alert with an " +
    "AbsoluteTrigger at `until`, linked back to the original via relatedTo (relation " +
    '"snooze"). Operates on the BASE event only (no recurrenceOverride). CLI-only.',
  input: AlertSnoozeShape,
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(
      authOf(ctx),
      CAPABILITIES.calendars,
      args.account_id,
    );
    const snoozeId = args.snooze_alert_id ?? `${args.alert_id}-snooze`;
    const when = nowUtc();
    // Patch: acknowledge the original alert, then add the snooze alert as a sibling with an
    // AbsoluteTrigger and a relatedTo back-reference to the original (RFC 8984 §4.5.2/§1.4.9).
    const res = await ctx.jmap.call(authOf(ctx), [...USING.calendars], "CalendarEvent/set", {
      accountId: acct.accountId,
      update: {
        [args.event_id]: {
          [`alerts/${args.alert_id}/acknowledged`]: when,
          [`alerts/${snoozeId}`]: {
            "@type": "Alert",
            trigger: { "@type": "AbsoluteTrigger", when: args.until },
            action: "display",
            relatedTo: { [args.alert_id]: { "@type": "Relation", relation: { snooze: true } } },
          },
        },
      },
    });
    const outcome = setOutcome(res);
    if (outcome.failed[args.event_id]) {
      const envelope: Envelope<unknown> = {
        items: [],
        failed: { [args.event_id]: outcome.failed[args.event_id] },
      };
      return envelope;
    }
    return {
      items: [{
        event_id: args.event_id,
        acknowledged_alert_id: args.alert_id,
        snooze_alert_id: snoozeId,
        until: args.until,
      }],
    };
  },
});

export const ops: OpDefinition[] = [notifyList, notifyDismiss, alertAck, alertSnooze];
