import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import { READ_ONLY_METHOD_RE } from "../constants.ts";
import type { EnvConfig } from "../config.ts";
import { BLOB_USING, CALENDAR_PARSE_USING, FILE_USING } from "../jmap.ts";
import {
  accountIdSchema,
  confirmSchema,
  idsSchema,
  objectSchema,
  propertiesSchema,
  registerJsonTool,
  requireMutationConfirmation,
} from "./common.ts";

export function registerRawTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "icalendar_parse",
    "Parse iCalendar blobs or raw iCalendar text with CalendarEvent/parse.",
    {
      account_id: accountIdSchema,
      blob_ids: z.array(z.string()).optional(),
      icalendar: z.string().optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        CALENDAR_PARSE_USING[2],
        args.account_id,
      );
      return await context.jmap.single(account, CALENDAR_PARSE_USING, "CalendarEvent/parse", {
        accountId: account.accountId,
        ...(args.blob_ids ? { blobIds: args.blob_ids } : {}),
        ...(args.icalendar ? { icalendar: args.icalendar } : {}),
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "blob_lookup",
    "Resolve blob ids from object ids with Blob/lookup.",
    {
      account_id: accountIdSchema,
      type_names: z.array(z.string()).optional(),
      ids: idsSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        BLOB_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, BLOB_USING, "Blob/lookup", {
        accountId: account.accountId,
        ...(args.type_names ? { typeNames: args.type_names } : {}),
        ids: args.ids,
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "blob_get",
    "Get blob metadata and download URLs with Blob/get.",
    {
      account_id: accountIdSchema,
      ids: idsSchema,
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        BLOB_USING[1],
        args.account_id,
      );
      const get = await context.jmap.single(account, BLOB_USING, "Blob/get", {
        accountId: account.accountId,
        ids: args.ids,
        ...(args.properties ? { properties: args.properties } : {}),
      });
      return {
        ...get,
        downloadUrls: Object.fromEntries(
          args.ids.map((blobId) => [
            blobId,
            buildUrl(account.session.downloadUrl, account.accountId, blobId),
          ]),
        ),
      };
    },
  );

  registerJsonTool(
    server,
    config,
    "blob_copy",
    "Copy blobs between accounts with Blob/copy.",
    {
      account_id: accountIdSchema,
      from_account_id: z.string().optional(),
      blob_ids: idsSchema,
      ...confirmSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        BLOB_USING[1],
        args.account_id,
      );
      const payload = {
        accountId: account.accountId,
        fromAccountId: args.from_account_id ?? account.accountId,
        blobIds: args.blob_ids,
      };
      const guard = await requireMutationConfirmation(context, {
        toolName: "blob_copy",
        accountId: account.accountId,
        operation: "create",
        resourceKind: "Blob",
        resourceIds: args.blob_ids,
        payload,
        summary: `Copy ${args.blob_ids.length} blob(s).`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, BLOB_USING, "Blob/copy", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "blob_upload",
    "Upload a base64-encoded blob through the JMAP upload URL.",
    {
      account_id: accountIdSchema,
      content_base64: z.string(),
      content_type: z.string().default("application/octet-stream").optional(),
      filename: z.string().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        BLOB_USING[1],
        args.account_id,
      );
      const uploadUrl = buildUrl(account.session.uploadUrl, account.accountId);
      if (!uploadUrl) throw new Error("JMAP session did not include an uploadUrl");
      const bytes = Uint8Array.from(atob(args.content_base64), (char) => char.charCodeAt(0));
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: account.auth.authorization,
          "Content-Type": args.content_type ?? "application/octet-stream",
          ...(args.filename
            ? { "Content-Disposition": `attachment; filename="${args.filename}"` }
            : {}),
        },
        body: bytes,
      });
      if (!response.ok) throw new Error(`Blob upload failed: HTTP ${response.status}`);
      return await response.json();
    },
  );

  registerFileNodeTools(server, config);
  registerJmapCallTool(server, config);
}

function registerFileNodeTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "file_node_list",
    "List file nodes with FileNode/query followed by FileNode/get.",
    {
      account_id: accountIdSchema,
      filter: objectSchema.optional(),
      sort: z.array(objectSchema).optional(),
      position: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(500).optional(),
      properties: propertiesSchema,
      fetch: z.boolean().default(true).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        FILE_USING[1],
        args.account_id,
      );
      const query = await context.jmap.single(account, FILE_USING, "FileNode/query", {
        accountId: account.accountId,
        ...(args.filter ? { filter: args.filter } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (args.fetch === false) return { query };
      const ids = Array.isArray(query.ids) ? query.ids.filter((id) => typeof id === "string") : [];
      const get = ids.length
        ? await context.jmap.single(account, FILE_USING, "FileNode/get", {
          accountId: account.accountId,
          ids,
          ...(args.properties ? { properties: args.properties } : {}),
        })
        : { accountId: account.accountId, list: [], notFound: [] };
      return { query, get };
    },
  );

  registerJsonTool(
    server,
    config,
    "file_node_get",
    "Read file nodes with FileNode/get.",
    {
      account_id: accountIdSchema,
      ids: idsSchema,
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        FILE_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, FILE_USING, "FileNode/get", {
        accountId: account.accountId,
        ids: args.ids,
        ...(args.properties ? { properties: args.properties } : {}),
      });
    },
  );
}

function registerJmapCallTool(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "jmap_call",
    "Escape hatch for raw JMAP calls. Read-only methods are allowed by default; mutations require allow_mutation plus confirmation.",
    {
      account_id: accountIdSchema,
      using: z.array(z.string()).min(1),
      method_calls: z.array(z.tuple([z.string(), objectSchema, z.string()])).min(1),
      allow_mutation: z.boolean().default(false).optional(),
      ...confirmSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(context.actor, undefined, args.account_id);
      const mutatingMethods = args.method_calls
        .map(([method]) => method)
        .filter((method) => !READ_ONLY_METHOD_RE.test(method));
      if (mutatingMethods.length && !args.allow_mutation) {
        throw new Error(
          `jmap_call rejected mutating methods without allow_mutation: ${
            mutatingMethods.join(", ")
          }`,
        );
      }
      const invocation = { using: args.using, methodCalls: args.method_calls };
      if (mutatingMethods.length) {
        const guard = await requireMutationConfirmation(context, {
          toolName: "jmap_call",
          accountId: account.accountId,
          operation: "admin",
          resourceKind: "JMAPMethodCall",
          resourceIds: mutatingMethods,
          payload: invocation,
          summary: `Execute raw mutating JMAP call(s): ${mutatingMethods.join(", ")}.`,
          confirmFingerprint: args.confirmFingerprint,
          confirmExpiresAt: args.confirmExpiresAt,
        });
        if (guard) return guard;
      }
      return await context.jmap.call(account, invocation);
    },
  );
}

function buildUrl(
  template: string | undefined,
  accountId: string,
  blobId?: string,
): string | undefined {
  if (!template) return undefined;
  return template
    .replaceAll("{accountId}", encodeURIComponent(accountId))
    .replaceAll("{blobId}", encodeURIComponent(blobId ?? ""))
    .replaceAll("{name}", encodeURIComponent(blobId ?? "blob"))
    .replaceAll("{type}", encodeURIComponent("application/octet-stream"));
}
