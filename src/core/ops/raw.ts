/**
 * raw JMAP escape hatch — builder ops:aux (B10-ops-misc).
 *
 * Op (docs/v2-contracts.md §ops inventory):
 * - raw.jmap → jmap_call   [mcp, cli]  blast  projection: raw
 *     Send an arbitrary JMAP request (one or more method calls). Read-only unless
 *     allow_mutation:true — method classification via safety.isReadOnlyJmapMethod(). Any mutating
 *     method gates as "blast" (two-phase under every policy; CLI --confirm). Documents the
 *     `using` capability defaulting and the `#`-back-reference / `*` pointer syntax. This is the
 *     MCP-side bridge to everything the CLI wraps.
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import { CAPABILITIES } from "../jmap/session.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import {
  effectiveGate,
  isReadOnlyJmapMethod,
  mintConfirmToken,
  verifyConfirmToken,
} from "../safety.ts";
import type { ConfirmChallenge, ConfirmIntent } from "../safety.ts";
import { ConfirmTokenSchema } from "../schemas/common.ts";

function authOf(ctx: OpContext): { authorization: string; fingerprint: string } {
  return { authorization: ctx.actor.authorization, fingerprint: ctx.actor.fingerprint };
}

/** A single JMAP method call triple [method, args, callId]; callId defaults to "c<index>". */
const MethodCallSchema = z.union([
  z.tuple([z.string().min(1), z.record(z.string(), z.unknown()), z.string().min(1)]),
  z.tuple([z.string().min(1), z.record(z.string(), z.unknown())]),
]);

const RawJmapShape = {
  method_calls: z.array(MethodCallSchema).min(1).max(32).describe(
    "JMAP methodCalls: [method, args, callId?] triples. Chain steps with `#`-back-references " +
      '(e.g. {"#ids": {"resultOf":"c0","name":"Email/query","path":"/ids"}}) and a ' +
      "trailing `/*` path to map over an array. accountId is required in each method's args.",
  ),
  using: z.array(z.string().min(1)).optional().describe(
    "Capability URNs for the request. Defaults to core+mail+calendars+contacts+submission+blob so " +
      "most calls work without specifying it; pass your own to narrow or add (e.g. sieve).",
  ),
  allow_mutation: z.boolean().default(false).describe(
    "Gate: false (default) REJECTS any non-read-only method (anything not /get,/query,/changes," +
      "/queryChanges,/parse,/lookup, Core/echo, Principal/getAvailability). true permits mutations, " +
      "which then require two-phase confirmation.",
  ),
  confirm_token: ConfirmTokenSchema,
};

/** Default capability set — broad enough that most read/write calls resolve without a `using` arg. */
const DEFAULT_USING = [
  CAPABILITIES.core,
  CAPABILITIES.mail,
  CAPABILITIES.submission,
  CAPABILITIES.calendars,
  CAPABILITIES.contacts,
  CAPABILITIES.blob,
];

/** Normalize [method, args] / [method, args, id] into full [method, args, id] triples. */
function normalizeCalls(
  calls: (
    | readonly [string, Record<string, unknown>]
    | readonly [
      string,
      Record<string, unknown>,
      string,
    ]
  )[],
): [string, Record<string, unknown>, string][] {
  return calls.map((call, i) => {
    const id = call.length === 3 ? call[2] : `c${i}`;
    return [call[0], call[1], id];
  });
}

const rawJmap = defineOp({
  name: "raw.jmap",
  mcpName: "jmap_call",
  description:
    "Escape hatch: run an arbitrary JMAP request against Letterdog when no curated tool fits. " +
    "method_calls is an array of [method, args, callId?] triples; chain them with `#`-back-references " +
    '({"#ids": {resultOf, name, path}}) and a `/*` path suffix to map over arrays. Read-only by ' +
    "default (only /get,/query,/changes,/queryChanges,/parse,/lookup + Core/echo + " +
    "Principal/getAvailability are allowed); set allow_mutation:true to run /set and other mutating " +
    "methods, which then require two-phase confirmation (re-run with confirm_token). Prefer the " +
    "typed tools (search_emails, create_events, …) when they exist.",
  input: RawJmapShape,
  annotations: { readOnly: false, idempotent: false, destructive: true },
  confirmClass: "blast",
  projection: "raw",
  surfaces: ["mcp", "cli"],
  async handler(args, ctx) {
    const calls = normalizeCalls(args.method_calls as never);
    const using = args.using && args.using.length > 0 ? args.using : DEFAULT_USING;

    // Classify: any method that is not read-only is a mutation.
    const mutatingMethods = calls
      .map((c) => c[0])
      .filter((m) => !isReadOnlyJmapMethod(m));

    if (mutatingMethods.length > 0 && !args.allow_mutation) {
      throw new Error(
        `Refusing mutating method(s) ${mutatingMethods.join(", ")} without allow_mutation:true. ` +
          `raw.jmap is read-only by default.`,
      );
    }

    // Mutations gate as blast (two-phase under every policy).
    if (mutatingMethods.length > 0) {
      const gate = effectiveGate({ confirmClass: "blast", policy: ctx.policy });
      if (gate === "two_phase") {
        const intent: ConfirmIntent = {
          op: "raw.jmap",
          account_id: "*",
          resource_ids: [...mutatingMethods].sort(),
          payload: { calls, using },
          actor_fingerprint: ctx.actor.fingerprint,
        };
        if (!args.confirm_token) {
          const token = await mintConfirmToken(ctx.config.confirmationSecret, intent);
          const challenge: ConfirmChallenge = {
            confirmation_required: true,
            summary: `Run ${mutatingMethods.length} mutating JMAP method(s): ${
              mutatingMethods.join(", ")
            }`,
            preview: { method_calls: calls, using },
            confirm_token: token,
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          };
          return challenge;
        }
        const verdict = await verifyConfirmToken(
          ctx.config.confirmationSecret,
          args.confirm_token,
          intent,
        );
        if (!verdict.ok) {
          throw new Error(
            `confirm_token ${verdict.reason ?? "invalid"}${
              verdict.diff ? `: ${JSON.stringify(verdict.diff)}` : ""
            }. Re-run without confirm_token to get a fresh one.`,
          );
        }
      }
    }

    const result = await ctx.jmap.request(authOf(ctx), using, calls);
    // Pass the raw methodResponses straight through — this IS the raw escape hatch.
    const envelope: Envelope<unknown> = {
      items: result.methodResponses,
    };
    if (result.sessionState) envelope.state = result.sessionState;
    return envelope;
  },
});

export const ops: OpDefinition[] = [rawJmap];
