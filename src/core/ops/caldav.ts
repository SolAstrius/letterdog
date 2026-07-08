/**
 * raw CalDAV ops — TODO(builder: B10-ops-misc)
 *
 * Wraps the reused v1 CalDavClient (src/caldav.ts) available on ctx.caldav. CalDAV is the
 * raw-iCalendar-fidelity escape hatch (import/export); JMAP is the primary surface.
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - dav.discover → dav_discover        [cli]  none  readOnly  projection: raw
 * - dav.list → dav_list                [cli]  none  readOnly  projection: raw
 *   collections or objects within a collection.
 * - dav.get → dav_get                  [cli]  none  readOnly  projection: raw
 *   raw iCalendar body + ETag; optional save-to-path.
 * - dav.put → dav_put                  [cli]  blast  projection: raw
 *   ETag-guarded (If-Match); raw body from file or arg.
 * - dav.delete → dav_delete            [cli]  destructive  projection: raw
 *   ETag-guarded.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
