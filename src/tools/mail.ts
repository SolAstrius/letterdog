import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import type { AccountContext } from "../jmap.ts";
import { MAIL_BLOB_USING, MAIL_USING, SUBMISSION_USING } from "../jmap.ts";
import type { ToolContext } from "../server/context.ts";
import {
  accountIdSchema,
  confirmSchema,
  idsSchema,
  objectSchema,
  propertiesSchema,
  registerJsonTool,
  requireMutationConfirmation,
  setArgs,
} from "./common.ts";

type MailboxRole = "inbox" | "archive" | "drafts" | "sent" | "junk" | "trash";

interface MailboxSummary {
  id: string;
  name?: string;
  role?: string;
  parentId?: string | null;
}

interface SearchTranslation {
  filter: Record<string, unknown>;
  unsupported: string[];
}

interface ComposeAddress {
  name?: string;
  email: string;
}

interface ComposeBody {
  text?: string;
  html?: string;
}

interface ComposeAttachment {
  blobId: string;
  type: string;
  name?: string;
  size?: number;
  cid?: string;
  disposition?: "attachment" | "inline";
}

interface ComposeEmail {
  from?: ComposeAddress;
  to?: ComposeAddress[];
  cc?: ComposeAddress[];
  bcc?: ComposeAddress[];
  reply_to?: ComposeAddress[];
  subject: string;
  body?: ComposeBody;
  text_body?: string;
  html_body?: string;
  in_reply_to?: string[];
  references?: string[];
  extra_headers?: Record<string, string>;
  mailbox_ids?: string[];
  keywords?: Record<string, boolean>;
}

const addressSchema = z.object({
  name: z.string().optional(),
  email: z.string().min(1),
});

const bodySchema = z.object({
  text: z.string().optional(),
  html: z.string().optional(),
});

const composeEmailSchema = z.object({
  from: addressSchema.optional(),
  to: z.array(addressSchema).optional(),
  cc: z.array(addressSchema).optional(),
  bcc: z.array(addressSchema).optional(),
  reply_to: z.array(addressSchema).optional(),
  subject: z.string(),
  body: bodySchema.optional(),
  text_body: z.string().optional(),
  html_body: z.string().optional(),
  in_reply_to: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  extra_headers: z.record(z.string(), z.string()).optional(),
  mailbox_ids: z.array(z.string()).optional(),
  keywords: z.record(z.string(), z.boolean()).optional(),
});

const uploadedBlobRefSchema = z.object({
  blobId: z.string(),
  type: z.string(),
  name: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  cid: z.string().optional(),
  disposition: z.enum(["attachment", "inline"]).optional(),
});

const queryShape = {
  account_id: accountIdSchema,
  query: z.string().optional(),
  filter: objectSchema.optional(),
  sort: z.array(objectSchema).optional(),
  position: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).optional(),
  collapse_threads: z.boolean().optional(),
  calculate_total: z.boolean().optional(),
};

const mutationShape = {
  account_id: accountIdSchema,
  if_in_state: z.string().optional(),
  ...confirmSchema,
};

const SUMMARY_EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
];

const BODY_EMAIL_PROPERTIES = [
  ...SUMMARY_EMAIL_PROPERTIES,
  "bodyStructure",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
];

