/**
 * sync primitive ops — TODO(builder: B10-ops-misc)
 *
 * Registered ONLY when config.enableSyncTools is true (the frontends filter). These are the
 * demoted /changes // /queryChanges primitives — CLI territory for local mirrors and scripts.
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - sync.changes → sync_changes            [cli]  none  readOnly  projection: raw
 *   Foo/changes for a given `type` (Email|Mailbox|Thread|CalendarEvent|Calendar|ContactCard|…)
 *   with since_state, max_changes; surfaces cannotCalculateChanges as a typed error telling the
 *   caller to full-resync.
 * - sync.query_changes → sync_query_changes [cli]  none  readOnly  projection: raw
 *   Foo/queryChanges with filter/sort/since_query_state/up_to_id.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
