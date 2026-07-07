import { load } from "@std/dotenv";

export interface EnvConfig {
  stalwartBaseUrl: string;
  fallbackBearer?: string;
  fallbackAuthorization?: string;
  allowEnvBearerFallback: boolean;
  confirmationSecret: string;
  defaultAccountId?: string;
  transport: "http" | "stdio";
  port: number;
  enableAdminTools: boolean;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export async function loadConfig(): Promise<EnvConfig> {
  await load({ export: true });

  const stalwartBaseUrl = Deno.env.get("STALWART_BASE_URL") ?? "https://mail.astrius.ink";
  const transport = (Deno.env.get("MCP_TRANSPORT") ?? "http") === "stdio" ? "stdio" : "http";
  const fallbackBearer = Deno.env.get("STALWART_BEARER") || Deno.env.get("TEST_BEARER") ||
    undefined;
  const fallbackAuthorization = Deno.env.get("STALWART_AUTHORIZATION") ||
    (fallbackBearer ? `Bearer ${fallbackBearer}` : undefined);
  const allowEnvBearerFallback = (Deno.env.get("STALWART_ALLOW_ENV_BEARER_FALLBACK") ??
    (transport === "stdio" ? "true" : "false")) ===
    "true";

  const configuredSecret = Deno.env.get("MCP_CONFIRMATION_SECRET") ||
    Deno.env.get("CONFIRMATION_SECRET");
  const confirmationSecret = configuredSecret || randomSecret();

  if (!configuredSecret) {
    console.warn(
      "MCP confirmation secret was not configured; generated an in-memory dev secret.",
    );
  }

  return {
    stalwartBaseUrl: trimSlash(stalwartBaseUrl),
    fallbackBearer,
    fallbackAuthorization,
    allowEnvBearerFallback,
    confirmationSecret,
    defaultAccountId: Deno.env.get("STALWART_DEFAULT_ACCOUNT_ID") || undefined,
    transport,
    port: Number(Deno.env.get("PORT") ?? "8787"),
    enableAdminTools: (Deno.env.get("ENABLE_ADMIN_TOOLS") ?? "false") === "true",
  };
}
