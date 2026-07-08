/**
 * Letterdog v2 environment configuration. REAL implementation (architect-owned; builders do not
 * edit — request contract changes via the coordinator).
 *
 * Env vars:
 * - STALWART_BASE_URL          base URL of the JMAP server (default https://mail.astrius.ink)
 * - CONFIRM_POLICY             strict | balanced | minimal (default balanced; personal deploy
 *                              runs minimal). See docs/v2-design.md "Confirmation policy".
 * - CONFIRMATION_SECRET        HMAC secret for confirm tokens (fallback: MCP_CONFIRMATION_SECRET;
 *                              then a load-or-create per-user secret file at
 *                              $XDG_CONFIG_HOME|~/.config/letterdog/confirm_secret so separate CLI
 *                              invocations can verify each other's tokens; a random in-memory dev
 *                              secret — tokens die with the process — only when the file is
 *                              unreachable, e.g. the sandboxed server's --allow-read=.env)
 * - ENABLE_ADMIN_TOOLS         "true" to register admin.* / sieve.* ops (default false)
 * - ENABLE_SYNC_TOOLS          "true" to register sync.* ops (default false)
 * - SESSION_CACHE_TTL_MS       JMAP session cache TTL per actor (default 60000)
 * - MAILBOX_CACHE_TTL_MS       mailbox id→role/name resolution cache TTL (default 300000)
 * - STALWART_BEARER / STALWART_AUTHORIZATION / STALWART_ALLOW_ENV_BEARER_FALLBACK /
 *   STALWART_DEFAULT_ACCOUNT_ID / MCP_TRANSPORT / PORT — same semantics as v1 (src/config.ts).
 *
 * NOTE: V2Config is deliberately a structural superset of v1 `EnvConfig` so the v1 `CalDavClient`
 * (src/caldav.ts) can be constructed with a V2Config unchanged.
 */
import { load } from "@std/dotenv";

export type ConfirmPolicy = "strict" | "balanced" | "minimal";

export interface V2Config {
  stalwartBaseUrl: string;
  confirmPolicy: ConfirmPolicy;
  confirmationSecret: string;
  enableAdminTools: boolean;
  enableSyncTools: boolean;
  /** JMAP session cache TTL, per actor fingerprint. */
  sessionCacheTtlMs: number;
  /** Mailbox/calendar name-resolution cache TTL, per account. */
  mailboxCacheTtlMs: number;
  fallbackBearer?: string;
  fallbackAuthorization?: string;
  allowEnvBearerFallback: boolean;
  defaultAccountId?: string;
  transport: "http" | "stdio";
  port: number;
}

const CONFIRM_POLICIES: readonly ConfirmPolicy[] = ["strict", "balanced", "minimal"];

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Resolve the confirm-token HMAC secret: env → persisted per-user secret file → in-memory.
 *
 * The file tier exists for the CLI: the --dry-run → --confirm flow spans two processes, so a
 * per-process random secret can never verify the first invocation's token (and the only
 * workaround — the caller exporting an ad-hoc CONFIRMATION_SECRET — is indistinguishable from an
 * agent self-approving a gated mutation). Load-or-create keeps the secret machine-local with no
 * ceremony. Surfaces without the needed grants (the deployed server runs --allow-read=.env and no
 * --allow-write) fall through to the in-memory secret, which still works there: the server is
 * long-lived, so both token phases hit the same process. Set CONFIRMATION_SECRET in the
 * deployment to keep tokens valid across restarts.
 */
async function resolveConfirmationSecret(): Promise<string> {
  const fromEnv = Deno.env.get("CONFIRMATION_SECRET") || Deno.env.get("MCP_CONFIRMATION_SECRET");
  if (fromEnv) return fromEnv;

  try {
    const home = Deno.env.get("HOME");
    const configHome = Deno.env.get("XDG_CONFIG_HOME") || (home ? `${home}/.config` : undefined);
    if (configHome) {
      const dir = `${configHome}/letterdog`;
      const file = `${dir}/confirm_secret`;
      try {
        const existing = (await Deno.readTextFile(file)).trim();
        if (existing.length >= 32) return existing;
        console.warn(`Ignoring ${file}: secret shorter than 32 chars.`);
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
        const secret = randomSecret();
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
        await Deno.writeTextFile(file, secret + "\n", { mode: 0o600 });
        console.warn(`Generated persistent confirmation secret at ${file}.`);
        return secret;
      }
    }
  } catch {
    // Missing read/write permission or unwritable home — fall through to the in-memory secret.
  }

  console.warn(
    "Confirmation secret not configured; generated an in-memory dev secret (confirm tokens die " +
      "with this process).",
  );
  return randomSecret();
}

function intEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  return raw === "true";
}

export async function loadV2Config(): Promise<V2Config> {
  await load({ export: true });

  const transport = (Deno.env.get("MCP_TRANSPORT") ?? "http") === "stdio" ? "stdio" : "http";
  const fallbackBearer = Deno.env.get("STALWART_BEARER") || Deno.env.get("TEST_BEARER") ||
    undefined;
  const fallbackAuthorization = Deno.env.get("STALWART_AUTHORIZATION") ||
    (fallbackBearer ? `Bearer ${fallbackBearer}` : undefined);
  const allowEnvBearerFallback = (Deno.env.get("STALWART_ALLOW_ENV_BEARER_FALLBACK") ??
    (transport === "stdio" ? "true" : "false")) === "true";

  const rawPolicy = Deno.env.get("CONFIRM_POLICY") ?? "balanced";
  const confirmPolicy: ConfirmPolicy = (CONFIRM_POLICIES as readonly string[]).includes(rawPolicy)
    ? rawPolicy as ConfirmPolicy
    : "balanced";
  if (confirmPolicy !== rawPolicy) {
    console.warn(
      `CONFIRM_POLICY="${rawPolicy}" is not one of ${CONFIRM_POLICIES.join("|")}; ` +
        `falling back to "balanced".`,
    );
  }

  const confirmationSecret = await resolveConfirmationSecret();

  return {
    stalwartBaseUrl: trimSlash(Deno.env.get("STALWART_BASE_URL") ?? "https://mail.astrius.ink"),
    confirmPolicy,
    confirmationSecret,
    enableAdminTools: boolEnv("ENABLE_ADMIN_TOOLS", false),
    enableSyncTools: boolEnv("ENABLE_SYNC_TOOLS", false),
    sessionCacheTtlMs: intEnv("SESSION_CACHE_TTL_MS", 60_000),
    mailboxCacheTtlMs: intEnv("MAILBOX_CACHE_TTL_MS", 300_000),
    fallbackBearer,
    fallbackAuthorization,
    allowEnvBearerFallback,
    defaultAccountId: Deno.env.get("STALWART_DEFAULT_ACCOUNT_ID") || undefined,
    transport,
    port: Number(Deno.env.get("PORT") ?? "8787"),
  };
}
