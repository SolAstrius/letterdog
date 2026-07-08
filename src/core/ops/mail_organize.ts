/**
 * mail organize/destroy + mailbox ops — builder ops:mail-organize (file B8-shared).
 *
 * Ops implemented (normative inventory: docs/v2-contracts.md §Op inventory, rows mail_organize):
 * - mail.organize   → organize_emails  [mcp, cli]  none         projection: email
 *     ONE tool: add_labels/remove_labels (mailbox names/ids/roles), add_keywords/remove_keywords,
 *     sugar mark (read|unread|flagged|unflagged|junk|not_junk|answered|forwarded) and
 *     move_to (archive|trash|inbox|<mailbox_id>). Explicit ids only (never query-powered).
 *     Trash moves and mailbox removals are reversible ⇒ direct under every policy (class none).
 * - mail.delete     → delete_emails    [mcp, cli]  destructive  projection: email
 *     trash by default (effective gate collapses to "none"); permanent:true destroys the Emails
 *     via Email/set destroy (two-phase under every policy).
 * - mailbox.list    → list_mailboxes   [cli]       none         projection: mailbox
 * - mailbox.create  → create_mailbox   [cli]       none         projection: mailbox
 * - mailbox.rename  → rename_mailbox   [cli]       none         projection: mailbox
 *     also reparent (parent_id) and sortOrder.
 * - mailbox.delete  → delete_mailbox   [cli]       destructive  projection: mailbox
 *     remove_emails:true ⇒ onDestroyRemoveEmails (destructive branch); otherwise mailboxHasEmail /
 *     mailboxHasChild SetErrors surface in `failed`.
 *
 * Reconciliation note (see coordinator): the spawn prompt mentioned mail.bulk_label /
 * mail.label_create / mail.import / mail.export in this file. The normative inventory table does
 * NOT list those under mail_organize — import/export are mail_read (B7) ops, and there are no
 * bulk_label/label_create rows anywhere. Implementing them here would break registry uniqueness
 * and the curated MCP surface count, so this module ships exactly the six inventory rows above.
 *
 * Handler recipe (per docs/v2-contracts.md §core/ops): validate invariants → resolve account
 * (mail cap) → build Email/set or Mailbox/set → normalize via setOutcome → re-read affected items
 * for a projected envelope. Batch-first: ids arrays; per-item failures surface in `failed`, never
 * thrown.
 */
import { z } from "zod";
import { defineOp, type OpArgs, type OpContext, type OpDefinition } from "./registry.ts";
import { USING } from "../jmap/session.ts";
import type { JmapAuth } from "../jmap/client.ts";
import type { AccountRef } from "../jmap/client.ts";
import { type Envelope, type SetError, type SetOutcome, setOutcome } from "../jmap/envelopes.ts";
import { type Mailbox, mailboxRoleMap } from "../jmap/types.ts";
import {
  AccountIdSchema,
  FieldsSchema,
  IdsSchema,
  JmapIdSchema,
  LimitSchema,
  ProjectionSchema,
} from "../schemas/common.ts";
import { KeywordSchema, MarkSchema, MoveToSchema } from "../schemas/mail.ts";
import {
  type BriefMailbox,
  project,
  type ProjectionContext,
  type ProjectionMode,
} from "../projections.ts";
import { effectiveGate } from "../safety.ts";
import type { Actor } from "./registry.ts";
import { type ConfirmChallenge, mintConfirmToken, verifyConfirmToken } from "../safety.ts";
import type { Email } from "../jmap/types.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Roles that `move_to` / label sugar may name directly (folder-like destinations). */
const MOVE_ROLE_ALIASES: Record<string, string> = {
  archive: "archive",
  trash: "trash",
  inbox: "inbox",
  junk: "junk",
  sent: "sent",
  drafts: "drafts",
};

/** Fetch every Mailbox (ids:null) once — used to resolve names/roles → ids and to project. */
async function loadMailboxes(
  auth: JmapAuth,
  accountId: string,
  ctx: OpContext,
): Promise<Mailbox[]> {
  const res = await ctx.jmap.call(auth, [...USING.mail], "Mailbox/get", {
    accountId,
    ids: null,
  });
  const list = Array.isArray(res.list) ? (res.list as Mailbox[]) : [];
  return list;
}

