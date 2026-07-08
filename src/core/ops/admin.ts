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
 * - sieve.delete          → delete_sieve_script     [cli]  destructive (two-phase)  projection: raw
 * - sieve.validate        → validate_sieve_script   [cli]  none   readOnly  projection: raw
 *
 * Sieve uses the standard urn:ietf:params:jmap:sieve SieveScript/* methods per RFC 9661, with
 * live-probed Stalwart deviations honored throughout (docs/rfc-notes/rfc9661-jmap-sieve.md §6):
 * error types come back as invalidScript/scriptIsActive (spec: invalidSieve/sieveIsActive — match
 * BOTH), (de)activation succeeds silently without an `updated` report or state bump, and
 * Blob/upload is not a back-reference source (script bodies go through the HTTP upload endpoint
 * in a separate request). Admin settings are Stalwart-specific: the provider's
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

/** Two-phase gate for gated admin/sieve writes (blast unless overridden); undefined = proceed. */
async function gateBlast(
  ctx: OpContext,
  op: string,
  accountId: string,
  resourceIds: string[],
  payload: unknown,
  summary: string,
  confirmToken: string | undefined,
  confirmClass: "destructive" | "blast" = "blast",
): Promise<ConfirmChallenge | undefined> {
  const gate = effectiveGate({ confirmClass, policy: ctx.policy });
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
  id: z.string().min(1).optional().describe(
    "SieveScript id to activate (onSuccessActivateScript). Omit and set deactivate instead to " +
      "turn filtering off.",
  ),
  deactivate: z.boolean().optional().describe(
    "true = deactivate the currently active script (onSuccessDeactivateScript). Mutually " +
      "exclusive with id.",
  ),
  account_id: AccountIdSchema,
  confirm_token: ConfirmTokenSchema,
};

const sieveActivate = defineOp({
  name: "sieve.activate",
  mcpName: "activate_sieve_script",
  description: "Activate a Sieve script by id (SieveScript/set onSuccessActivateScript), or pass " +
    "deactivate:true instead to turn filtering off (onSuccessDeactivateScript — RFC 9661 ignores " +
    "invalid activate ids, so null/'null' would silently do nothing). Changes which filter runs " +
    "on all incoming mail — blast, two-phase confirm. Note: Stalwart (de)activates silently (no " +
    "updated report), so the op re-reads isActive to confirm. Requires ENABLE_ADMIN_TOOLS. " +
    "CLI-only.",
  input: SieveActivateShape,
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "blast",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    if ((args.id === undefined) === !args.deactivate) {
      throw new Error("Provide exactly one of `id` (activate) or `deactivate: true`.");
    }
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const challenge = await gateBlast(
      ctx,
      "sieve.activate",
      acct.accountId,
      [args.id ?? "none"],
      { activate: args.id ?? null },
      args.id ? `Activate Sieve script ${args.id}` : "Deactivate all Sieve filtering",
      args.confirm_token,
    );
    if (challenge) return challenge;

    // RFC 9661 §2.4: an invalid/nonexistent onSuccessActivateScript id MUST be ignored, so
    // null does NOT deactivate — deactivation has its own arg.
    const setArgs: Record<string, unknown> = { accountId: acct.accountId };
    if (args.id !== undefined) setArgs.onSuccessActivateScript = args.id;
    else setArgs.onSuccessDeactivateScript = true;
    const res = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/set", setArgs);

    // Stalwart flips isActive without reporting it (no `updated`, no state bump) — re-read for a
    // faithful confirmation instead of echoing the opaque set response.
    const getRes = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/get", {
      accountId: acct.accountId,
      ids: null,
      properties: ["id", "name", "isActive"],
    });
    const scripts = Array.isArray(getRes.list) ? getRes.list : [];
    const envelope: Envelope<unknown> = {
      items: [{ activated: args.id ?? null, scripts, response: res }],
    };
    return envelope;
  },
});

// --- sieve.delete -------------------------------------------------------------------------------

const SieveDeleteShape = {
  ids: z.array(z.string().min(1)).min(1).max(100).describe("SieveScript ids to destroy."),
  deactivate_first: z.boolean().optional().describe(
    "If a target script is active, deactivate it (separate SieveScript/set call, per RFC 9661) " +
      "and retry the destroy. Without this, destroying the active script fails.",
  ),
  account_id: AccountIdSchema,
  confirm_token: ConfirmTokenSchema,
};

