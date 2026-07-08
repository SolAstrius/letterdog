/**
 * admin + sieve ops — builder ops:aux (B10-ops-misc). CLI-only, and registered ONLY when
 * config.enableAdminTools is true (the frontends filter by the `admin.` / `sieve.` name prefix).
 *
 * Ops (docs/v2-contracts.md §ops inventory):
 * - admin.settings_get    → get_admin_settings     [cli]  none   readOnly  projection: raw
 * - admin.settings_update → update_admin_settings  [cli]  blast  (two-phase)  projection: raw
 * - sieve.list            → list_sieve_scripts      [cli]  none   readOnly  projection: raw
 * - sieve.get             → get_sieve_script        [cli]  none   readOnly  projection: raw
 * - sieve.put             → put_sieve_script        [cli]  blast  (two-phase)  projection: raw
 * - sieve.activate        → activate_sieve_script   [cli]  blast  (two-phase)  projection: raw
 *
 * Sieve uses the standard urn:ietf:params:jmap:sieve SieveScript/* methods (live-probed:
 * SieveScript/get works on account "b"). Admin settings are Stalwart-specific: the provider's
 * `extensions` list (provider/stalwart.ts) is the canonical source, but it currently ships none,
 * so these ops call the Stalwart management methods directly through raw JMAP, gated as blast.
 * They stay defensive/passthrough: the method name is overridable so a provider that names its
 * settings methods differently still works.
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import { CAPABILITIES } from "../jmap/session.ts";
import { envelopeFromGet, setOutcome } from "../jmap/envelopes.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { effectiveGate, mintConfirmToken, verifyConfirmToken } from "../safety.ts";
import type { ConfirmChallenge, ConfirmIntent } from "../safety.ts";
import { AccountIdSchema, ConfirmTokenSchema } from "../schemas/common.ts";

function authOf(ctx: OpContext): { authorization: string; fingerprint: string } {
  return { authorization: ctx.actor.authorization, fingerprint: ctx.actor.fingerprint };
}

const SIEVE_USING = [CAPABILITIES.core, CAPABILITIES.sieve];
const ADMIN_USING = [CAPABILITIES.core, CAPABILITIES.stalwart];

/** Two-phase gate for blast-class admin/sieve writes; undefined = proceed. */
async function gateBlast(
  ctx: OpContext,
  op: string,
  accountId: string,
  resourceIds: string[],
  payload: unknown,
  summary: string,
  confirmToken: string | undefined,
): Promise<ConfirmChallenge | undefined> {
  const gate = effectiveGate({ confirmClass: "blast", policy: ctx.policy });
  if (gate === "direct") return undefined;
  const intent: ConfirmIntent = {
    op,
    account_id: accountId,
    resource_ids: [...resourceIds].sort(),
    payload,
    actor_fingerprint: ctx.actor.fingerprint,
  };
  if (confirmToken) {
    const verdict = await verifyConfirmToken(ctx.config.confirmationSecret, confirmToken, intent);
    if (verdict.ok) return undefined;
    throw new Error(
      `confirm_token ${verdict.reason ?? "invalid"}${
        verdict.diff ? `: ${JSON.stringify(verdict.diff)}` : ""
      }. Re-run the dry phase for a fresh token.`,
    );
  }
  const token = await mintConfirmToken(ctx.config.confirmationSecret, intent);
  return {
    confirmation_required: true,
    summary,
    preview: { op, resources: resourceIds, payload },
    confirm_token: token,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

// --- admin.settings_get -------------------------------------------------------------------------

const AdminSettingsGetShape = {
  prefix: z.string().optional().describe(
    'Settings key prefix to fetch (e.g. "server.", "session."); omit for the full set.',
  ),
  keys: z.array(z.string().min(1)).optional().describe("Specific setting keys to fetch."),
  method: z.string().default("Settings/get").describe(
    "Override the JMAP method name if the provider names its settings getter differently.",
  ),
  account_id: AccountIdSchema,
};

const adminSettingsGet = defineOp({
  name: "admin.settings_get",
  mcpName: "get_admin_settings",
  description:
    "Read Stalwart server settings (admin surface). Fetch a key prefix or specific keys. Requires " +
    "ENABLE_ADMIN_TOOLS and an admin-capable credential. Read-only. CLI-only.",
  input: AdminSettingsGetShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), undefined, args.account_id);
    const methodArgs: Record<string, unknown> = { accountId: acct.accountId };
    if (args.prefix) methodArgs.prefix = args.prefix;
    if (args.keys) methodArgs.keys = args.keys;
    const res = await ctx.jmap.call(authOf(ctx), ADMIN_USING, args.method, methodArgs);
    const envelope: Envelope<unknown> = { items: [res] };
    return envelope;
  },
});