/**
 * Resolve a mailbox designator (id | role | name) to a mailbox id using an already-loaded map.
 * Preference order: exact id match > role match > case-insensitive name match. Returns undefined
 * when nothing resolves (the caller surfaces that as a per-request error).
 */
function resolveMailboxId(
  designator: string,
  mailboxes: Mailbox[],
  roleMap: Record<string, string>,
): string | undefined {
  // Direct id hit.
  if (mailboxes.some((mb) => mb.id === designator)) return designator;
  // Role alias / role name.
  const roleKey = MOVE_ROLE_ALIASES[designator.toLowerCase()] ?? designator.toLowerCase();
  if (roleMap[roleKey]) return roleMap[roleKey];
  // Case-insensitive name.
  const byName = mailboxes.find((mb) => mb.name.toLowerCase() === designator.toLowerCase());
  return byName?.id;
}

/** Build a ProjectionContext.mailboxes map (id → {name, role}) from a mailbox list. */
function mailboxCtxMap(mailboxes: Mailbox[]): ProjectionContext["mailboxes"] {
  const map = new Map<string, { name: string; role?: string | null }>();
  for (const mb of mailboxes) map.set(mb.id, { name: mb.name, role: mb.role ?? null });
  return map;
}

/**
 * Re-read the emails affected by a mutation and return a projected Envelope. `succeeded` are the
 * ids the /set actually changed; `failed` carries per-item SetErrors. Never throws on per-item
 * problems. When there are no successes we skip the Email/get round-trip entirely.
 */
async function projectedEmailEnvelope(
  auth: JmapAuth,
  account: AccountRef,
  ctx: OpContext,
  succeeded: string[],
  failed: Record<string, SetError>,
  mailboxes: Mailbox[],
  mode: ProjectionMode,
  fields: string[] | undefined,
  state?: string,
): Promise<Envelope<unknown>> {
  const pctx: ProjectionContext = { mailboxes: mailboxCtxMap(mailboxes), fields };
  let items: unknown[] = [];
  if (succeeded.length > 0) {
    const got = await ctx.jmap.getChunked(auth, [...USING.mail], "Email/get", {
      accountId: account.accountId,
      ids: succeeded,
    });
    const list = Array.isArray(got.list) ? (got.list as Email[]) : [];
    items = list.map((e) => project("email", e, mode, pctx));
  }
  const env: Envelope<unknown> = { items };
  if (Object.keys(failed).length > 0) env.failed = failed;
  if (state) env.state = state;
  return env;
}

/** Coerce a registry Actor slice into the JmapAuth the client wants. */
function authOf(ctx: OpContext): JmapAuth {
  return ctx.actor as unknown as JmapAuth & Actor;
}

// ---------------------------------------------------------------------------
// mark sugar → keyword patch fragments
// ---------------------------------------------------------------------------

/**
 * Translate the `mark` enum into Email/set patch fragments (per-entry keyword patches). junk sets
 * `$junk` and clears `$notjunk` (and vice versa) so the two never contradict each other.
 */
function markPatch(mark: z.infer<typeof MarkSchema>): Record<string, unknown> {
  switch (mark) {
    case "read":
      return { "keywords/$seen": true };
    case "unread":
      return { "keywords/$seen": null };
    case "flagged":
      return { "keywords/$flagged": true };
    case "unflagged":
      return { "keywords/$flagged": null };
    case "junk":
      return { "keywords/$junk": true, "keywords/$notjunk": null };
    case "not_junk":
      return { "keywords/$notjunk": true, "keywords/$junk": null };
  }
}

// ---------------------------------------------------------------------------
// mail.organize
// ---------------------------------------------------------------------------