/** Both spellings: RFC 9661 registers sieveIsActive; Stalwart emits scriptIsActive. */
function isActiveDestroyError(err: unknown): boolean {
  const t = (err as { type?: string } | undefined)?.type;
  return t === "sieveIsActive" || t === "scriptIsActive";
}

const sieveDelete = defineOp({
  name: "sieve.delete",
  mcpName: "delete_sieve_script",
  description:
    "Destroy Sieve script(s) by id. The active script cannot be destroyed (sieveIsActive / " +
    "Stalwart: scriptIsActive) unless deactivate_first is set, which first disables filtering in " +
    "a separate SieveScript/set call per RFC 9661, then retries. Destructive — two-phase confirm " +
    "(re-run with confirm_token). Requires ENABLE_ADMIN_TOOLS. CLI-only.",
  input: SieveDeleteShape,
  annotations: { readOnly: false, destructive: true, idempotent: true },
  confirmClass: "destructive",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const challenge = await gateBlast(
      ctx,
      "sieve.delete",
      acct.accountId,
      args.ids,
      { destroy: args.ids, deactivate_first: !!args.deactivate_first },
      `Destroy ${args.ids.length} Sieve script(s)`,
      args.confirm_token,
      "destructive",
    );
    if (challenge) return challenge;

    const res = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/set", {
      accountId: acct.accountId,
      destroy: args.ids,
    });
    const outcome = setOutcome(res);
    const destroyed = [...outcome.destroyed];
    const failed = { ...outcome.failed };

    // Retry ids that failed only because they were active: deactivate (own /set call — the spec
    // forbids destroying the active script in the same call), then destroy again.
    const activeFailures = Object.entries(failed)
      .filter(([, err]) => isActiveDestroyError(err))
      .map(([id]) => id);
    if (args.deactivate_first && activeFailures.length > 0) {
      await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/set", {
        accountId: acct.accountId,
        onSuccessDeactivateScript: true,
      });
      const retry = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/set", {
        accountId: acct.accountId,
        destroy: activeFailures,
      });
      const retryOutcome = setOutcome(retry);
      for (const id of activeFailures) delete failed[id];
      Object.assign(failed, retryOutcome.failed);
      destroyed.push(...retryOutcome.destroyed);
    }

    const envelope: Envelope<unknown> = { items: [{ destroyed }] };
    if (Object.keys(failed).length > 0) envelope.failed = failed;
    return envelope;
  },
});

// --- sieve.validate -----------------------------------------------------------------------------

const SieveValidateShape = {
  script: z.string().optional().describe("Sieve script source (or supply body_file on the CLI)."),
  body_file: z.string().optional().describe("CLI-only: read the Sieve source from this file path."),
  account_id: AccountIdSchema,
};

const sieveValidate = defineOp({
  name: "sieve.validate",
  mcpName: "validate_sieve_script",
  description:
    "Check Sieve source validity server-side WITHOUT storing a script (SieveScript/validate ≈ " +
    "ManageSieve CHECKSCRIPT). Grammar-only on Stalwart: unsupported `require` extensions pass " +
    "validation, so a clean result does not guarantee the script will run. Uploads the source as " +
    "a blob first (Blob/upload is not a same-request back-reference source on Stalwart). " +
    "Requires ENABLE_ADMIN_TOOLS. CLI-only.",
  input: SieveValidateShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    let source = args.script;
    if (source === undefined && args.body_file) source = await Deno.readTextFile(args.body_file);
    if (source === undefined) {
      throw new Error("Provide script or body_file for validate_sieve_script.");
    }

    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.sieve, args.account_id);
    const uploaded = await ctx.jmap.uploadBlob(
      authOf(ctx),
      acct.accountId,
      new TextEncoder().encode(source),
      "application/sieve",
    );
    const res = await ctx.jmap.call(authOf(ctx), SIEVE_USING, "SieveScript/validate", {
      accountId: acct.accountId,
      blobId: uploaded.blobId,
    });
    const error = (res as { error?: unknown }).error ?? null;
    const envelope: Envelope<unknown> = { items: [{ valid: error === null, error }] };
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
  sieveDelete,
  sieveValidate,
  ...providerExtensionOps(),
];
