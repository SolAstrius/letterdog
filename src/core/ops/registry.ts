/**
 * Letterdog v2 operation registry — the single source of truth for BOTH frontends.
 * REAL implementation (architect-owned; builders do not edit — request contract changes via the
 * coordinator).
 *
 * Every capability is one OpDefinition created with defineOp() and pushed into the global
 * registry by src/core/ops/index.ts. The MCP frontend registers ops whose `surfaces` include
 * "mcp" under their `mcpName`; the CLI exposes ALL ops under their dotted `name`
 * (`mail.search` → `letterdog mail search`). See docs/v2-design.md "Operation registry" and
 * docs/v2-contracts.md for the full op inventory and per-module ownership.
 *
 * Conventions (enforced by review, not code):
 * - `name` is dotted, 2 segments, snake_case per segment ("mail.search", "event.rsvp").
 * - `mcpName` is verb-first snake_case ("search_emails"); required even for CLI-only ops
 *   (used as a stable alias); uniqueness is enforced across the whole registry.
 * - `input` is a Zod raw shape with snake_case argument names. Spec camelCase appears only
 *   INSIDE JMAP/JSCalendar payload objects (e.g. a typed event body), never as tool args.
 * - Handlers return plain JSON-able values; the frontends apply projections/compact printing.
 * - Batch-first: id-taking reads and uniform mutations take `ids: string[]`.
 */
import type { z } from "zod";
import type { CalDavClient } from "../../caldav.ts";
import type { ConfirmPolicy, V2Config } from "../config.ts";
import type { JmapClient } from "../jmap/client.ts";
import type { Provider } from "../provider/types.ts";

/** Which frontend(s) expose an op. The CLI exposes everything; "mcp" marks the curated set. */
export type Surface = "mcp" | "cli";

/**
 * Static confirmation class of an op — its MAXIMUM gate. The effective gate for a given call is
 * computed by core/safety.ts effectiveGate() from (confirmClass, args, CONFIRM_POLICY): e.g.
 * mail.delete is "destructive" but a non-permanent trash move gates as "none"; mail.send is
 * "outward" but ≤3 explicit recipients under the balanced policy runs direct.
 *
 * - none:        reversible / low blast — never two-phase (labels, marks, moves incl. trash,
 *                archive, drafts, holds, alerts, dismissals, subscriptions).
 * - outward:     sends messages to other humans (send/reply/forward, invitations, cancel
 *                notices, RSVP replies) — two-phase under "strict"; conditional under
 *                "balanced"; direct under "minimal".
 * - destructive: irreversible destruction (permanent email destroy, calendar delete with
 *                events, mailbox delete with mail) — two-phase under every policy.
 * - blast:       high blast radius (share ACL changes, x:* admin, raw JMAP mutations,
 *                query-powered bulk >100 items) — two-phase under every policy.
 */
export type ConfirmClass = "none" | "outward" | "destructive" | "blast";

/** Which projector in core/projections.ts applies to the op's items ("none" = pass through). */
export type ProjectionKey =
  | "email"
  | "thread"
  | "mailbox"
  | "event"
  | "calendar"
  | "contact"
  | "person"
  | "busy"
  | "identity"
  | "notification"
  | "blob"
  | "session"
  | "raw"
  | "none";

/** Mapped to MCP ToolAnnotations (readOnlyHint/destructiveHint/idempotentHint) and CLI gating. */
export interface OpAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
}

/**
 * The authenticated caller. Built per-request by the MCP frontend (Authorization header,
 * forwarded verbatim to Stalwart) or once per process by the CLI (STALWART_BEARER / --url /
 * --account flags). `fingerprint` is an HMAC over the credential (see v1 src/auth.ts
 * tokenFingerprint) and binds confirm tokens to the actor. NEVER log `authorization`/`bearer`.
 */
export interface Actor {
  /** Full Authorization header value, e.g. "Bearer xyz" or "Basic xyz". */
  authorization: string;
  /** Bearer token when authorization is a Bearer header. */
  bearer?: string;
  source: "http" | "env" | "flag";
  /** HMAC-derived actor fingerprint (24 base64url chars). Safe to log/embed in tokens. */
  fingerprint: string;
  requestId?: string;
}

