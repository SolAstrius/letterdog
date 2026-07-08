/**
 * raw JMAP escape hatch — TODO(builder: B10-ops-misc)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - raw.jmap → jmap_call               [mcp, cli]  blast  projection: raw
 *   Read-only unless allow_mutation:true (classification via method-name pattern — reuse the
 *   READ_ONLY_METHOD_RE idea from v1 src/constants.ts); mutations gate as "blast" (two-phase
 *   under every policy; CLI --confirm). Description documents `using` capability defaulting and
 *   the `#`/`*` result-reference syntax (rfc-notes 8620 §1.3). This is the MCP-side bridge to
 *   everything the CLI covers.
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
