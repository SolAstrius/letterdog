/**
 * calendar + event ops — TODO(builder: B9-ops-calendar)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - calendar.list → list_calendars           [mcp, cli]  none  readOnly  projection: calendar
 *   Calendar/get ids:null; note freeBusy-only shares are invisible (rfc-notes calendars §13.10).
 * - event.search → search_events             [mcp, cli]  none  readOnly  projection: event
 *   typed draft-26 filter (in_calendar SINGULAR; after vs event END, before vs event START,
 *   LocalDateTime in time_zone arg); expand:true REQUIRES both bounds (schema superRefine) and
 *   returns synthetic per-instance ids + utcStart/utcEnd.
 * - event.read → read_events                 [mcp, cli]  none  readOnly  projection: event
 *   ids array (base OR synthetic instance ids); recurrence_overrides_before/after,
 *   reduce_participants, time_zone. Never request utcStart/utcEnd + recurrenceOverrides together.
 * - event.create → create_events             [mcp, cli]  outward  projection: event
 *   TypedEvent (server-set fields excluded); send_invitations default false — description warns
 *   both directions; is_draft. Confirms only when inviting.
 * - event.update → update_event              [mcp, cli]  outward  projection: event
 *   base OR synthetic instance id (= "just this occurrence"); typed patch or raw PatchObject
 *   with pointer rules stated; send_updates. NO updateScope/destroyScope — they do not exist.
 * - event.delete → delete_events             [mcp, cli]  destructive  projection: event
 *   base or instance ids (instance = exclude occurrence); send_cancellations.
 * - event.rsvp → respond_to_event            [mcp, cli]  outward  projection: event
 *   own-participant match via ParticipantIdentity calendarAddress (hybrid-tolerant, use
 *   provider.normalize); occurrence_id for per-instance; notify_organizer default true.
 * - calendar.availability → get_availability [mcp, cli]  none  readOnly  projection: busy
 *   addresses or principal ids; utc_start/utc_end (both required), show_details; normalized
 *   BusyPeriods; document confirmed > unavailable > tentative precedence.
 * - calendar.create → create_calendar        [cli]  none
 * - calendar.update → update_calendar        [cli]  none   (rename, color, default alerts;
 *   isDefault only via onSuccessSetIsDefault — silent no-op on failure, re-read to verify)
 * - calendar.delete → delete_calendar        [cli]  destructive  (onDestroyRemoveEvents)
 * - calendar.share → share_calendar          [cli]  blast  (shareWith ACL changes)
 * - calendar.identity_set → set_participant_identity [cli]  none
 *   ParticipantIdentity create/update + onSuccessSetIsDefault.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
