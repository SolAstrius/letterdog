/**
 * raw CalDAV ops — builder ops:aux (B10-ops-misc). CLI-only surfaces.
 *
 * Wraps the reused v1 CalDavClient (src/caldav.ts) on ctx.caldav — the raw-iCalendar-fidelity
 * escape hatch (import/export, ETag-guarded writes). JMAP is the primary surface; drop here for
 * byte-exact iCalendar.
 *
 * Ops (docs/v2-contracts.md §ops inventory):
 * - dav.discover → dav_discover   [cli]  none         readOnly  projection: raw
 * - dav.list     → dav_list       [cli]  none         readOnly  projection: raw
 *     collections (calendar homes) or objects within a collection (calendar_path).
 * - dav.get      → dav_get        [cli]  none         readOnly  projection: raw
 *     raw iCalendar body + ETag; optional save-to-path (file_path, CLI).
 * - dav.put      → dav_put        [cli]  blast        (two-phase every policy)  projection: raw
 *     If-Match ETag REQUIRED unless creating (if_none_match_star). Raw body from file or arg.
 * - dav.delete   → dav_delete     [cli]  destructive  (two-phase every policy)  projection: raw
 *     If-Match ETag REQUIRED.
 *
 * Path rules ported from v1 src/caldav.ts urlForPath(): server-relative (leading "/"), no "..".
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { effectiveGate, mintConfirmToken, verifyConfirmToken } from "../safety.ts";
import type { ConfirmChallenge, ConfirmIntent } from "../safety.ts";
import { ConfirmTokenSchema } from "../schemas/common.ts";

/** Validate a CalDAV path the same way v1 CalDavClient.urlForPath does, up front. */
function assertDavPath(path: string): string {
  if (!path.startsWith("/")) throw new Error("CalDAV paths must be server-relative (leading '/').");
  if (path.includes("..")) throw new Error("CalDAV path must not contain '..'.");
  return path;
}

/**
 * Build a two-phase ConfirmChallenge for a gated CalDAV write, or verify a supplied token.
 * Returns a ConfirmChallenge to send back (phase 1) or undefined once verified (proceed).
 * Throws on token mismatch/expiry with the actionable diff from verifyConfirmToken.
 */
