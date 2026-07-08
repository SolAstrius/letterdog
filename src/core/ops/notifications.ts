/**
 * notification + alert ops — TODO(builder: B9-ops-calendar)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - notify.list → list_notifications   [cli]  none  readOnly  projection: notification
 *   CalendarEventNotification/query+get (+ ShareNotification via `kind` arg).
 * - notify.dismiss → dismiss_notifications [cli]  none  projection: notification
 *   destroy-only /set; ids array; per-item failures surfaced.
 * - alert.ack → ack_alert              [cli]  none
 *   set `acknowledged` on the BASE event's alert — never creates a recurrenceOverride
 *   (rfc-notes calendars §8).
 * - alert.snooze → snooze_alert        [cli]  none
 *   acknowledge + add AbsoluteTrigger alert with relatedTo parent relation.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