export function registerMailTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "get_mail_profile",
    "Read the caller's JMAP mail profile, account list, and mail identities.",
    {
      account_id: accountIdSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const session = account.session as unknown as Record<string, unknown>;
      const identities = account.session.accounts[account.accountId]?.accountCapabilities?.[
          SUBMISSION_USING[2]
        ]
        ? await context.jmap.single(account, SUBMISSION_USING, "Identity/get", {
          accountId: account.accountId,
          ids: null,
        })
        : { list: [], notFound: [], unavailable: "Account does not advertise JMAP Submission." };
      return {
        username: session.username,
        accounts: account.session.accounts,
        primaryMailAccountId: account.session.primaryAccounts?.[MAIL_USING[1]],
        primarySubmissionAccountId: account.session.primaryAccounts?.[SUBMISSION_USING[2]],
        resolvedAccountId: account.accountId,
        identities,
      };
    },
  );

  registerJsonTool(
    server,
    config,
    "list_mailboxes",
    "List JMAP mailboxes, which are the default Gmail-like label model.",
    {
      account_id: accountIdSchema,
      include_counts: z.boolean().default(true).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      return await context.jmap.single(account, MAIL_USING, "Mailbox/get", {
        accountId: account.accountId,
        ids: null,
        ...(args.properties ? { properties: args.properties } : args.include_counts === false
          ? {
            properties: [
              "id",
              "name",
              "parentId",
              "role",
              "sortOrder",
              "isSubscribed",
              "myRights",
            ],
          }
          : {}),
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "search_email_ids",
    "Search mail with Gmail-like query syntax translated to Email/query filters.",
    queryShape,
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const translation = await buildEmailFilter(context, account, args.query, args.filter);
      const query = await context.jmap.single(account, MAIL_USING, "Email/query", {
        accountId: account.accountId,
        ...pickEmailQuery({ ...args, filter: translation.filter }),
      });
      return { query, unsupported: translation.unsupported };
    },
  );

  registerJsonTool(
    server,
    config,
    "search_emails",
    "Search mail with Email/query and fetch matching Email objects in the same JMAP request.",
    {
      ...queryShape,
      properties: propertiesSchema,
      include_body: z.boolean().default(false).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const translation = await buildEmailFilter(context, account, args.query, args.filter);
      const properties = args.properties ?? emailProperties(args.include_body);
      const response = await context.jmap.call(account, {
        using: MAIL_USING,
        methodCalls: [
          [
            "Email/query",
            {
              accountId: account.accountId,
              ...pickEmailQuery({ ...args, filter: translation.filter }),
            },
            "q",
          ],
          [
            "Email/get",
            {
              accountId: account.accountId,
              "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
              properties,
            },
            "g",
          ],
        ],
      });
      return {
        query: methodResponse(response, "q"),
        get: methodResponse(response, "g"),
        unsupported: translation.unsupported,
      };
    },
  );

  registerJsonTool(
    server,
    config,
    "read_email",
    "Read one Email object, optionally including parsed body values and raw MIME.",
    {
      account_id: accountIdSchema,
      email_id: z.string(),
      include_body: z.boolean().default(true).optional(),
      include_raw: z.boolean().default(false).optional(),
      max_body_bytes: z.number().int().positive().max(2_000_000).default(100_000).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const properties = args.properties ??
        (args.include_raw
          ? unique([...emailProperties(args.include_body), "blobId"])
          : emailProperties(args.include_body));
      const get = await context.jmap.single(account, MAIL_USING, "Email/get", {
        accountId: account.accountId,
        ids: [args.email_id],
        properties,
      });
      const email = firstListedObject(get);
      const blobId = typeof email?.blobId === "string" ? email.blobId : undefined;
      const raw = args.include_raw && blobId
        ? await downloadBlob(account, blobId, {
          as: "text",
          maxBytes: args.max_body_bytes,
          filename: `${args.email_id}.eml`,
          contentType: "message/rfc822",
        })
        : undefined;
      return { get, ...(raw ? { raw } : {}) };
    },
  );

  registerJsonTool(
    server,
    config,
    "batch_read_emails",
    "Read multiple Email objects with chunked Email/get calls.",
    {
      account_id: accountIdSchema,
      email_ids: idsSchema,
      properties: propertiesSchema,
      include_body: z.boolean().default(false).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      return await batchEmailGet(
        context,
        account,
        args.email_ids,
        args.properties ?? emailProperties(args.include_body),
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "read_email_thread",
    "Read a mail thread by Email id or Thread id.",
    {
      account_id: accountIdSchema,
      email_id: z.string().optional(),
      thread_id: z.string().optional(),
      include_body: z.boolean().default(true).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      if (!args.email_id && !args.thread_id) {
        throw new Error("Provide email_id or thread_id.");
      }
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const threadId = args.thread_id ??
        await threadIdForEmail(context, account, args.email_id as string);
      const threadGet = await context.jmap.single(account, MAIL_USING, "Thread/get", {
        accountId: account.accountId,
        ids: [threadId],
      });
      const thread = firstListedObject(threadGet);
      const emailIds = asStringArray(thread?.emailIds);
      const emails = emailIds.length
        ? await batchEmailGet(
          context,
          account,
          emailIds,
          args.properties ?? emailProperties(args.include_body),
        )
        : { accountId: account.accountId, list: [], notFound: [] };
      return { thread: threadGet, emails };
    },
  );

  registerJsonTool(
    server,
    config,
    "batch_read_email_threads",
    "Read multiple mail threads and their Email objects.",
    {
      account_id: accountIdSchema,
      thread_ids: idsSchema,
      include_body: z.boolean().default(false).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const threadGet = await context.jmap.single(account, MAIL_USING, "Thread/get", {
        accountId: account.accountId,
        ids: args.thread_ids,
      });
      const emailIds = unique(
        objectList(threadGet).flatMap((thread) => asStringArray(thread.emailIds)),
      );
      const emails = emailIds.length
        ? await batchEmailGet(
          context,
          account,
          emailIds,
          args.properties ?? emailProperties(args.include_body),
        )
        : { accountId: account.accountId, list: [], notFound: [] };
      return { threads: threadGet, emails };
    },
  );

  registerJsonTool(
    server,
    config,
    "read_attachment",
    "Read an attachment or body blob after verifying it belongs to the requested Email.",
    {
      account_id: accountIdSchema,
      email_id: z.string(),
      blob_id: z.string().optional(),
      part_id: z.string().optional(),
      as: z.enum(["bytes", "base64", "text"]).default("base64").optional(),
      max_bytes: z.number().int().positive().max(10_000_000).default(1_000_000).optional(),
    },
    async (args, context) => {
      if (!args.blob_id && !args.part_id) throw new Error("Provide blob_id or part_id.");
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_BLOB_USING[1],
        args.account_id,
      );
      const get = await context.jmap.single(account, MAIL_USING, "Email/get", {
        accountId: account.accountId,
        ids: [args.email_id],
        properties: ["id", "bodyStructure", "attachments"],
      });
      const email = firstListedObject(get);
      if (!email) throw new Error(`Email ${args.email_id} was not found.`);
      const part = findEmailPart(email, args.blob_id, args.part_id);
      if (!part?.blobId || typeof part.blobId !== "string") {
        throw new Error("No matching blob part was found on the requested email.");
      }
      const blob = await downloadBlob(account, part.blobId, {
        as: args.as ?? "base64",
        maxBytes: args.max_bytes,
        filename: typeof part.name === "string" ? part.name : part.blobId,
        contentType: typeof part.type === "string" ? part.type : undefined,
      });
      return {
        emailId: args.email_id,
        blobId: part.blobId,
        partId: part.partId,
        part,
        ...blob,
      };
    },
  );

  registerDraftTools(server, config);
  registerSendTools(server, config);
  registerMutationTools(server, config);
}

function registerDraftTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "create_draft_email",
    "Create a draft Email object in the Drafts mailbox with the $draft keyword.",
    {
      ...mutationShape,
      message: composeEmailSchema,
      attachments: z.array(uploadedBlobRefSchema).optional(),
      create_id: z.string().default("draft").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const draftsId = requireMailboxRole(mailboxes, "drafts");
      const email = composeToEmail(args.message as ComposeEmail, args.attachments, {
        mailboxIds: [draftsId],
        keywords: { "$draft": true, "$seen": true },
      });
      const create = { [args.create_id ?? "draft"]: email };
      const payload = setArgs(account.accountId, { create, ifInState: args.if_in_state });
      return await context.jmap.single(account, MAIL_USING, "Email/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "update_draft_email",
    "Replace a draft by creating a new Email object and destroying the old draft.",
    {
      ...mutationShape,
      draft_email_id: z.string(),
      message: composeEmailSchema,
      attachments: z.array(uploadedBlobRefSchema).optional(),
      create_id: z.string().default("replacement").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const draftsId = requireMailboxRole(mailboxes, "drafts");
      const oldDraft = await context.jmap.single(account, MAIL_USING, "Email/get", {
        accountId: account.accountId,
        ids: [args.draft_email_id],
        properties: ["id", "keywords"],
      });
      const oldEmail = firstListedObject(oldDraft);
      if (!oldEmail) throw new Error(`Draft ${args.draft_email_id} was not found.`);
      const keywords = oldEmail.keywords && typeof oldEmail.keywords === "object"
        ? oldEmail.keywords as Record<string, boolean>
        : {};
      if (keywords["$draft"] !== true) {
        throw new Error(`Email ${args.draft_email_id} is not marked as a draft.`);
      }
      const email = composeToEmail(args.message as ComposeEmail, args.attachments, {
        mailboxIds: [draftsId],
        keywords: { ...keywords, "$draft": true, "$seen": true },
      });
      const payload = setArgs(account.accountId, {
        create: { [args.create_id ?? "replacement"]: email },
        destroy: [args.draft_email_id],
        ifInState: args.if_in_state,
      });
      return await context.jmap.single(account, MAIL_USING, "Email/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "list_draft_emails",
    "List draft messages with Email/query and Email/get.",
    {
      account_id: accountIdSchema,
      limit: z.number().int().positive().max(200).default(50).optional(),
      include_body: z.boolean().default(false).optional(),
      properties: propertiesSchema,
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const draftsId = mailboxRoleId(mailboxes, "drafts");
      const filter = combineFilters(
        { hasKeyword: "$draft" },
        draftsId ? { inMailbox: draftsId } : undefined,
      );
      const response = await context.jmap.call(account, {
        using: MAIL_USING,
        methodCalls: [
          [
            "Email/query",
            {
              accountId: account.accountId,
              filter,
              sort: [{ property: "receivedAt", isAscending: false }],
              limit: args.limit ?? 50,
            },
            "q",
          ],
          [
            "Email/get",
            {
              accountId: account.accountId,
              "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
              properties: args.properties ?? emailProperties(args.include_body),
            },
            "g",
          ],
        ],
      });
      return { query: methodResponse(response, "q"), get: methodResponse(response, "g") };
    },
  );
}

function registerSendTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "send_draft_email",
    "Send an existing draft Email with EmailSubmission/set.",
    {
      ...mutationShape,
      draft_email_id: z.string(),
      identity_id: z.string().optional(),
      envelope: objectSchema.optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        SUBMISSION_USING[2],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const payload = {
        accountId: account.accountId,
        create: {
          send: {
            emailId: args.draft_email_id,
            identityId: await resolveIdentityId(context, account, args.identity_id),
            ...(args.envelope ? { envelope: args.envelope } : {}),
          },
        },
        onSuccessUpdateEmail: {
          [args.draft_email_id]: sentEmailPatch(mailboxes),
        },
        ...(args.if_in_state ? { ifInState: args.if_in_state } : {}),
      };
      const guard = await requireMutationConfirmation(context, {
        toolName: "send_draft_email",
        accountId: account.accountId,
        operation: "send",
        resourceKind: "EmailSubmission",
        resourceIds: [args.draft_email_id],
        payload,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Send draft ${args.draft_email_id}.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.single(account, SUBMISSION_USING, "EmailSubmission/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "send_email",
    "Compose an Email object and submit it in one batched JMAP request.",
    {
      ...mutationShape,
      message: composeEmailSchema,
      attachments: z.array(uploadedBlobRefSchema).optional(),
      identity_id: z.string().optional(),
      envelope: objectSchema.optional(),
      create_id: z.string().default("email").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        SUBMISSION_USING[2],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const draftsId = requireMailboxRole(mailboxes, "drafts");
      const createId = args.create_id ?? "email";
      const email = composeToEmail(args.message as ComposeEmail, args.attachments, {
        mailboxIds: [draftsId],
        keywords: { "$draft": true, "$seen": true },
      });
      const identityId = await resolveIdentityId(context, account, args.identity_id);
      const invocation = {
        using: SUBMISSION_USING,
        methodCalls: [
          [
            "Email/set",
            setArgs(account.accountId, {
              create: { [createId]: email },
              ifInState: args.if_in_state,
            }),
            "emailSet",
          ],
          [
            "EmailSubmission/set",
            {
              accountId: account.accountId,
              create: {
                send: {
                  "#emailId": {
                    resultOf: "emailSet",
                    name: "Email/set",
                    path: `/created/${createId}/id`,
                  },
                  identityId,
                  ...(args.envelope ? { envelope: args.envelope } : {}),
                },
              },
              onSuccessUpdateEmail: {
                [`#${createId}`]: sentEmailPatch(mailboxes),
              },
            },
            "submissionSet",
          ],
        ] as [string, Record<string, unknown>, string][],
      };
      const guard = await requireMutationConfirmation(context, {
        toolName: "send_email",
        accountId: account.accountId,
        operation: "send",
        resourceKind: "EmailSubmission",
        resourceIds: [createId],
        payload: invocation,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Send email "${args.message.subject}".`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.call(account, invocation);
    },
  );

  registerJsonTool(
    server,
    config,
    "forward_emails",
    "Forward existing emails by composing and submitting new forwarded messages.",
    {
      ...mutationShape,
      email_ids: idsSchema,
      to: z.array(addressSchema).min(1),
      cc: z.array(addressSchema).optional(),
      bcc: z.array(addressSchema).optional(),
      body: bodySchema.optional(),
      mode: z.enum(["quote", "attachOriginal"]).default("quote").optional(),
      identity_id: z.string().optional(),
      forwarded_keyword: z.string().default("$Forwarded").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        SUBMISSION_USING[2],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const draftsId = requireMailboxRole(mailboxes, "drafts");
      const originals = await batchEmailGet(
        context,
        account,
        args.email_ids,
        BODY_EMAIL_PROPERTIES,
      );
      const originalList = objectList(originals);
      const missing = args.email_ids.filter((id) => !originalList.some((email) => email.id === id));
      if (missing.length) throw new Error(`Email(s) not found: ${missing.join(", ")}`);
      const identityId = await resolveIdentityId(context, account, args.identity_id);
      const create: Record<string, unknown> = {};
      const submissionCreate: Record<string, unknown> = {};
      const onSuccessUpdateEmail: Record<string, unknown> = {};
      for (const [index, original] of originalList.entries()) {
        const createId = `forward${index}`;
        const originalSubject = typeof original.subject === "string" ? original.subject : "";
        const quoted = forwardedBody(original, args.body as ComposeBody | undefined);
        const attachments = args.mode === "attachOriginal" && typeof original.blobId === "string"
          ? [{
            blobId: original.blobId,
            type: "message/rfc822",
            name: `${safeFilename(originalSubject || "forwarded")}.eml`,
            disposition: "attachment" as const,
          }]
          : undefined;
        create[createId] = composeToEmail(
          {
            to: args.to as ComposeAddress[],
            cc: args.cc as ComposeAddress[] | undefined,
            bcc: args.bcc as ComposeAddress[] | undefined,
            subject: originalSubject.toLowerCase().startsWith("fwd:")
              ? originalSubject
              : `Fwd: ${originalSubject}`,
            body: { text: quoted },
          },
          attachments,
          { mailboxIds: [draftsId], keywords: { "$draft": true, "$seen": true } },
        );
        submissionCreate[`send${index}`] = {
          "#emailId": { resultOf: "emailSet", name: "Email/set", path: `/created/${createId}/id` },
          identityId,
        };
        onSuccessUpdateEmail[`#${createId}`] = sentEmailPatch(mailboxes);
        if (typeof original.id === "string") {
          onSuccessUpdateEmail[original.id] = {
            [`keywords/${args.forwarded_keyword ?? "$Forwarded"}`]: true,
          };
        }
      }
      const invocation = {
        using: SUBMISSION_USING,
        methodCalls: [
          [
            "Email/set",
            setArgs(account.accountId, { create, ifInState: args.if_in_state }),
            "emailSet",
          ],
          [
            "EmailSubmission/set",
            {
              accountId: account.accountId,
              create: submissionCreate,
              onSuccessUpdateEmail,
            },
            "submissionSet",
          ],
        ] as [string, Record<string, unknown>, string][],
      };
      const guard = await requireMutationConfirmation(context, {
        toolName: "forward_emails",
        accountId: account.accountId,
        operation: "send",
        resourceKind: "EmailSubmission",
        resourceIds: args.email_ids,
        payload: invocation,
        precondition: args.if_in_state ? { ifInState: args.if_in_state } : undefined,
        summary: `Forward ${args.email_ids.length} email(s).`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
      });
      if (guard) return guard;
      return await context.jmap.call(account, invocation);
    },
  );
}

function registerMutationTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "archive_emails",
    "Archive emails by removing Inbox and optionally adding the Archive mailbox.",
    {
      ...mutationShape,
      email_ids: idsSchema,
      strategy: z.enum(["moveToArchive", "removeInbox"]).default("moveToArchive").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const mailboxes = await getMailboxes(context, account);
      const inboxId = requireMailboxRole(mailboxes, "inbox");
      const archiveId = mailboxRoleId(mailboxes, "archive");
      if ((args.strategy ?? "moveToArchive") === "moveToArchive" && !archiveId) {
        throw new Error("No Archive-role mailbox is available for moveToArchive.");
      }
      const emails = objectList(
        await batchEmailGet(context, account, args.email_ids, ["id", "mailboxIds"]),
      );
      const update: Record<string, unknown> = {};
      for (const email of emails) {
        if (typeof email.id !== "string") continue;
        const mailboxIds = objectKeys(email.mailboxIds);
        if (!mailboxIds.includes(inboxId)) continue;
        const patch: Record<string, unknown> = { [`mailboxIds/${inboxId}`]: null };
        if ((args.strategy ?? "moveToArchive") === "moveToArchive" && archiveId) {
          patch[`mailboxIds/${archiveId}`] = true;
        } else if (mailboxIds.length <= 1) {
          throw new Error(`Cannot remove Inbox from ${email.id}; it has no other mailbox.`);
        }
        update[email.id] = patch;
      }
      return await context.jmap.single(
        account,
        MAIL_USING,
        "Email/set",
        setArgs(account.accountId, { update, ifInState: args.if_in_state }),
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "delete_emails",
    "Move emails to Trash, or permanently destroy them when permanent is true.",
    {
      ...mutationShape,
      email_ids: idsSchema,
      permanent: z.boolean().default(false).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      if (args.permanent) {
        return await guardedEmailSet(context, account, {
          toolName: "delete_emails",
          operation: "delete",
          resourceIds: args.email_ids,
          payload: setArgs(account.accountId, {
            destroy: args.email_ids,
            ifInState: args.if_in_state,
          }),
          summary: `Permanently delete ${args.email_ids.length} email(s).`,
          confirmFingerprint: args.confirmFingerprint,
          confirmExpiresAt: args.confirmExpiresAt,
          ifInState: args.if_in_state,
        });
      }
      const mailboxes = await getMailboxes(context, account);
      const trashId = requireMailboxRole(mailboxes, "trash");
      const emails = objectList(
        await batchEmailGet(context, account, args.email_ids, ["id", "mailboxIds"]),
      );
      const update: Record<string, unknown> = {};
      for (const email of emails) {
        if (typeof email.id !== "string") continue;
        const patch: Record<string, unknown> = { [`mailboxIds/${trashId}`]: true };
        for (const mailboxId of objectKeys(email.mailboxIds)) {
          if (mailboxId !== trashId) patch[`mailboxIds/${mailboxId}`] = null;
        }
        update[email.id] = patch;
      }
      return await guardedEmailSet(context, account, {
        toolName: "delete_emails",
        operation: "move",
        resourceIds: args.email_ids,
        payload: setArgs(account.accountId, { update, ifInState: args.if_in_state }),
        summary: `Move ${Object.keys(update).length} email(s) to Trash.`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
        ifInState: args.if_in_state,
      });
    },
  );

  registerJsonTool(
    server,
    config,
    "create_mail_label",
    "Create a user-visible mail label as a JMAP Mailbox.",
    {
      ...mutationShape,
      name: z.string().min(1),
      parent_id: z.string().optional(),
      is_subscribed: z.boolean().optional(),
      create_id: z.string().default("label").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const mailbox = {
        name: args.name,
        ...(args.parent_id ? { parentId: args.parent_id } : {}),
        ...(args.is_subscribed !== undefined ? { isSubscribed: args.is_subscribed } : {}),
      };
      const payload = setArgs(account.accountId, {
        create: { [args.create_id ?? "label"]: mailbox },
        ifInState: args.if_in_state,
      });
      return await context.jmap.single(account, MAIL_USING, "Mailbox/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "batch_modify_emails",
    "Patch mailbox memberships and keywords on explicit Email ids.",
    {
      ...mutationShape,
      email_ids: idsSchema,
      add_mailbox_ids: z.array(z.string()).optional(),
      remove_mailbox_ids: z.array(z.string()).optional(),
      add_keywords: z.array(z.string()).optional(),
      remove_keywords: z.array(z.string()).optional(),
      trash: z.boolean().default(false).optional(),
      permanent_delete: z.boolean().default(false).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      if (args.permanent_delete) {
        return await guardedEmailSet(context, account, {
          toolName: "batch_modify_emails",
          operation: "delete",
          resourceIds: args.email_ids,
          payload: setArgs(account.accountId, {
            destroy: args.email_ids,
            ifInState: args.if_in_state,
          }),
          summary: `Permanently delete ${args.email_ids.length} email(s).`,
          confirmFingerprint: args.confirmFingerprint,
          confirmExpiresAt: args.confirmExpiresAt,
          ifInState: args.if_in_state,
        });
      }
      const mailboxes = args.trash ? await getMailboxes(context, account) : [];
      const patch = emailModifyPatch({
        addMailboxIds: args.add_mailbox_ids,
        removeMailboxIds: args.remove_mailbox_ids,
        addKeywords: args.add_keywords,
        removeKeywords: args.remove_keywords,
        trashMailboxId: args.trash ? requireMailboxRole(mailboxes, "trash") : undefined,
      });
      const update = Object.fromEntries(args.email_ids.map((id) => [id, patch]));
      const payload = setArgs(account.accountId, { update, ifInState: args.if_in_state });
      if (
        requiresBatchModifyConfirmation({
          trash: args.trash,
          permanentDelete: args.permanent_delete,
          removeMailboxIds: args.remove_mailbox_ids,
        })
      ) {
        return await guardedEmailSet(context, account, {
          toolName: "batch_modify_emails",
          operation: args.trash ? "move" : "update",
          resourceIds: args.email_ids,
          payload,
          summary: `Modify ${args.email_ids.length} email(s).`,
          confirmFingerprint: args.confirmFingerprint,
          confirmExpiresAt: args.confirmExpiresAt,
          ifInState: args.if_in_state,
        });
      }
      return await context.jmap.single(account, MAIL_USING, "Email/set", payload);
    },
  );

  registerJsonTool(
    server,
    config,
    "apply_mail_labels",
    "Apply mailbox labels or keyword tags to explicit Email ids.",
    {
      ...mutationShape,
      email_ids: idsSchema,
      label_ids: idsSchema,
      label_kind: z.enum(["mailbox", "keyword"]).default("mailbox").optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const patch = args.label_kind === "keyword"
        ? emailModifyPatch({ addKeywords: args.label_ids })
        : emailModifyPatch({ addMailboxIds: args.label_ids });
      const update = Object.fromEntries(args.email_ids.map((id) => [id, patch]));
      return await context.jmap.single(
        account,
        MAIL_USING,
        "Email/set",
        setArgs(account.accountId, { update, ifInState: args.if_in_state }),
      );
    },
  );

  registerJsonTool(
    server,
    config,
    "bulk_label_matching_emails",
    "Search matching Email ids, then apply mailbox/keyword label patches in chunks.",
    {
      ...mutationShape,
      query: z.string(),
      add_label_ids: z.array(z.string()).optional(),
      remove_label_ids: z.array(z.string()).optional(),
      label_kind: z.enum(["mailbox", "keyword"]).default("mailbox").optional(),
      dry_run: z.boolean().default(true).optional(),
      max_matches: z.number().int().positive().max(1000).default(500).optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        MAIL_USING[1],
        args.account_id,
      );
      const translation = await buildEmailFilter(context, account, args.query);
      const query = await context.jmap.single(account, MAIL_USING, "Email/query", {
        accountId: account.accountId,
        filter: translation.filter,
        limit: args.max_matches ?? 500,
        calculateTotal: true,
      });
      const ids = asStringArray(query.ids);
      if (args.dry_run !== false) {
        return {
          dryRun: true,
          ids,
          matched: ids.length,
          total: query.total,
          unsupported: translation.unsupported,
        };
      }
      const patch = args.label_kind === "keyword"
        ? emailModifyPatch({
          addKeywords: args.add_label_ids,
          removeKeywords: args.remove_label_ids,
        })
        : emailModifyPatch({
          addMailboxIds: args.add_label_ids,
          removeMailboxIds: args.remove_label_ids,
        });
      const update = Object.fromEntries(ids.map((id) => [id, patch]));
      return await guardedEmailSet(context, account, {
        toolName: "bulk_label_matching_emails",
        operation: "update",
        resourceIds: ids,
        payload: setArgs(account.accountId, { update, ifInState: args.if_in_state }),
        summary: `Bulk-label ${ids.length} email(s) matching "${args.query}".`,
        confirmFingerprint: args.confirmFingerprint,
        confirmExpiresAt: args.confirmExpiresAt,
        ifInState: args.if_in_state,
      });
    },
  );
}

export function parseMailSearchQuery(
  query: string | undefined,
  mailboxes: MailboxSummary[] = [],
): SearchTranslation {
  const conditions: Record<string, unknown>[] = [];
  const freeText: string[] = [];
  const unsupported: string[] = [];
  for (const token of tokenizeQuery(query ?? "")) {
    const parsed = splitOperator(token);
    if (!parsed) {
      if (token.trim()) freeText.push(token);
      continue;
    }
    const { negated, key, value } = parsed;
    const condition = conditionForOperator(key, value, mailboxes);
    if (!condition) {
      unsupported.push(token);
      continue;
    }
    conditions.push(negated ? negateCondition(condition) : condition);
  }
  if (freeText.length) conditions.push({ text: freeText.join(" ") });
  return { filter: combineFilters(...conditions), unsupported };
}

export function emailModifyPatch(args: {
  addMailboxIds?: string[];
  removeMailboxIds?: string[];
  addKeywords?: string[];
  removeKeywords?: string[];
  trashMailboxId?: string;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const id of args.addMailboxIds ?? []) patch[`mailboxIds/${id}`] = true;
  for (const id of args.removeMailboxIds ?? []) patch[`mailboxIds/${id}`] = null;
  for (const keyword of args.addKeywords ?? []) patch[`keywords/${keyword}`] = true;
  for (const keyword of args.removeKeywords ?? []) patch[`keywords/${keyword}`] = null;
  if (args.trashMailboxId) patch[`mailboxIds/${args.trashMailboxId}`] = true;
  if (!Object.keys(patch).length) throw new Error("No mailbox or keyword changes were provided.");
  return patch;
}

export function requiresBatchModifyConfirmation(args: {
  trash?: boolean;
  permanentDelete?: boolean;
  removeMailboxIds?: string[];
}): boolean {
  return args.permanentDelete === true || args.trash === true ||
    (args.removeMailboxIds?.length ?? 0) > 0;
}

async function buildEmailFilter(
  context: ToolContext,
  account: AccountContext,
  query?: string,
  explicitFilter?: Record<string, unknown>,
): Promise<SearchTranslation> {
  const mailboxes = query ? await getMailboxes(context, account) : [];
  const parsed = parseMailSearchQuery(query, mailboxes);
  return {
    filter: combineFilters(explicitFilter, parsed.filter),
    unsupported: parsed.unsupported,
  };
}

function pickEmailQuery(args: {
  filter?: Record<string, unknown>;
  sort?: Record<string, unknown>[];
  position?: number;
  limit?: number;
  collapse_threads?: boolean;
  calculate_total?: boolean;
}): Record<string, unknown> {
  return {
    ...(args.filter && Object.keys(args.filter).length ? { filter: args.filter } : {}),
    ...(args.sort ? { sort: args.sort } : {}),
    ...(args.position !== undefined ? { position: args.position } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.collapse_threads !== undefined ? { collapseThreads: args.collapse_threads } : {}),
    ...(args.calculate_total !== undefined ? { calculateTotal: args.calculate_total } : {}),
  };
}

function emailProperties(includeBody?: boolean): string[] {
  return includeBody ? BODY_EMAIL_PROPERTIES : SUMMARY_EMAIL_PROPERTIES;
}

async function getMailboxes(
  context: ToolContext,
  account: AccountContext,
): Promise<MailboxSummary[]> {
  const get = await context.jmap.single(account, MAIL_USING, "Mailbox/get", {
    accountId: account.accountId,
    ids: null,
    properties: ["id", "name", "parentId", "role"],
  });
  return objectList(get)
    .filter((mailbox) => typeof mailbox.id === "string")
    .map((mailbox) => ({
      id: mailbox.id as string,
      name: typeof mailbox.name === "string" ? mailbox.name : undefined,
      role: typeof mailbox.role === "string" ? mailbox.role : undefined,
      parentId: typeof mailbox.parentId === "string" || mailbox.parentId === null
        ? mailbox.parentId as string | null
        : undefined,
    }));
}

function mailboxRoleId(mailboxes: MailboxSummary[], role: MailboxRole): string | undefined {
  return mailboxes.find((mailbox) => mailbox.role?.toLowerCase() === role)?.id;
}

function requireMailboxRole(mailboxes: MailboxSummary[], role: MailboxRole): string {
  const id = mailboxRoleId(mailboxes, role);
  if (!id) throw new Error(`No ${role} mailbox is available on this account.`);
  return id;
}

function mailboxIdForLabel(mailboxes: MailboxSummary[], label: string): string | undefined {
  const normalized = label.toLowerCase();
  return mailboxes.find((mailbox) =>
    mailbox.id === label ||
    mailbox.name?.toLowerCase() === normalized ||
    mailbox.role?.toLowerCase() === normalized
  )?.id;
}

function conditionForOperator(
  key: string,
  value: string,
  mailboxes: MailboxSummary[],
): Record<string, unknown> | undefined {
  switch (key.toLowerCase()) {
    case "from":
    case "to":
    case "cc":
    case "bcc":
    case "subject":
    case "body":
    case "text":
      return { [key.toLowerCase()]: value };
    case "after":
    case "newer":
      return { after: normalizeSearchDate(value) };
    case "before":
    case "older":
      return { before: normalizeSearchDate(value) };
    case "larger":
      return { minSize: parseSize(value) };
    case "smaller":
      return { maxSize: parseSize(value) };
    case "has":
      return value.toLowerCase() === "attachment" ? { hasAttachment: true } : undefined;
    case "is":
      return conditionForIs(value);
    case "in":
    case "label": {
      const mailboxId = mailboxIdForLabel(mailboxes, value);
      return mailboxId ? { inMailbox: mailboxId } : undefined;
    }
    case "header": {
      const [name, ...rest] = value.split(":");
      if (!name) return undefined;
      return { header: rest.length ? [name, rest.join(":")] : [name] };
    }
    default:
      return undefined;
  }
}

function conditionForIs(value: string): Record<string, unknown> | undefined {
  switch (value.toLowerCase()) {
    case "read":
      return { hasKeyword: "$seen" };
    case "unread":
      return { notKeyword: "$seen" };
    case "starred":
    case "flagged":
      return { hasKeyword: "$flagged" };
    case "draft":
      return { hasKeyword: "$draft" };
    case "important":
      return { hasKeyword: "$Important" };
    case "answered":
      return { hasKeyword: "$answered" };
    case "forwarded":
      return { hasKeyword: "$Forwarded" };
    default:
      return undefined;
  }
}

function negateCondition(condition: Record<string, unknown>): Record<string, unknown> {
  if (typeof condition.hasKeyword === "string") return { notKeyword: condition.hasKeyword };
  if (typeof condition.notKeyword === "string") return { hasKeyword: condition.notKeyword };
  if (condition.inMailbox) return { inMailboxOtherThan: [condition.inMailbox] };
  return { operator: "NOT", conditions: [condition] };
}

function splitOperator(
  token: string,
): { negated: boolean; key: string; value: string } | undefined {
  const negated = token.startsWith("-");
  const bare = negated ? token.slice(1) : token;
  const separator = bare.indexOf(":");
  if (separator <= 0) return undefined;
  const key = bare.slice(0, separator);
  const value = bare.slice(separator + 1);
  if (!value) return undefined;
  return { negated, key, value };
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of query) {
    if ((char === `"` || char === "'") && !quote) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = undefined;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function normalizeSearchDate(value: string): string {
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(value)) return value.replaceAll("/", "-");
  return value;
}

function parseSize(value: string): number {
  const match = /^(\d+)([kKmMgG])?$/.exec(value);
  if (!match) throw new Error(`Invalid size search value: ${value}`);
  const amount = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (suffix === "k") return amount * 1024;
  if (suffix === "m") return amount * 1024 * 1024;
  if (suffix === "g") return amount * 1024 * 1024 * 1024;
  return amount;
}

function composeToEmail(
  message: ComposeEmail,
  attachments: ComposeAttachment[] | undefined,
  defaults: { mailboxIds: string[]; keywords: Record<string, boolean> },
): Record<string, unknown> {
  const text = message.text_body ?? message.body?.text ?? "";
  const html = message.html_body ?? message.body?.html;
  const body = bodyStructure(text, html, attachments);
  const headers = [
    ...(message.in_reply_to?.length
      ? [{ name: "In-Reply-To", value: message.in_reply_to.join(" ") }]
      : []),
    ...(message.references?.length
      ? [{ name: "References", value: message.references.join(" ") }]
      : []),
    ...Object.entries(message.extra_headers ?? {}).map(([name, value]) => ({ name, value })),
  ];
  return {
    mailboxIds: objectFromIds(message.mailbox_ids ?? defaults.mailboxIds),
    keywords: { ...defaults.keywords, ...(message.keywords ?? {}) },
    ...(message.from ? { from: [message.from] } : {}),
    ...(message.to ? { to: message.to } : {}),
    ...(message.cc ? { cc: message.cc } : {}),
    ...(message.bcc ? { bcc: message.bcc } : {}),
    ...(message.reply_to ? { replyTo: message.reply_to } : {}),
    subject: message.subject,
    sentAt: new Date().toISOString(),
    ...(headers.length ? { headers } : {}),
    bodyStructure: body.structure,
    bodyValues: body.values,
  };
}

function bodyStructure(
  text: string,
  html: string | undefined,
  attachments: ComposeAttachment[] | undefined,
): { structure: Record<string, unknown>; values: Record<string, unknown> } {
  const values: Record<string, unknown> = {};
  const bodyParts: Record<string, unknown>[] = [];
  values.text = { value: text };
  bodyParts.push({
    partId: "text",
    type: "text/plain",
    charset: "utf-8",
    disposition: "inline",
  });
  if (html) {
    values.html = { value: html };
    bodyParts.push({
      partId: "html",
      type: "text/html",
      charset: "utf-8",
      disposition: "inline",
    });
  }
  const messageBody = bodyParts.length === 1
    ? bodyParts[0]
    : { type: "multipart/alternative", subParts: bodyParts };
  const attachmentParts = (attachments ?? []).map((attachment, index) => ({
    partId: `attachment${index}`,
    blobId: attachment.blobId,
    type: attachment.type,
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.cid ? { cid: attachment.cid } : {}),
    disposition: attachment.disposition ?? "attachment",
  }));
  if (!attachmentParts.length) return { structure: messageBody, values };
  return {
    structure: {
      type: "multipart/mixed",
      subParts: [messageBody, ...attachmentParts],
    },
    values,
  };
}

function sentEmailPatch(mailboxes: MailboxSummary[]): Record<string, unknown> {
  const patch: Record<string, unknown> = { "keywords/$draft": null, "keywords/$seen": true };
  const draftsId = mailboxRoleId(mailboxes, "drafts");
  const sentId = mailboxRoleId(mailboxes, "sent");
  if (draftsId) patch[`mailboxIds/${draftsId}`] = null;
  if (sentId) patch[`mailboxIds/${sentId}`] = true;
  return patch;
}

async function resolveIdentityId(
  context: ToolContext,
  account: AccountContext,
  requestedIdentityId?: string,
): Promise<string> {
  if (requestedIdentityId) return requestedIdentityId;
  const identityGet = await context.jmap.single(account, SUBMISSION_USING, "Identity/get", {
    accountId: account.accountId,
    ids: null,
  });
  const first = objectList(identityGet).find((identity) => typeof identity.id === "string");
  if (!first?.id || typeof first.id !== "string") {
    throw new Error("No JMAP identity is available for sending.");
  }
  return first.id;
}

async function guardedEmailSet(
  context: ToolContext,
  account: AccountContext,
  args: {
    toolName: string;
    operation: "delete" | "update" | "send" | "move" | "create";
    resourceIds: string[];
    payload: Record<string, unknown>;
    summary: string;
    confirmFingerprint?: string;
    confirmExpiresAt?: string;
    ifInState?: string;
  },
): Promise<unknown> {
  const guard = await requireMutationConfirmation(context, {
    toolName: args.toolName,
    accountId: account.accountId,
    operation: args.operation,
    resourceKind: "Email",
    resourceIds: args.resourceIds,
    payload: args.payload,
    precondition: args.ifInState ? { ifInState: args.ifInState } : undefined,
    summary: args.summary,
    confirmFingerprint: args.confirmFingerprint,
    confirmExpiresAt: args.confirmExpiresAt,
  });
  if (guard) return guard;
  return await context.jmap.single(account, MAIL_USING, "Email/set", args.payload);
}

async function batchEmailGet(
  context: ToolContext,
  account: AccountContext,
  emailIds: string[],
  properties?: string[],
): Promise<Record<string, unknown>> {
  const list: unknown[] = [];
  const notFound: string[] = [];
  let state: unknown;
  for (const ids of chunks(unique(emailIds), 500)) {
    const get = await context.jmap.single(account, MAIL_USING, "Email/get", {
      accountId: account.accountId,
      ids,
      ...(properties ? { properties } : {}),
    });
    list.push(...objectList(get));
    notFound.push(...asStringArray(get.notFound));
    state = get.state ?? state;
  }
  return { accountId: account.accountId, state, list, notFound };
}

async function threadIdForEmail(
  context: ToolContext,
  account: AccountContext,
  emailId: string,
): Promise<string> {
  const get = await context.jmap.single(account, MAIL_USING, "Email/get", {
    accountId: account.accountId,
    ids: [emailId],
    properties: ["threadId"],
  });
  const email = firstListedObject(get);
  if (!email || typeof email.threadId !== "string") {
    throw new Error(`Email ${emailId} was not found or did not have a threadId.`);
  }
  return email.threadId;
}

async function downloadBlob(
  account: AccountContext,
  blobId: string,
  args: {
    as: "bytes" | "base64" | "text";
    maxBytes?: number;
    filename?: string;
    contentType?: string;
  },
): Promise<Record<string, unknown>> {
  const url = buildDownloadUrl(
    account.session.downloadUrl,
    account.accountId,
    blobId,
    args.filename,
    args.contentType,
  );
  if (!url) throw new Error("JMAP session did not include a downloadUrl.");
  const headers: Record<string, string> = { Authorization: account.auth.authorization };
  if (args.maxBytes) headers.Range = `bytes=0-${args.maxBytes - 1}`;
  const response = await fetch(url, { headers });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Blob download failed: HTTP ${response.status}`);
  }
  let bytes = new Uint8Array(await response.arrayBuffer());
  let truncated = response.status === 206;
  if (args.maxBytes && bytes.length > args.maxBytes) {
    bytes = bytes.slice(0, args.maxBytes);
    truncated = true;
  }
  const base = {
    bytes: bytes.length,
    truncated,
    contentType: response.headers.get("content-type") ?? undefined,
  };
  if (args.as === "text") {
    return { ...base, text: new TextDecoder().decode(bytes) };
  }
  return { ...base, contentBase64: bytesToBase64(bytes) };
}

function buildDownloadUrl(
  template: string | undefined,
  accountId: string,
  blobId: string,
  filename?: string,
  contentType?: string,
): string | undefined {
  if (!template) return undefined;
  return template
    .replaceAll("{accountId}", encodeURIComponent(accountId))
    .replaceAll("{blobId}", encodeURIComponent(blobId))
    .replaceAll("{name}", encodeURIComponent(filename ?? blobId))
    .replaceAll("{type}", encodeURIComponent(contentType ?? "application/octet-stream"));
}

function findEmailPart(
  email: Record<string, unknown>,
  blobId?: string,
  partId?: string,
): Record<string, unknown> | undefined {
  const parts = [
    ...flattenParts(email.bodyStructure),
    ...asObjectArray(email.attachments),
  ];
  return parts.find((part) =>
    (blobId && part.blobId === blobId) || (partId && part.partId === partId)
  );
}

function flattenParts(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const part = value as Record<string, unknown>;
  return [part, ...asObjectArray(part.subParts).flatMap(flattenParts)];
}

function forwardedBody(original: Record<string, unknown>, note?: ComposeBody): string {
  const chunks: string[] = [];
  if (note?.text) chunks.push(note.text.trim());
  const from = addressList(original.from).join(", ");
  const to = addressList(original.to).join(", ");
  const sentAt = typeof original.sentAt === "string" ? original.sentAt : "";
  const subject = typeof original.subject === "string" ? original.subject : "";
  chunks.push(
    [
      "---------- Forwarded message ---------",
      from ? `From: ${from}` : undefined,
      sentAt ? `Date: ${sentAt}` : undefined,
      subject ? `Subject: ${subject}` : undefined,
      to ? `To: ${to}` : undefined,
      "",
      plainBodyPreview(original),
    ].filter((line) => line !== undefined).join("\n"),
  );
  return chunks.filter(Boolean).join("\n\n");
}

function plainBodyPreview(email: Record<string, unknown>): string {
  const bodyValues = email.bodyValues;
  const textParts = asObjectArray(email.textBody);
  if (bodyValues && typeof bodyValues === "object") {
    for (const part of textParts) {
      const partId = typeof part.partId === "string" ? part.partId : undefined;
      const value = partId ? (bodyValues as Record<string, unknown>)[partId] : undefined;
      if (
        value && typeof value === "object" &&
        typeof (value as Record<string, unknown>).value === "string"
      ) {
        return (value as Record<string, string>).value;
      }
    }
  }
  return typeof email.preview === "string" ? email.preview : "";
}

function addressList(value: unknown): string[] {
  return asObjectArray(value)
    .map((address) => {
      const email = typeof address.email === "string" ? address.email : "";
      const name = typeof address.name === "string" ? address.name : "";
      return name && email ? `${name} <${email}>` : email || name;
    })
    .filter(Boolean);
}

function methodResponse(
  response: { methodResponses?: [string, Record<string, unknown>, string][] },
  callId: string,
): Record<string, unknown> {
  const found = response.methodResponses?.find(([, , id]) => id === callId);
  if (!found) throw new Error(`JMAP response did not include call id ${callId}.`);
  if (found[0] === "error") {
    throw new Error(
      `JMAP ${callId} error: ${found[1].type ?? "unknown"} ${found[1].description ?? ""}`,
    );
  }
  return found[1];
}

function objectList(value: Record<string, unknown>): Record<string, unknown>[] {
  return asObjectArray(value.list);
}

function firstListedObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  return objectList(value)[0];
}

function asObjectArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
    )
    : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

function objectKeys(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function objectFromIds(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

function combineFilters(
  ...filters: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const present = filters.filter((filter): filter is Record<string, unknown> =>
    !!filter && Object.keys(filter).length > 0
  );
  if (!present.length) return {};
  if (present.length === 1) return present[0];
  return { operator: "AND", conditions: present };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) ||
    "forwarded";
}