const OrganizeInput = {
  ids: IdsSchema.describe("Explicit Email ids to act on (never query-powered)."),
  add_labels: z.array(z.string().min(1)).optional().describe(
    "Mailbox labels to ADD (mailbox name, id, or role). Additive — does not remove existing.",
  ),
  remove_labels: z.array(z.string().min(1)).optional().describe(
    "Mailbox labels to REMOVE (name/id/role). An email must stay in ≥1 mailbox.",
  ),
  add_keywords: z.array(KeywordSchema).optional().describe(
    "Keywords/flags to set (e.g. a custom label or $flagged).",
  ),
  remove_keywords: z.array(KeywordSchema).optional().describe("Keywords/flags to clear."),
  mark: MarkSchema.optional().describe(
    "Sugar: read|unread|flagged|unflagged|junk|not_junk. For $answered/$forwarded use " +
      "add_keywords.",
  ),
  move_to: MoveToSchema.optional().describe(
    "Move to a single mailbox (archive|trash|inbox|<mailbox_id>). Replaces current mailboxes " +
      "unless keep_in_current is true. Trash is reversible — that's what Trash is for.",
  ),
  keep_in_current: z.boolean().optional().describe(
    "When move_to is set, ADD the destination instead of replacing current mailboxes.",
  ),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

type OrganizeArgs = OpArgs<typeof OrganizeInput>;

/**
 * Build the per-email Email/set patch shared across all ids (uniform mutation). Returns the patch
 * object and a boolean marking whether mailbox membership is being REPLACED (move_to without
 * keep_in_current) — replacement needs per-email knowledge of which mailboxes to drop, so the
 * caller computes that separately.
 */
function buildOrganizePatchBase(
  args: OrganizeArgs,
  mailboxes: Mailbox[],
  roleMap: Record<string, string>,
): { patch: Record<string, unknown>; unresolved: string[]; moveTargetId?: string } {
  const patch: Record<string, unknown> = {};
  const unresolved: string[] = [];

  for (const label of args.add_labels ?? []) {
    const id = resolveMailboxId(label, mailboxes, roleMap);
    if (!id) unresolved.push(label);
    else patch[`mailboxIds/${id}`] = true;
  }
  for (const label of args.remove_labels ?? []) {
    const id = resolveMailboxId(label, mailboxes, roleMap);
    if (!id) unresolved.push(label);
    else patch[`mailboxIds/${id}`] = null;
  }
  for (const kw of args.add_keywords ?? []) patch[`keywords/${kw}`] = true;
  for (const kw of args.remove_keywords ?? []) patch[`keywords/${kw}`] = null;
  if (args.mark) Object.assign(patch, markPatch(args.mark));

  let moveTargetId: string | undefined;
  if (args.move_to !== undefined) {
    const id = resolveMailboxId(args.move_to, mailboxes, roleMap);
    if (!id) unresolved.push(args.move_to);
    else {
      moveTargetId = id;
      if (args.keep_in_current) {
        patch[`mailboxIds/${id}`] = true;
      }
      // Replacement (keep_in_current false) is applied per-email in the handler because it must
      // drop whichever mailboxes each email currently sits in.
    }
  }
  return { patch, unresolved, moveTargetId };
}

const organizeOp = defineOp({
  name: "mail.organize",
  mcpName: "organize_emails",
  description:
    "Organize emails in the user's personal mailbox (Letterdog / self-hosted JMAP): add/remove " +
    "mailbox labels, add/remove keywords, and sugar for mark (read/unread/flagged/unflagged/" +
    "junk/not_junk) and move_to (archive/trash/inbox/<mailbox_id>). One tool " +
    "for all of it. Takes explicit ids (accumulate them from search_emails first) — never a " +
    "query. move_to REPLACES the current mailboxes unless keep_in_current is set; add/remove " +
    "labels are additive. Moving to Trash is reversible and needs no confirmation. To permanently " +
    "delete, use delete_emails with permanent:true.",
  input: OrganizeInput,
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "none",
  projection: "email",
  surfaces: ["mcp", "cli"],
  async handler(rawArgs, ctx) {
    const args = rawArgs as OrganizeArgs;
    const noop = !args.add_labels && !args.remove_labels && !args.add_keywords &&
      !args.remove_keywords && args.mark === undefined && args.move_to === undefined;
    if (noop) {
      throw new Error(
        "organize_emails: specify at least one of add_labels, remove_labels, add_keywords, " +
          "remove_keywords, mark, or move_to.",
      );
    }
    const auth = authOf(ctx);
    const account = await ctx.jmap.resolveAccount(
      auth,
      "urn:ietf:params:jmap:mail",
      args.account_id,
    );
    const mailboxes = await loadMailboxes(auth, account.accountId, ctx);
    const roleMap = mailboxRoleMap(mailboxes);

    const { patch, unresolved, moveTargetId } = buildOrganizePatchBase(args, mailboxes, roleMap);
    if (unresolved.length > 0) {
      throw new Error(
        `organize_emails: could not resolve mailbox label(s): ${unresolved.join(", ")}. ` +
          "Use a role (inbox/archive/trash/junk/sent/drafts), an exact mailbox name, or an id " +
          "(list_mailboxes on the CLI).",
      );
    }

    const replacingMailboxes = moveTargetId !== undefined && !args.keep_in_current;

    // For a replacing move we need each email's current mailboxIds to drop them; fetch once.
    let currentById: Map<string, Record<string, boolean>> | undefined;
    if (replacingMailboxes) {
      const got = await ctx.jmap.getChunked(auth, [...USING.mail], "Email/get", {
        accountId: account.accountId,
        ids: args.ids,
        properties: ["id", "mailboxIds"],
      });
      currentById = new Map();
      const list = Array.isArray(got.list) ? (got.list as Email[]) : [];
      for (const e of list) currentById.set(e.id, e.mailboxIds ?? {});
    }

    const update: Record<string, Record<string, unknown>> = {};
    for (const id of args.ids) {
      const perEmail: Record<string, unknown> = { ...patch };
      if (replacingMailboxes && moveTargetId) {
        const current = currentById?.get(id) ?? {};
        for (const mbId of Object.keys(current)) {
          if (current[mbId] && mbId !== moveTargetId) perEmail[`mailboxIds/${mbId}`] = null;
        }
        perEmail[`mailboxIds/${moveTargetId}`] = true;
      }
      update[id] = perEmail;
    }

    const res = await ctx.jmap.setChunked(auth, [...USING.mail], "Email/set", {
      accountId: account.accountId,
      update,
    });
    const outcome = setOutcome(res);
    const succeeded = Object.keys(outcome.updated);
    return projectedEmailEnvelope(
      auth,
      account,
      ctx,
      succeeded,
      outcome.failed,
      mailboxes,
      args.projection as ProjectionMode,
      args.fields,
      outcome.new_state ?? undefined,
    );
  },
});

// ---------------------------------------------------------------------------
// mail.delete
// ---------------------------------------------------------------------------

const DeleteInput = {
  ids: IdsSchema.describe("Explicit Email ids to delete."),
  permanent: z.boolean().optional().describe(
    "false/omitted (default): move to Trash (reversible, no confirmation). true: DESTROY the " +
      "emails irrecoverably (two-phase confirmation under every policy).",
  ),
  account_id: AccountIdSchema,
  confirm_token: z.string().min(16).optional().describe(
    "Echo the confirm_token from the challenge to execute a permanent delete.",
  ),
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

type DeleteArgs = OpArgs<typeof DeleteInput>;

const deleteOp = defineOp({
  name: "mail.delete",
  mcpName: "delete_emails",
  description:
    "Delete emails from the user's personal mailbox (Letterdog / self-hosted JMAP). Default is a " +
    "reversible move to Trash (no confirmation — that's what Trash is for). Pass permanent:true to " +
    "DESTROY them irrecoverably; that requires two-phase confirmation (repeat the call with the " +
    "confirm_token from the challenge). Takes explicit ids only.",
  input: DeleteInput,
  annotations: { readOnly: false, destructive: true, idempotent: true },
  confirmClass: "destructive",
  projection: "email",
  surfaces: ["mcp", "cli"],
  async handler(rawArgs, ctx) {
    const args = rawArgs as DeleteArgs;
    const permanent = args.permanent === true;
    const auth = authOf(ctx);
    const account = await ctx.jmap.resolveAccount(
      auth,
      "urn:ietf:params:jmap:mail",
      args.account_id,
    );
    const mailboxes = await loadMailboxes(auth, account.accountId, ctx);

    // --- Trash branch: reversible move, gate collapses to none. ---
    if (!permanent) {
      const roleMap = mailboxRoleMap(mailboxes);
      const trashId = roleMap["trash"];
      if (!trashId) {
        throw new Error(
          "delete_emails: no Trash mailbox (role=trash) on this account; pass permanent:true to " +
            "destroy, or create a Trash mailbox first.",
        );
      }
      // Replace membership with the trash mailbox (mirrors organize move_to trash without keep).
      const got = await ctx.jmap.getChunked(auth, [...USING.mail], "Email/get", {
        accountId: account.accountId,
        ids: args.ids,
        properties: ["id", "mailboxIds"],
      });
      const currentById = new Map<string, Record<string, boolean>>();
      const list = Array.isArray(got.list) ? (got.list as Email[]) : [];
      for (const e of list) currentById.set(e.id, e.mailboxIds ?? {});

      const update: Record<string, Record<string, unknown>> = {};
      for (const id of args.ids) {
        const perEmail: Record<string, unknown> = {};
        const current = currentById.get(id) ?? {};
        for (const mbId of Object.keys(current)) {
          if (current[mbId] && mbId !== trashId) perEmail[`mailboxIds/${mbId}`] = null;
        }
        perEmail[`mailboxIds/${trashId}`] = true;
        update[id] = perEmail;
      }
      const res = await ctx.jmap.setChunked(auth, [...USING.mail], "Email/set", {
        accountId: account.accountId,
        update,
      });
      const outcome = setOutcome(res);
      return projectedEmailEnvelope(
        auth,
        account,
        ctx,
        Object.keys(outcome.updated),
        outcome.failed,
        mailboxes,
        args.projection as ProjectionMode,
        args.fields,
        outcome.new_state ?? undefined,
      );
    }

    // --- Permanent branch: two-phase confirmation, then Email/set destroy. ---
    const sortedIds = [...args.ids].sort();
    const intent = {
      op: "mail.delete",
      account_id: account.accountId,
      resource_ids: sortedIds,
      payload: { permanent: true },
      actor_fingerprint: auth.fingerprint,
    };
    const gate = effectiveGate({ confirmClass: "destructive", policy: ctx.policy });
    if (gate === "two_phase") {
      const verdict = args.confirm_token
        ? await verifyConfirmToken(ctx.config.confirmationSecret, args.confirm_token, intent)
        : { ok: false as const, reason: "malformed" as const };
      if (!verdict.ok) {
        return await mintChallenge(ctx, intent, args, mailboxes);
      }
    }

    const res = await ctx.jmap.setChunked(auth, [...USING.mail], "Email/set", {
      accountId: account.accountId,
      destroy: args.ids,
    });
    const outcome = setOutcome(res);
    const env: Envelope<unknown> = {
      items: outcome.destroyed.map((id) => ({ id, destroyed: true })),
    };
    if (Object.keys(outcome.failed).length > 0) env.failed = outcome.failed;
    if (outcome.new_state) env.state = outcome.new_state;
    return env;
  },
});

/** Mint a destructive-delete challenge with a brief-projected preview of the targeted emails. */
async function mintChallenge(
  ctx: OpContext,
  intent: {
    op: string;
    account_id: string;
    resource_ids: string[];
    payload: unknown;
    actor_fingerprint: string;
  },
  args: DeleteArgs,
  mailboxes: Mailbox[],
): Promise<ConfirmChallenge> {
  const auth = authOf(ctx);
  const got = await ctx.jmap.getChunked(auth, [...USING.mail], "Email/get", {
    accountId: intent.account_id,
    ids: args.ids,
    properties: ["id", "subject", "from", "receivedAt", "mailboxIds"],
  });
  const list = Array.isArray(got.list) ? (got.list as Email[]) : [];
  const pctx: ProjectionContext = { mailboxes: mailboxCtxMap(mailboxes) };
  const preview = list.map((e) => project("email", e, "brief", pctx));
  const token = await mintConfirmToken(ctx.config.confirmationSecret, intent);
  const expMs = Date.now() + 5 * 60 * 1000;
  return {
    confirmation_required: true,
    summary: `Permanently destroy ${args.ids.length} email(s). This cannot be undone.`,
    preview,
    confirm_token: token,
    expires_at: new Date(expMs).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// mailbox.list
// ---------------------------------------------------------------------------

const MailboxListInput = {
  ids: z.array(JmapIdSchema).optional().describe(
    "Restrict to these mailbox ids; omit to list every mailbox.",
  ),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
  limit: LimitSchema,
};

type MailboxListArgs = OpArgs<typeof MailboxListInput>;

function projectMailboxList(
  mailboxes: Mailbox[],
  mode: ProjectionMode,
  fields: string[] | undefined,
): (BriefMailbox | Record<string, unknown>)[] {
  const pctx: ProjectionContext = { mailboxes: mailboxCtxMap(mailboxes), fields };
  return mailboxes.map((mb) => project("mailbox", mb, mode, pctx) as BriefMailbox);
}

const mailboxListOp = defineOp({
  name: "mailbox.list",
  mcpName: "list_mailboxes",
  description:
    "List the mailboxes (folders/labels) of the user's personal JMAP account, with roles, parent " +
    "ids, and message counts. Use it to discover mailbox ids/roles before organize_emails or " +
    "mailbox management.",
  input: MailboxListInput,
  annotations: { readOnly: true, idempotent: true },
  confirmClass: "none",
  projection: "mailbox",
  surfaces: ["cli"],
  async handler(rawArgs, ctx) {
    const args = rawArgs as MailboxListArgs;
    const auth = authOf(ctx);
    const account = await ctx.jmap.resolveAccount(
      auth,
      "urn:ietf:params:jmap:mail",
      args.account_id,
    );
    let mailboxes = await loadMailboxes(auth, account.accountId, ctx);
    if (args.ids && args.ids.length > 0) {
      const wanted = new Set(args.ids);
      mailboxes = mailboxes.filter((mb) => wanted.has(mb.id));
    }
    const limited = mailboxes.slice(0, args.limit);
    const env: Envelope<unknown> = {
      items: projectMailboxList(limited, args.projection as ProjectionMode, args.fields),
      total: mailboxes.length,
    };
    return env;
  },
});

// ---------------------------------------------------------------------------
// mailbox.create
// ---------------------------------------------------------------------------

const MailboxCreateInput = {
  name: z.string().min(1).describe("Mailbox name (unique among its siblings)."),
  parent_id: JmapIdSchema.optional().describe("Parent mailbox id; omit for a top-level mailbox."),
  role: z.string().min(1).optional().describe(
    "Optional IANA role (inbox/archive/drafts/sent/trash/junk/all/flagged/important); at most " +
      "one mailbox per role per account.",
  ),
  sort_order: z.number().int().min(0).optional().describe("Sibling sort order (lower first)."),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

type MailboxCreateArgs = OpArgs<typeof MailboxCreateInput>;

const mailboxCreateOp = defineOp({
  name: "mailbox.create",
  mcpName: "create_mailbox",
  description:
    "Create a mailbox (folder/label) in the user's personal JMAP account. Optionally nest it " +
    "under parent_id and assign an IANA role. Returns the created mailbox (brief-projected).",
  input: MailboxCreateInput,
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "none",
  projection: "mailbox",
  surfaces: ["cli"],
  async handler(rawArgs, ctx) {
    const args = rawArgs as MailboxCreateArgs;
    const auth = authOf(ctx);
    const account = await ctx.jmap.resolveAccount(
      auth,
      "urn:ietf:params:jmap:mail",
      args.account_id,
    );

    const create: Record<string, unknown> = { name: args.name };
    if (args.parent_id !== undefined) create.parentId = args.parent_id;
    if (args.role !== undefined) create.role = args.role;
    if (args.sort_order !== undefined) create.sortOrder = args.sort_order;

    const res = await ctx.jmap.call(auth, [...USING.mail], "Mailbox/set", {
      accountId: account.accountId,
      create: { new: create },
    });
    return mailboxSetEnvelope(
      auth,
      account,
      ctx,
      res,
      "new",
      args.projection as ProjectionMode,
      args.fields,
    );
  },
});

// ---------------------------------------------------------------------------
// mailbox.rename (also reparent / re-sort)
// ---------------------------------------------------------------------------

const MailboxRenameInput = {
  id: JmapIdSchema.describe("Mailbox id to update."),
  name: z.string().min(1).optional().describe("New name."),
  parent_id: z.union([JmapIdSchema, z.null()]).optional().describe(
    "New parent id, or null to move to the top level. Omit to leave the parent unchanged.",
  ),
  sort_order: z.number().int().min(0).optional().describe("New sibling sort order."),
  account_id: AccountIdSchema,
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

type MailboxRenameArgs = OpArgs<typeof MailboxRenameInput>;

const mailboxRenameOp = defineOp({
  name: "mailbox.rename",
  mcpName: "rename_mailbox",
  description:
    "Rename a mailbox in the user's personal JMAP account (and/or reparent it via parent_id — " +
    "null moves it to the top level — or change its sort order). Returns the updated mailbox.",
  input: MailboxRenameInput,
  annotations: { readOnly: false, idempotent: true },
  confirmClass: "none",
  projection: "mailbox",
  surfaces: ["cli"],
  async handler(rawArgs, ctx) {
    const args = rawArgs as MailboxRenameArgs;
    if (args.name === undefined && args.parent_id === undefined && args.sort_order === undefined) {
      throw new Error("rename_mailbox: specify at least one of name, parent_id, or sort_order.");
    }
    const auth = authOf(ctx);
    const account = await ctx.jmap.resolveAccount(
      auth,
      "urn:ietf:params:jmap:mail",
      args.account_id,
    );

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.parent_id !== undefined) patch.parentId = args.parent_id;
    if (args.sort_order !== undefined) patch.sortOrder = args.sort_order;

    const res = await ctx.jmap.call(auth, [...USING.mail], "Mailbox/set", {
      accountId: account.accountId,
      update: { [args.id]: patch },
    });
    return mailboxSetEnvelope(
      auth,
      account,
      ctx,
      res,
      args.id,
      args.projection as ProjectionMode,
      args.fields,
    );
  },
});

// ---------------------------------------------------------------------------
// mailbox.delete
// ---------------------------------------------------------------------------

const MailboxDeleteInput = {
  ids: IdsSchema.describe("Mailbox ids to delete."),
  remove_emails: z.boolean().optional().describe(
    "false/omitted: refuse to delete a non-empty mailbox (mailboxHasEmail/mailboxHasChild " +
      "surface in failed). true: destroy the mailbox AND its emails (onDestroyRemoveEmails) — " +
      "irreversible, two-phase confirmation.",
  ),
  account_id: AccountIdSchema,
  confirm_token: z.string().min(16).optional().describe(
    "Echo the confirm_token from the challenge to execute a destructive delete (remove_emails).",
  ),
  projection: ProjectionSchema,
  fields: FieldsSchema,
};

type MailboxDeleteArgs = OpArgs<typeof MailboxDeleteInput>;

const mailboxDeleteOp = defineOp({
  name: "mailbox.delete",
  mcpName: "delete_mailbox",
  description:
    "Delete mailbox(es) from the user's personal JMAP account. Without remove_emails a non-empty " +
    "mailbox is refused (the error surfaces in failed). With remove_emails:true it destroys the " +
    "mailbox and every email in it — irreversible, so two-phase confirmation is required (repeat " +
    "with the confirm_token from the challenge).",
  input: MailboxDeleteInput,
  annotations: { readOnly: false, destructive: true, idempotent: true },
  confirmClass: "destructive",
  projection: "mailbox",
  surfaces: ["cli"],
  async handler(rawArgs, ctx) {
    const args = rawArgs as MailboxDeleteArgs;
    const removeEmails = args.remove_emails === true;
    const auth = authOf(ctx);
    const account = await ctx.jmap.resolveAccount(
      auth,
      "urn:ietf:params:jmap:mail",
      args.account_id,
    );
    const mailboxes = await loadMailboxes(auth, account.accountId, ctx);

    // The destructive gate only bites when remove_emails is set (that's the irreversible branch).
    // A plain delete of an empty mailbox is reversible-in-effect (nothing is lost) and gates none.
    if (removeEmails) {
      const sortedIds = [...args.ids].sort();
      const intent = {
        op: "mailbox.delete",
        account_id: account.accountId,
        resource_ids: sortedIds,
        payload: { remove_emails: true },
        actor_fingerprint: auth.fingerprint,
      };
      const gate = effectiveGate({ confirmClass: "destructive", policy: ctx.policy });
      if (gate === "two_phase") {
        const verdict = args.confirm_token
          ? await verifyConfirmToken(ctx.config.confirmationSecret, args.confirm_token, intent)
          : { ok: false as const, reason: "malformed" as const };
        if (!verdict.ok) {
          const targeted = mailboxes.filter((mb) => sortedIds.includes(mb.id));
          const preview = projectMailboxList(targeted, "brief", undefined);
          const token = await mintConfirmToken(ctx.config.confirmationSecret, intent);
          const challenge: ConfirmChallenge = {
            confirmation_required: true,
            summary:
              `Delete ${args.ids.length} mailbox(es) and ALL emails inside them. Cannot be undone.`,
            preview,
            confirm_token: token,
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          };
          return challenge;
        }
      }
    }

    const res = await ctx.jmap.call(auth, [...USING.mail], "Mailbox/set", {
      accountId: account.accountId,
      destroy: args.ids,
      onDestroyRemoveEmails: removeEmails,
    });
    const outcome = setOutcome(res);
    const env: Envelope<unknown> = {
      items: outcome.destroyed.map((id) => ({ id, destroyed: true })),
    };
    if (Object.keys(outcome.failed).length > 0) env.failed = outcome.failed;
    if (outcome.new_state) env.state = outcome.new_state;
    return env;
  },
});

/**
 * Shared Mailbox/set → projected Envelope for create/rename (single-target). `key` is the
 * creation id (for create) or the mailbox id (for update). On failure the SetError is surfaced in
 * `failed`; on success the affected mailbox is re-read and brief-projected.
 */
async function mailboxSetEnvelope(
  auth: JmapAuth,
  account: AccountRef,
  ctx: OpContext,
  res: Record<string, unknown>,
  key: string,
  mode: ProjectionMode,
  fields: string[] | undefined,
): Promise<Envelope<unknown>> {
  const outcome: SetOutcome = setOutcome(res);
  const failed = outcome.failed;
  // Resolve the server id: created returns {creationId: {id, ...}}; updated keys by id.
  let targetId: string | undefined;
  const createdEntry = outcome.created[key] as { id?: string } | undefined;
  if (createdEntry?.id) targetId = createdEntry.id;
  else if (key in outcome.updated) targetId = key;

  const env: Envelope<unknown> = { items: [] };
  if (targetId) {
    const got = await ctx.jmap.call(auth, [...USING.mail], "Mailbox/get", {
      accountId: account.accountId,
      ids: [targetId],
    });
    const list = Array.isArray(got.list) ? (got.list as Mailbox[]) : [];
    const pctx: ProjectionContext = { mailboxes: mailboxCtxMap(list), fields };
    env.items = list.map((mb) => project("mailbox", mb, mode, pctx));
  }
  if (Object.keys(failed).length > 0) env.failed = failed;
  if (outcome.new_state) env.state = outcome.new_state;
  return env;
}

export const ops: OpDefinition[] = [
  organizeOp,
  deleteOp,
  mailboxListOp,
  mailboxCreateOp,
  mailboxRenameOp,
  mailboxDeleteOp,
];