async function gateWrite(
  ctx: OpContext,
  op: string,
  resourceIds: string[],
  payload: unknown,
  summary: string,
  confirmToken: string | undefined,
): Promise<ConfirmChallenge | undefined> {
  const confirmClass = op === "dav.delete" ? "destructive" : "blast";
  const gate = effectiveGate({ confirmClass, policy: ctx.policy });
  if (gate === "direct") return undefined;

  const intent: ConfirmIntent = {
    op,
    account_id: "caldav",
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
      }. Re-run the dry phase to get a fresh token.`,
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

// --- dav.discover -------------------------------------------------------------------------------

const DavDiscoverShape = {};

const davDiscover = defineOp({
  name: "dav.discover",
  mcpName: "dav_discover",
  description:
    "Discover the CalDAV principal, calendar homes, and advertised DAV features (via cdav-library). " +
    "The starting point for raw CalDAV work; use the returned calendar-home / collection urls with " +
    "dav_list and dav_get. CLI-only.",
  input: DavDiscoverShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(_args, ctx) {
    const result = await ctx.caldav.discover();
    const envelope: Envelope<unknown> = { items: [result] };
    return envelope;
  },
});

// --- dav.list -----------------------------------------------------------------------------------

const DavListShape = {
  calendar_path: z.string().optional().describe(
    "Collection path to list objects within; omit to list calendar collections (homes).",
  ),
  home_path: z.string().optional().describe(
    "When listing collections, restrict to this calendar-home path.",
  ),
  component: z.string().optional().describe(
    "When listing objects, filter by component (e.g. VEVENT).",
  ),
  utc_start: z.string().optional().describe(
    "Time-range lower bound (UTCDateTime) for object listing.",
  ),
  utc_end: z.string().optional().describe(
    "Time-range upper bound (UTCDateTime) for object listing.",
  ),
};

const davList = defineOp({
  name: "dav.list",
  mcpName: "dav_list",
  description:
    "List CalDAV calendar collections, or the objects inside one collection (calendar_path). With " +
    "utc_start/utc_end, runs a time-bounded calendar-query. Read-only. CLI-only.",
  input: DavListShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    let result: Record<string, unknown>;
    if (args.calendar_path) {
      assertDavPath(args.calendar_path);
      result = (args.utc_start || args.utc_end || args.component)
        ? await ctx.caldav.queryCalendarObjects(args.calendar_path, {
          component: args.component,
          start: args.utc_start,
          end: args.utc_end,
        })
        : await ctx.caldav.listCalendarObjects(args.calendar_path);
    } else {
      if (args.home_path) assertDavPath(args.home_path);
      result = await ctx.caldav.listCalendarCollections(args.home_path);
    }
    const envelope: Envelope<unknown> = { items: [result] };
    return envelope;
  },
});

// --- dav.get ------------------------------------------------------------------------------------

const DavGetShape = {
  href: z.string().min(1).describe(
    "Server-relative href of the CalDAV resource (leading '/', no '..').",
  ),
  file_path: z.string().optional().describe("CLI-only: write the raw iCalendar body to this path."),
};

const davGet = defineOp({
  name: "dav.get",
  mcpName: "dav_get",
  description:
    "Read the raw iCalendar text and ETag for one CalDAV resource by href. Capture the ETag to pass " +
    "as if_match on a later dav_put/dav_delete. CLI: file_path saves the body to disk. Read-only.",
  input: DavGetShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    assertDavPath(args.href);
    const result = await ctx.caldav.get(args.href);
    if (args.file_path) {
      await Deno.writeTextFile(args.file_path, result.body);
      const envelope: Envelope<unknown> = {
        items: [{
          href: args.href,
          etag: result.etag,
          content_type: result.contentType,
          file_path: args.file_path,
          size: result.body.length,
        }],
      };
      return envelope;
    }
    const envelope: Envelope<unknown> = { items: [result] };
    return envelope;
  },
});

// --- dav.put ------------------------------------------------------------------------------------

const DavPutShape = {
  href: z.string().min(1).describe(
    "Server-relative href to create or replace (leading '/', no '..').",
  ),
  icalendar: z.string().optional().describe("Raw iCalendar body (or supply body_file on the CLI)."),
  body_file: z.string().optional().describe(
    "CLI-only: read the iCalendar body from this file path.",
  ),
  content_type: z.string().default("text/calendar; charset=utf-8").describe("PUT Content-Type."),
  if_match: z.string().optional().describe(
    "ETag guard (If-Match) — REQUIRED when replacing an existing resource; omit only with " +
      "if_none_match_star to create.",
  ),
  if_none_match_star: z.boolean().default(false).describe(
    "Send If-None-Match: * to create a new resource (fails if it already exists).",
  ),
  confirm_token: ConfirmTokenSchema,
};

const davPut = defineOp({
  name: "dav.put",
  mcpName: "dav_put",
  description:
    "Create or replace a raw CalDAV iCalendar resource with PUT (byte-exact fidelity). Guard against " +
    "lost updates: pass if_match with the ETag from dav_get when replacing, or if_none_match_star to " +
    "create. High blast radius — two-phase confirm (re-run with confirm_token from the dry phase). " +
    "CLI-only.",
  input: DavPutShape,
  annotations: { readOnly: false, idempotent: false, destructive: true },
  confirmClass: "blast",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    assertDavPath(args.href);
    let body = args.icalendar;
    if (body === undefined && args.body_file) body = await Deno.readTextFile(args.body_file);
    if (body === undefined) throw new Error("Provide icalendar or body_file for dav_put.");
    if (!args.if_match && !args.if_none_match_star) {
      throw new Error(
        "dav_put requires if_match (ETag) to replace, or if_none_match_star:true to create.",
      );
    }

    const challenge = await gateWrite(
      ctx,
      "dav.put",
      [args.href],
      {
        href: args.href,
        content_type: args.content_type,
        if_match: args.if_match ?? null,
        if_none_match_star: args.if_none_match_star,
        body_hash_len: body.length,
      },
      `PUT raw iCalendar resource ${args.href}`,
      args.confirm_token,
    );
    if (challenge) return challenge;

    const result = await ctx.caldav.put(args.href, body, {
      contentType: args.content_type,
      ifMatch: args.if_match,
      ifNoneMatch: args.if_none_match_star ? "*" : undefined,
    });
    const envelope: Envelope<unknown> = {
      items: [{
        href: args.href,
        status: result.status,
        etag: result.etag,
        location: result.location,
      }],
    };
    return envelope;
  },
});

// --- dav.delete ---------------------------------------------------------------------------------

const DavDeleteShape = {
  href: z.string().min(1).describe("Server-relative href to delete (leading '/', no '..')."),
  if_match: z.string().optional().describe(
    "ETag guard (If-Match) — REQUIRED to avoid deleting a resource that changed since you read it.",
  ),
  confirm_token: ConfirmTokenSchema,
};

const davDelete = defineOp({
  name: "dav.delete",
  mcpName: "dav_delete",
  description:
    "Delete a raw CalDAV resource by href. ETag-guarded: pass if_match from dav_get so a concurrent " +
    "change aborts the delete. Irreversible — two-phase confirm (re-run with confirm_token from the " +
    "dry phase). CLI-only.",
  input: DavDeleteShape,
  annotations: { readOnly: false, destructive: true, idempotent: true },
  confirmClass: "destructive",
  projection: "raw",
  surfaces: ["cli"],
  async handler(args, ctx) {
    assertDavPath(args.href);
    if (!args.if_match) {
      throw new Error("dav_delete requires if_match (ETag) to guard against a concurrent change.");
    }
    const challenge = await gateWrite(
      ctx,
      "dav.delete",
      [args.href],
      { href: args.href, if_match: args.if_match },
      `Delete raw iCalendar resource ${args.href}`,
      args.confirm_token,
    );
    if (challenge) return challenge;

    const result = await ctx.caldav.delete(args.href, args.if_match);
    const envelope: Envelope<unknown> = {
      items: [{ href: args.href, status: result.status, deleted: true }],
    };
    return envelope;
  },
});

export const ops: OpDefinition[] = [davDiscover, davList, davGet, davPut, davDelete];