/** Everything a handler may touch. Constructed by the frontends (mcp/server.ts, cli/main.ts). */
export interface OpContext {
  config: V2Config;
  actor: Actor;
  /** v2 typed JMAP client (session cache, envelopes, chunking). */
  jmap: JmapClient;
  /** Reused v1 CalDAV client (src/caldav.ts) — raw iCalendar fidelity escape hatch. */
  caldav: CalDavClient;
  /** Provider adapter (Stalwart hybrid-shape normalizers, quirks, x:* extensions). */
  provider: Provider;
  /** = config.confirmPolicy, hoisted for handler/safety ergonomics. */
  policy: ConfirmPolicy;
}

/** Parsed argument type for a Zod raw shape. */
export type OpArgs<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export interface OpDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Dotted op name; also the CLI command path ("mail.search" → `letterdog mail search`). */
  name: string;
  /** Verb-first MCP tool name ("search_emails"). Unique across the registry. */
  mcpName: string;
  /**
   * Agent-facing description: when to use, the trap it avoids, the follow-up tool. Doubles as
   * CLI --help text. Lead with what Letterdog is fronting (the user's personal self-hosted
   * mail/calendar/contacts) where routing ambiguity exists.
   */
  description: string;
  /** Zod raw shape; becomes the MCP inputSchema and the derived CLI flags. */
  input: Shape;
  annotations: OpAnnotations;
  confirmClass: ConfirmClass;
  projection: ProjectionKey;
  surfaces: Surface[];
  /**
   * The single implementation shared by both frontends. Must return a JSON-able value —
   * normally an Envelope (core/jmap/envelopes.ts) of projected items, or a ConfirmChallenge
   * when the effective gate is two-phase. Throw Error for hard failures; surface per-item
   * failures via the envelope's `failed` map instead of throwing.
   */
  handler(args: OpArgs<Shape>, ctx: OpContext): Promise<unknown>;
}

/** Identity helper that pins the arg/shape inference and widens to the registry item type. */
export function defineOp<Shape extends z.ZodRawShape>(op: OpDefinition<Shape>): OpDefinition {
  return op as unknown as OpDefinition;
}

const registry: OpDefinition[] = [];

const DOTTED_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const MCP_NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Add ops to the global registry. Called exactly once per op module by src/core/ops/index.ts.
 * Throws on: malformed names, duplicate dotted names, duplicate mcpNames, empty surfaces.
 */
export function registerOps(ops: OpDefinition[]): void {
  for (const op of ops) {
    if (!DOTTED_NAME_RE.test(op.name)) {
      throw new Error(`Op name "${op.name}" must be dotted snake_case (e.g. "mail.search").`);
    }
    if (!MCP_NAME_RE.test(op.mcpName)) {
      throw new Error(`Op "${op.name}" mcpName "${op.mcpName}" must be snake_case.`);
    }
    if (op.surfaces.length === 0) {
      throw new Error(`Op "${op.name}" must declare at least one surface.`);
    }
    if (registry.some((existing) => existing.name === op.name)) {
      throw new Error(`Duplicate op name "${op.name}".`);
    }
    if (registry.some((existing) => existing.mcpName === op.mcpName)) {
      throw new Error(`Duplicate op mcpName "${op.mcpName}" (op "${op.name}").`);
    }
    registry.push(op);
  }
}

/** Snapshot of every registered op, registration order preserved. */
export function registeredOps(): OpDefinition[] {
  return [...registry];
}

export function opsForSurface(surface: Surface): OpDefinition[] {
  return registry.filter((op) => op.surfaces.includes(surface));
}

export function opByName(name: string): OpDefinition | undefined {
  return registry.find((op) => op.name === name);
}

export function opByMcpName(mcpName: string): OpDefinition | undefined {
  return registry.find((op) => op.mcpName === mcpName);
}
