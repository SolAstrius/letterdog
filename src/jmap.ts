import { CAPABILITIES } from "./constants.ts";
import type { ActorContext } from "./auth.ts";
import type { EnvConfig } from "./config.ts";

export interface JmapSession {
  apiUrl: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  state?: string;
  capabilities: Record<string, unknown>;
  accounts: Record<string, JmapAccount>;
  primaryAccounts: Record<string, string>;
}

export interface JmapAccount {
  name?: string;
  isPersonal?: boolean;
  isReadOnly?: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface AccountContext {
  accountId: string;
  capability?: string;
  session: JmapSession;
  apiUrl: string;
  auth: ActorContext["auth"];
}

export interface JmapInvocation {
  using: string[];
  methodCalls: [string, Record<string, unknown>, string][];
}

export interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][];
  sessionState?: string;
}

export class JmapClient {
  constructor(private readonly config: EnvConfig) {}

  async getSession(auth: ActorContext["auth"]): Promise<JmapSession> {
    const response = await fetch(`${this.config.stalwartBaseUrl}/jmap/session`, {
      headers: { Authorization: auth.authorization },
    });
    if (!response.ok) {
      throw new Error(`JMAP session failed: HTTP ${response.status}`);
    }
    return await response.json() as JmapSession;
  }

  async resolveAccount(
    actor: ActorContext,
    requiredCapability?: string,
    requestedAccountId?: string,
  ): Promise<AccountContext> {
    const session = await this.getSession(actor.auth);
    const accountId = requestedAccountId ||
      (requiredCapability ? session.primaryAccounts?.[requiredCapability] : undefined) ||
      this.config.defaultAccountId ||
      firstAccountWithCapability(session, requiredCapability);

    if (!accountId || !session.accounts?.[accountId]) {
      throw new Error(`No JMAP account found for capability ${requiredCapability ?? "(any)"}`);
    }

    if (requiredCapability) {
      const account = session.accounts[accountId];
      if (!account.accountCapabilities?.[requiredCapability]) {
        throw new Error(`Account ${accountId} lacks capability ${requiredCapability}`);
      }
    }

    return {
      accountId,
      capability: requiredCapability,
      session,
      apiUrl: session.apiUrl || `${this.config.stalwartBaseUrl}/jmap/`,
      auth: actor.auth,
    };
  }

  async call(context: AccountContext, invocation: JmapInvocation): Promise<JmapResponse> {
    const response = await fetch(context.apiUrl, {
      method: "POST",
      headers: {
        Authorization: context.auth.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(invocation),
    });
    if (!response.ok) {
      throw new Error(`JMAP call failed: HTTP ${response.status}`);
    }
    return await response.json() as JmapResponse;
  }

  async single(
    context: AccountContext,
    using: string[],
    method: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.call(context, {
      using,
      methodCalls: [[method, args, "c1"]],
    });
    const first = response.methodResponses?.[0];
    if (!first) throw new Error("JMAP response did not include methodResponses");
    if (first[0] === "error") {
      throw new Error(
        `JMAP ${method} error: ${first[1].type ?? "unknown"} ${first[1].description ?? ""}`,
      );
    }
    return first[1];
  }
}

function firstAccountWithCapability(session: JmapSession, capability?: string): string | undefined {
  for (const [accountId, account] of Object.entries(session.accounts ?? {})) {
    if (!capability || account.accountCapabilities?.[capability]) return accountId;
  }
  return undefined;
}

export const CALENDAR_USING = [CAPABILITIES.core, CAPABILITIES.calendars];
export const MAIL_USING = [CAPABILITIES.core, CAPABILITIES.mail];
export const MAIL_BLOB_USING = [CAPABILITIES.core, CAPABILITIES.mail, CAPABILITIES.blob];
export const SUBMISSION_USING = [
  CAPABILITIES.core,
  CAPABILITIES.mail,
  CAPABILITIES.submission,
];
export const CALENDAR_PARSE_USING = [
  CAPABILITIES.core,
  CAPABILITIES.calendars,
  CAPABILITIES.calendarsParse,
];
export const PRINCIPAL_USING = [
  CAPABILITIES.core,
  CAPABILITIES.principals,
  CAPABILITIES.principalsAvailability,
  CAPABILITIES.calendars,
];
export const BLOB_USING = [CAPABILITIES.core, CAPABILITIES.blob];
export const FILE_USING = [CAPABILITIES.core, CAPABILITIES.fileNode];
export const STALWART_USING = [CAPABILITIES.core, CAPABILITIES.stalwart];
