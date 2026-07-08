/**
 * session ops — TODO(builder: B10-ops-misc)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - session.whoami → whoami            [mcp, cli]  none  readOnly  projection: session
 *   Session, accounts, capabilities + limits, mail identities, participant identities,
 *   default calendar. One JMAP request batching Identity/get + ParticipantIdentity/get +
 *   Calendar/get alongside the cached session object.
 * - identity.list → list_identities    [cli]       none  readOnly  projection: identity
 *   Mail Identity/get (ids: null) + ParticipantIdentity/get (ids: null).
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
