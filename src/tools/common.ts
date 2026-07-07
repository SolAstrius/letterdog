import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { ToolExtra } from "../auth.ts";
import type { EnvConfig } from "../config.ts";
import { errorResult, jsonResult } from "../mcp_result.ts";
import type { ToolContext } from "../server/context.ts";
import { buildToolContext } from "../server/context.ts";
import { confirmationChallenge, verifyConfirmation } from "../safety.ts";

export const accountIdSchema = z.string().optional().describe("Optional JMAP account id.");
export const propertiesSchema = z.array(z.string()).optional();
export const idsSchema = z.array(z.string()).min(1);
export const objectSchema = z.record(z.string(), z.unknown());
export const confirmSchema = {
  confirmFingerprint: z.string().optional(),
  confirmExpiresAt: z.string().optional(),
};

export type Handler<T> = (args: T, extra: ToolExtra) => Promise<unknown>;
export type ToolArgs<T extends z.ZodRawShape> = z.output<z.ZodObject<T>>;

export function registerJsonTool<T extends z.ZodRawShape>(
  server: McpServer,
  config: EnvConfig,
  name: string,
  description: string,
  inputSchema: T,
  handler: (
    args: ToolArgs<T>,
    context: Awaited<ReturnType<typeof buildToolContext>>,
    extra: ToolExtra,
  ) => Promise<unknown>,
): void {
  server.registerTool(
    name,
    { description, inputSchema },
    async (args: ToolArgs<T>, extra: ToolExtra) => {
      try {
        const context = await buildToolContext(config, extra);
        return jsonResult(await handler(args, context, extra));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );
}

export async function requireMutationConfirmation(
  context: ToolContext,
  input: {
    toolName: string;
    accountId: string;
    operation: "delete" | "update" | "send" | "move" | "admin" | "create";
    resourceKind: string;
    resourceIds: string[];
    payload: unknown;
    summary: string;
    precondition?: Record<string, unknown>;
    confirmFingerprint?: string;
    confirmExpiresAt?: string;
  },
) {
  const intent = {
    toolName: input.toolName,
    accountId: input.accountId,
    operation: input.operation,
    resourceKind: input.resourceKind,
    resourceIds: input.resourceIds,
    payload: input.payload,
    precondition: input.precondition,
  };

  if (!input.confirmFingerprint) {
    return await confirmationChallenge(context.config, context.actor, intent, input.summary);
  }

  if (!input.confirmExpiresAt) {
    throw new Error("confirmExpiresAt is required with confirmFingerprint");
  }

  await verifyConfirmation(
    context.config,
    context.actor,
    intent,
    input.confirmFingerprint,
    input.confirmExpiresAt,
  );

  return undefined;
}

export function setArgs(
  accountId: string,
  args: {
    create?: Record<string, unknown>;
    update?: Record<string, unknown>;
    destroy?: string[];
    ifInState?: string;
    extra?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    accountId,
    ...(args.ifInState ? { ifInState: args.ifInState } : {}),
    ...(args.create ? { create: args.create } : {}),
    ...(args.update ? { update: args.update } : {}),
    ...(args.destroy ? { destroy: args.destroy } : {}),
    ...(args.extra ?? {}),
  };
}
