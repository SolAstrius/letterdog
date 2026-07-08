/**
 * admin + sieve ops — TODO(builder: B10-ops-misc)
 *
 * Registered ONLY when config.enableAdminTools is true (the frontends filter; see
 * docs/v2-contracts.md §gating). Stalwart-specific x:* methods belong to the provider adapter's
 * `extensions` — this module wires them into ops.
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - admin.settings_get → get_admin_settings       [cli]  none  readOnly  projection: raw
 * - admin.settings_update → update_admin_settings [cli]  blast            projection: raw
 * - sieve.list → list_sieve_scripts               [cli]  none  readOnly  projection: raw
 * - sieve.get → get_sieve_script                  [cli]  none  readOnly  projection: raw
 * - sieve.put → put_sieve_script                  [cli]  blast            projection: raw
 * - sieve.activate → activate_sieve_script        [cli]  blast            projection: raw
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
