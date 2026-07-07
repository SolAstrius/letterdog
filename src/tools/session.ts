import { z } from "zod";
import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import { registerJsonTool } from "./common.ts";

export function registerSessionTools(server: McpServer, config: EnvConfig): void {
  registerJsonTool(
    server,
    config,
    "stalwart_session_info",
    "Read the live Stalwart JMAP session document and optionally management account details.",
    {
      includeApiAccount: z.boolean().optional(),
    },
    async (args, context) => {
      const session = await context.jmap.getSession(context.actor.auth);
      const apiAccount = args.includeApiAccount
        ? await fetchApiAccount(config, context.actor.auth.bearer)
        : undefined;
      return {
        baseUrl: config.stalwartBaseUrl,
        authSource: context.actor.auth.source,
        session,
        ...(apiAccount ? { apiAccount } : {}),
      };
    },
  );

  registerJsonTool(
    server,
    config,
    "stalwart_account_resolve",
    "Resolve the account id that will be used for a given JMAP capability.",
    {
      capability: z.string().optional(),
      account_id: z.string().optional(),
    },
    async (args, context) => {
      const account = await context.jmap.resolveAccount(
        context.actor,
        args.capability,
        args.account_id,
      );
      return {
        accountId: account.accountId,
        capability: args.capability,
        account: account.session.accounts[account.accountId],
        apiUrl: account.apiUrl,
      };
    },
  );
}

async function fetchApiAccount(config: EnvConfig, bearer: string): Promise<unknown> {
  const response = await fetch(`${config.stalwartBaseUrl}/api/account`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!response.ok) {
    throw new Error(`Management account lookup failed: HTTP ${response.status}`);
  }
  return await response.json();
}