// --- admin.settings_update ----------------------------------------------------------------------

const AdminSettingsUpdateShape = {
  set: z.record(z.string(), z.unknown()).optional().describe("Key → value settings to set."),
  unset: z.array(z.string().min(1)).optional().describe("Setting keys to remove."),
  method: z.string().default("Settings/set").describe(
    "Override the JMAP method name if the provider names its settings setter differently.",
  ),
  account_id: AccountIdSchema,
  confirm_token: ConfirmTokenSchema,
};

const adminSettingsUpdate = defineOp({
  name: "admin.settings_update",
  mcpName: "update_admin_settings",
  description:
    "Change Stalwart server settings (admin surface) — set and/or unset keys. Server-wide blast " +
    "radius: two-phase confirm (re-run with confirm_token from the dry phase). Requires " +
    "ENABLE_ADMIN_TOOLS and an admin credential. CLI-only.",
  input: AdminSettingsUpdateShape,
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "blast",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    if (!args.set && !args.unset) throw new Error("Provide set and/or unset for settings update.");
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), undefined, args.account_id);
    const resourceIds = [
      ...Object.keys(args.set ?? {}),
      ...(args.unset ?? []),
    ];
    const challenge = await gateBlast(
      ctx,
      "admin.settings_update",
      acct.accountId,
      resourceIds,
      { set: args.set ?? null, unset: args.unset ?? null },
      `Update ${resourceIds.length} server setting(s)`,
      args.confirm_token,
    );
    if (challenge) return challenge;

    const methodArgs: Record<string, unknown> = { accountId: acct.accountId };
    if (args.set) methodArgs.update = args.set;
    if (args.unset) methodArgs.unset = args.unset;
    const res = await ctx.jmap.call(authOf(ctx), ADMIN_USING, args.method, methodArgs);
    const envelope: Envelope<unknown> = { items: [res] };
    return envelope;
  },
});

// --- sieve.list ---------------------------------------------------------------------------------

const SieveListShape = {
  account_id: AccountIdSchema,
};

const sieveList = defineOp({
  name: "sieve.list",
  mcpName: "list_sieve_scripts",
  description: "List all Sieve filter scripts (name, id, isActive) via SieveScript/get. Requires " +
    "ENABLE_ADMIN_TOOLS. Read-only. CLI-only.",
  input: SieveListShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const res = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/get", {
      accountId: acct.accountId,
      ids: null,
      properties: ["id", "name", "isActive"],
    });
    const env = envelopeFromGet(res);
    const envelope: Envelope<unknown> = { items: env.items };
    if (env.state) envelope.state = env.state;
    return envelope;
  },
});

// --- sieve.get ----------------------------------------------------------------------------------

const SieveGetShape = {
  ids: z.array(z.string().min(1)).min(1).max(100).describe("SieveScript ids to fetch (with body)."),
  account_id: AccountIdSchema,
};

const sieveGet = defineOp({
  name: "sieve.get",
  mcpName: "get_sieve_script",
  description:
    "Fetch full Sieve script(s) by id, including the script body/blob. Requires ENABLE_ADMIN_TOOLS. " +
    "Read-only. CLI-only.",
  input: SieveGetShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const res = await ctx.jmap.getChunked(authOf(ctx), SIEVE_USING, "SieveScript/get", {
      accountId: acct.accountId,
      ids: args.ids,
    });
    const env = envelopeFromGet(res);
    const envelope: Envelope<unknown> = { items: env.items };
    if (env.not_found) envelope.not_found = env.not_found;
    if (env.state) envelope.state = env.state;
    return envelope;
  },
});

// --- sieve.put ----------------------------------------------------------------------------------

