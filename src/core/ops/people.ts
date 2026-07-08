/**
 * people ops (JSContact contacts + RFC 9670 principals) — TODO(builder: B10-ops-misc)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - people.search → search_people      [mcp, cli]  none  readOnly  projection: person
 *   ONE search over JSContact cards (urn:ietf:params:jmap:contacts) AND principals
 *   (Principal/query); returns names, emails, calendarAddress, principal type. This is where
 *   "invite Daria" / "mail Ivan" resolves.
 * - contact.read → read_contacts       [mcp, cli]  none  readOnly  projection: contact
 *   full JSContact cards by ids array.
 * - contact.search → search_contacts   [cli]       none  readOnly  projection: contact
 *   pure ContactCard/query (no principals), typed filter.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
