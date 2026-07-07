import { load } from "@std/dotenv";

interface FetchConfig {
  baseUrl: string;
  bearer: string;
  outDir: string;
}

await main();

async function main(): Promise<void> {
  await load({ export: true });
  const config = loadFetchConfig();
  await Deno.mkdir(config.outDir, { recursive: true });

  const session = await getJson(config, "/jmap/session");
  await writeJson(`${config.outDir}/jmap-session.json`, session);
  await writeJson(`${config.outDir}/jmap-capabilities.json`, summarizeSessionCapabilities(session));

  const apiAccount = await getJson(config, "/api/account");
  await writeJson(`${config.outDir}/api-account.json`, apiAccount);

  const schema = await getJson(config, "/api/schema");
  await writeJson(`${config.outDir}/stalwart-config-schema.json`, schema);

  const manifest = {
    generatedAt: new Date().toISOString(),
    baseUrl: config.baseUrl,
    files: [
      "jmap-session.json",
      "jmap-capabilities.json",
      "api-account.json",
      "stalwart-config-schema.json",
    ],
  };
  await writeJson(`${config.outDir}/manifest.json`, manifest);
  console.log(`Wrote live schemas to ${config.outDir}`);
}

function loadFetchConfig(): FetchConfig {
  const baseUrl = (Deno.env.get("STALWART_BASE_URL") ?? "https://mail.astrius.ink").replace(
    /\/+$/,
    "",
  );
  const bearer = Deno.env.get("STALWART_BEARER") ?? Deno.env.get("TEST_BEARER");
  if (!bearer) throw new Error("Set STALWART_BEARER or TEST_BEARER in .env");
  return {
    baseUrl,
    bearer,
    outDir: Deno.env.get("SCHEMA_OUT_DIR") ?? "schemas/live",
  };
}

async function getJson(config: FetchConfig, path: string): Promise<unknown> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.bearer}` },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`GET ${path} failed: HTTP ${response.status}`);
  return await response.json();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function summarizeSessionCapabilities(session: unknown): Record<string, unknown> {
  const value = session as {
    capabilities?: Record<string, unknown>;
    accounts?: Record<string, { accountCapabilities?: Record<string, unknown> }>;
    primaryAccounts?: Record<string, string>;
  };
  return {
    capabilities: Object.keys(value.capabilities ?? {}).sort(),
    primaryAccounts: value.primaryAccounts ?? {},
    accounts: Object.fromEntries(
      Object.entries(value.accounts ?? {}).map(([accountId, account]) => [
        accountId,
        Object.keys(account.accountCapabilities ?? {}).sort(),
      ]),
    ),
  };
}