const SievePutShape = {
  name: z.string().min(1).describe("Script name (unique per account)."),
  script: z.string().optional().describe("Sieve script source (or supply body_file on the CLI)."),
  body_file: z.string().optional().describe("CLI-only: read the Sieve source from this file path."),
  id: z.string().optional().describe(
    "Existing SieveScript id to replace; omit to create a new one.",
  ),
  account_id: AccountIdSchema,
  confirm_token: ConfirmTokenSchema,
};

const sievePut = defineOp({
  name: "sieve.put",
  mcpName: "put_sieve_script",
  description:
    "Create or replace a Sieve filter script (uploads the source as a blob, then SieveScript/set). " +
    "Filters affect all incoming mail — blast radius, two-phase confirm (re-run with confirm_token). " +
    "Requires ENABLE_ADMIN_TOOLS. CLI-only.",
  input: SievePutShape,
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "blast",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    let source = args.script;
    if (source === undefined && args.body_file) source = await Deno.readTextFile(args.body_file);
    if (source === undefined) throw new Error("Provide script or body_file for put_sieve_script.");

    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const challenge = await gateBlast(
      ctx,
      "sieve.put",
      acct.accountId,
      [args.id ?? args.name],
      { name: args.name, id: args.id ?? null, source_len: source.length },
      `${args.id ? "Replace" : "Create"} Sieve script "${args.name}"`,
      args.confirm_token,
    );
    if (challenge) return challenge;

    // Upload the script body as a blob, then reference it by blobId in SieveScript/set.
    const uploaded = await ctx.jmap.uploadBlob(
      authOf(ctx),
      acct.accountId,
      new TextEncoder().encode(source),
      "application/sieve",
    );
    const record = { name: args.name, blobId: uploaded.blobId };
    const setArgs: Record<string, unknown> = { accountId: acct.accountId };
    if (args.id) setArgs.update = { [args.id]: record };
    else setArgs.create = { new: record };
    const res = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/set", setArgs);
    const outcome = setOutcome(res);
    const created = Object.values(outcome.created)[0] as Record<string, unknown> | undefined;
    const envelope: Envelope<unknown> = {
      items: [created ?? { id: args.id, name: args.name }],
    };
    if (Object.keys(outcome.failed).length > 0) envelope.failed = outcome.failed;
    return envelope;
  },
});

// --- sieve.activate -----------------------------------------------------------------------------

const SieveActivateShape = {
  id: z.string().nullable().describe(
    "SieveScript id to activate, or null to deactivate all (onSuccessActivateScript).",
  ),
  account_id: AccountIdSchema,
  confirm_token: ConfirmTokenSchema,
};

const sieveActivate = defineOp({
  name: "sieve.activate",
  mcpName: "activate_sieve_script",
  description:
    "Activate a Sieve script (or pass id:null to deactivate filtering) via SieveScript/set " +
    "onSuccessActivateScript. Changes which filter runs on all incoming mail — blast, two-phase " +
    "confirm. Requires ENABLE_ADMIN_TOOLS. CLI-only.",
  input: SieveActivateShape,
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "blast",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const challenge = await gateBlast(
      ctx,
      "sieve.activate",
      acct.accountId,
      [args.id ?? "none"],
      { activate: args.id },
      args.id ? `Activate Sieve script ${args.id}` : "Deactivate all Sieve filtering",
      args.confirm_token,
    );
    if (challenge) return challenge;

    const res = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/set", {
      accountId: acct.accountId,
      onSuccessActivateScript: args.id,
    });
    const envelope: Envelope<unknown> = { items: [{ activated: args.id, response: res }] };
    return envelope;
  },
});

/** Provider-sourced admin extensions (Stalwart x:* ops), appended to the built-in admin set. */
function providerExtensionOps(): OpDefinition[] {
  // provider/stalwart.ts ships an empty extensions list today; when it supplies concrete x:* op
  // definitions they merge here. Deduplicate by dotted name so a provider override wins.
  return [];
}

export const ops: OpDefinition[] = [
  adminSettingsGet,
  adminSettingsUpdate,
  sieveList,
  sieveGet,
  sievePut,
  sieveActivate,
  ...providerExtensionOps(),
];
