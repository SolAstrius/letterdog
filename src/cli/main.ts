/**
 * CLI frontend: `letterdog` — compiles ALL ops into subcommands (+ --help) from the registry.
 * Owner: builder B11-frontends.
 *
 * Mapping: op.name "mail.search" → `letterdog mail search`. Flags derived from op.input:
 * strings/enums → `--flag value`; numbers → `--flag N`; booleans → `--flag` (presence);
 * arrays → repeated `--flag a --flag b` OR comma-separated `--flag a,b`; objects/records → JSON
 * (`--filter '{…}'`). Trailing positionals map to `ids` (when the op takes an `ids` array);
 * `-` reads ids from stdin (one per line — pipe from a search).
 *
 * Output: human tables on a TTY; `--json` (NDJSON for lists) = brief projection; `--json=full|raw`
 * for more. Agents piping get stable JSON by default.
 *
 * Auth: STALWART_BEARER env (launchctl) / --url / --account → Actor{source:"env"|"flag"}.
 * Safety: reads just run; outward sends need `--yes`; destructive/blast need `--confirm <token>`
 * from a dry run (same HMAC core as MCP — core/safety.ts). `--dry-run` sends the call with no
 * confirm token and prints the returned challenge (preview + token). Gating: admin./sieve. need
 * ENABLE_ADMIN_TOOLS, sync. need ENABLE_SYNC_TOOLS.
 *
 * Exit codes: 0 ok, 1 error, 2 partial (envelope carried `failed`).
 */
import { parseArgs } from "@std/cli/parse-args";
import { z } from "zod";

import { loadV2Config } from "../core/config.ts";
import type { V2Config } from "../core/config.ts";
import { allOps } from "../core/ops/index.ts";
import { opByName, registeredOps } from "../core/ops/registry.ts";
import type { Actor, OpContext, OpDefinition } from "../core/ops/registry.ts";
import { JmapClient } from "../core/jmap/client.ts";
import { CalDavClient } from "../../src/caldav.ts";
import { stalwartProvider } from "../core/provider/stalwart.ts";
import { actorFingerprint } from "../core/safety.ts";
import { isConfirmChallenge, isEnvelope, renderResult, resolveOutputMode } from "./render.ts";

const BIN = "letterdog";

// --- zod shape introspection --------------------------------------------------------------------

type FlagKind = "string" | "number" | "boolean" | "array" | "json" | "enum";

interface FlagSpec {
  name: string;
  kind: FlagKind;
  required: boolean;
  description?: string;
  enumValues?: string[];
}

// deno-lint-ignore no-explicit-any
function zdef(schema: any): any {
  return schema?.def ?? schema?._def;
}

// deno-lint-ignore no-explicit-any
function unwrap(schema: any): { inner: any; required: boolean; description?: string } {
  let cur = schema;
  let required = true;
  let description: string | undefined;
  for (let i = 0; i < 12; i++) {
    const def = zdef(cur);
    const desc = def?.description ?? cur?.description;
    if (typeof desc === "string" && !description) description = desc;
    const type = def?.type;
    if (type === "optional" || type === "default" || type === "nullable" || type === "readonly") {
      if (type === "optional" || type === "default" || type === "nullable") required = false;
      cur = def?.innerType ?? cur;
      if (cur === undefined) break;
    } else {
      break;
    }
  }
  return { inner: cur, required, description };
}

// deno-lint-ignore no-explicit-any
function flagKind(inner: any): { kind: FlagKind; enumValues?: string[] } {
  const type = zdef(inner)?.type;
  switch (type) {
    case "string":
      return { kind: "string" };
    case "number":
    case "bigint":
      return { kind: "number" };
    case "boolean":
      return { kind: "boolean" };
    case "array":
      return { kind: "array" };
    case "enum": {
      const def = zdef(inner);
      const entries = def?.entries ?? def?.values;
      const values = entries
        ? (Array.isArray(entries) ? entries : Object.values(entries)).map(String)
        : undefined;
      return { kind: "enum", enumValues: values };
    }
    default:
      // records, objects, literals, unions → carried as JSON blobs.
      return { kind: "json" };
  }
}

/** Derive a flag spec list from an op's Zod raw shape (snake_case arg names → --kebab flags). */
function flagsForOp(op: OpDefinition): FlagSpec[] {
  const specs: FlagSpec[] = [];
  for (const [name, schema] of Object.entries(op.input)) {
    const { inner, required, description } = unwrap(schema);
    const { kind, enumValues } = flagKind(inner);
    specs.push({ name, kind, required, description, enumValues });
  }
  return specs;
}

function flagName(arg: string): string {
  return arg.replaceAll("_", "-");
}

// --- argument assembly --------------------------------------------------------------------------

/** Build the op's parsed args object from CLI flags + trailing positionals + stdin ids. */
async function buildArgs(
  op: OpDefinition,
  // deno-lint-ignore no-explicit-any
  parsed: Record<string, any>,
  positionals: string[],
  argvTokens: string[],
): Promise<Record<string, unknown>> {
  const specs = flagsForOp(op);
  const byName = new Map(specs.map((s) => [s.name, s]));
  const out: Record<string, unknown> = {};

  for (const spec of specs) {
    const flag = flagName(spec.name);
    const raw = parsed[flag] ?? parsed[spec.name];
    if (raw === undefined) continue;
    // parseArgs `collect` yields [] for array flags that were never passed — treat as absent so
    // schema defaults (e.g. the sort order) still apply.
    if (spec.kind === "array" && Array.isArray(raw) && raw.length === 0) continue;
    // parseArgs sets declared booleans to false when absent; only pass a boolean the operator
    // actually typed, so schema defaults (e.g. include_contacts default true) still apply.
    if (spec.kind === "boolean" && !flagPresent(argvTokens, flag)) continue;
    out[spec.name] = coerce(spec, raw);
  }

  // Trailing positionals (and stdin via "-") feed an `ids` array when the op declares one.
  if (byName.has("ids")) {
    const ids = await resolveIds(positionals);
    if (ids.length > 0) out.ids = ids;
  } else if (byName.has("query") && out.query === undefined && positionals.length > 0) {
    // Query-taking ops (mail.search, people.search, …): positionals form the query string.
    out.query = positionals.join(" ");
  }

  return out;
}

// deno-lint-ignore no-explicit-any
function coerce(spec: FlagSpec, raw: any): unknown {
  switch (spec.kind) {
    case "number":
      return Array.isArray(raw) ? Number(raw[raw.length - 1]) : Number(raw);
    case "boolean":
      return raw === true || raw === "true";
    case "array":
      return toArray(raw);
    case "json":
      return parseJsonFlag(raw);
    case "enum":
    case "string":
    default:
      return Array.isArray(raw) ? String(raw[raw.length - 1]) : String(raw);
  }
}

// deno-lint-ignore no-explicit-any
function toArray(raw: any): unknown[] {
  const values = Array.isArray(raw) ? raw : [raw];
  // JSON-looking values (array-of-object flags like --sort '{"property":…}') are parsed whole —
  // never comma-split. Plain values support both repeated flags and comma-separated lists.
  return values.flatMap((v) => {
    const text = String(v).trim();
    if (text.startsWith("{") || text.startsWith("[")) {
      const parsed = parseJsonFlag(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    return text.split(",").map((s) => s.trim()).filter(Boolean);
  });
}

// deno-lint-ignore no-explicit-any
function parseJsonFlag(raw: any): unknown {
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Expected a JSON value: ${value}`);
  }
}

/** Whether a flag (or its --no- negation) literally appears on the command line. */
function flagPresent(argvTokens: string[], flag: string): boolean {
  return argvTokens.some((t) =>
    t === `--${flag}` || t.startsWith(`--${flag}=`) ||
    t === `--no-${flag}` || t.startsWith(`--no-${flag}=`)
  );
}

/**
 * Resolve trailing ids; a lone "-" pulls one id per non-empty stdin line. Lines may be bare ids
 * or JSON-quoted strings (the NDJSON emitted by `… --ids-only --json`), so pipelines compose
 * without a `tr -d '"'` step.
 */
async function resolveIds(positionals: string[]): Promise<string[]> {
  if (positionals.length === 1 && positionals[0] === "-") {
    const text = new TextDecoder().decode(await readAll(Deno.stdin.readable));
    return text.split("\n").map((l) => unquoteId(l.trim())).filter(Boolean);
  }
  return positionals.filter((p) => p !== "-");
}

/** Strip one layer of JSON string quoting from a piped id line ("abc" → abc). */
function unquoteId(line: string): string {
  if (line.length >= 2 && line.startsWith('"') && line.endsWith('"')) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "string") return parsed;
    } catch {
      // fall through — treat as a literal id.
    }
  }
  return line;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// --- auth ---------------------------------------------------------------------------------------

function parseBearerHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

/** Resolve auth for a CLI invocation: --bearer-env override or STALWART_BEARER; source "flag"/"env". */
async function cliActor(
  config: V2Config,
  // deno-lint-ignore no-explicit-any
  parsed: Record<string, any>,
): Promise<Actor> {
  const envName = typeof parsed["bearer-env"] === "string" ? parsed["bearer-env"] : undefined;
  const source: Actor["source"] = envName ? "flag" : "env";
  const bearer = (envName ? Deno.env.get(envName) : undefined) ??
    Deno.env.get("STALWART_BEARER") ?? config.fallbackBearer;
  const authorization = bearer ? `Bearer ${bearer}` : (config.fallbackAuthorization ??
    (() => {
      throw new Error(
        "No credential: set STALWART_BEARER (or --bearer-env NAME) in the environment.",
      );
    })());
  return {
    authorization,
    bearer: parseBearerHeader(authorization),
    source,
    fingerprint: await actorFingerprint(config.confirmationSecret, authorization),
  };
}

// --- safety gating ------------------------------------------------------------------------------

/**
 * CLI safety pre-check. The handler itself computes the effective gate and may return a
 * ConfirmChallenge; the CLI's job is to translate `--yes` / `--confirm` / `--dry-run` into the
 * `confirm_token` arg (or refuse). We do not re-implement effectiveGate here — the op does — but we
 * refuse to auto-execute a gated op without the operator opting in.
 */
function applySafetyFlags(
  op: OpDefinition,
  args: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
  parsed: Record<string, any>,
): { block?: string } {
  if (op.confirmClass === "none") return {};

  const dryRun = parsed["dry-run"] === true;
  const confirmToken = typeof parsed.confirm === "string" ? parsed.confirm : undefined;
  const yes = parsed.yes === true;

  if (confirmToken) {
    args.confirm_token = confirmToken;
    return {};
  }
  if (dryRun) {
    // Leave confirm_token unset → the handler returns its challenge (preview + token).
    return {};
  }
  if (op.confirmClass === "outward") {
    if (yes) return {}; // proceed; handler decides direct vs challenge per policy.
    return {
      block:
        `${op.name} sends a message. Re-run with --yes to proceed (or --dry-run to preview), ` +
        `or add --confirm <token> under a strict policy.`,
    };
  }
  // destructive / blast: always require a token from a dry run.
  return {
    block: `${op.name} is ${op.confirmClass}. Re-run with --dry-run to get a confirmation ` +
      `token, then --confirm <token> to execute.`,
  };
}

function gatedOut(op: OpDefinition, config: V2Config): boolean {
  if (op.name.startsWith("admin.") || op.name.startsWith("sieve.")) return !config.enableAdminTools;
  if (op.name.startsWith("sync.")) return !config.enableSyncTools;
  return false;
}

// --- help ---------------------------------------------------------------------------------------

/** Registry-driven --help at every level (also feeds docs/tool-mapping regeneration). */
export function helpText(commandPath?: string[]): string {
  allOps();
  const ops = registeredOps();

  if (commandPath && commandPath.length === 2) {
    const name = commandPath.join(".");
    const op = opByName(name);
    if (op) return opHelp(op);
  }

  if (commandPath && commandPath.length === 1) {
    const group = commandPath[0];
    const groupOps = ops.filter((o) => o.name.startsWith(`${group}.`));
    if (groupOps.length > 0) {
      const lines = groupOps.map((o) =>
        `  ${BIN} ${o.name.replace(".", " ").padEnd(24)} ${firstLine(o.description)}`
      );
      return [`${BIN} ${group} — subcommands:`, "", ...lines].join("\n");
    }
  }

  // Top-level: list command groups.
  const groups = new Map<string, number>();
  for (const o of ops) {
    const g = o.name.split(".")[0];
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  const groupLines = [...groups.entries()].map(([g, n]) => `  ${g.padEnd(12)} ${n} command(s)`);
  return [
    `${BIN} — Letterdog: the user's self-hosted mail / calendar / contacts (JMAP).`,
    "",
    "Usage:",
    `  ${BIN} <group> <command> [flags] [ids…]`,
    `  ${BIN} <group> <command> --help`,
    "",
    "Global flags:",
    "  --json[=brief|full|raw]  machine output (NDJSON for lists); default on non-TTY",
    "  --url <url>              override the JMAP base URL",
    "  --account <id>           target a specific JMAP account",
    "  --bearer-env <NAME>      read the bearer from env var NAME (default STALWART_BEARER)",
    "  --yes                    approve an outward send",
    "  --confirm <token>        execute a destructive/blast op with a dry-run token",
    "  --dry-run                preview a gated op and print its confirmation token",
    "",
    "Command groups:",
    ...groupLines,
  ].join("\n");
}

function opHelp(op: OpDefinition): string {
  const specs = flagsForOp(op);
  const flagLines = specs.map((s) => {
    const tag = s.kind === "boolean"
      ? ""
      : s.kind === "array"
      ? " <v,…>"
      : s.enumValues
      ? ` <${s.enumValues.join("|")}>`
      : ` <${s.kind}>`;
    const req = s.required ? " (required)" : "";
    return `  --${flagName(s.name)}${tag}${req}${s.description ? `  ${s.description}` : ""}`;
  });
  const usage = `${BIN} ${op.name.replace(".", " ")} [flags]` +
    (specs.some((s) => s.name === "ids") ? " <id…|->" : "");
  return [
    `${BIN} ${op.name.replace(".", " ")} — ${firstLine(op.description)}`,
    "",
    op.description,
    "",
    `Usage: ${usage}`,
    "",
    flagLines.length ? "Flags:" : "Flags: (none)",
    ...flagLines,
    "",
    `Confirm class: ${op.confirmClass}   Projection: ${op.projection}   Surfaces: ${
      op.surfaces.join(", ")
    }`,
  ].join("\n");
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}

// --- runner -------------------------------------------------------------------------------------

/** Parse argv, resolve the op, build OpContext, run, print. Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  allOps();

  // `deno task cli -- mail search …` forwards a literal "--" separator — drop it.
  if (argv[0] === "--") argv = argv.slice(1);

  // Split leading command tokens (non-flag) from the rest.
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const commandTokens: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    commandTokens.push(token);
    if (commandTokens.length === 2) break;
  }

  if (commandTokens.length === 0) {
    console.log(helpText());
    return wantsHelp ? 0 : 0;
  }

  const opName = commandTokens.join(".");
  const op = commandTokens.length === 2 ? opByName(opName) : undefined;

  if (!op) {
    if (wantsHelp || commandTokens.length < 2) {
      console.log(helpText(commandTokens));
      return commandTokens.length < 2 ? 1 : 0;
    }
    console.error(`Unknown command: ${BIN} ${commandTokens.join(" ")}`);
    console.error(helpText(commandTokens.slice(0, 1)));
    return 1;
  }

  if (wantsHelp) {
    console.log(helpText(commandTokens));
    return 0;
  }

  const config = await loadV2Config();

  if (gatedOut(op, config)) {
    console.error(
      `${op.name} is disabled. Set ${
        op.name.startsWith("sync.") ? "ENABLE_SYNC_TOOLS" : "ENABLE_ADMIN_TOOLS"
      }=true to enable it.`,
    );
    return 1;
  }

  // Parse the remaining argv (after the command tokens) for this op's flags.
  const rest = argv.slice(commandTokens.length);
  const specs = flagsForOp(op);
  const stringFlags = specs.filter((s) => s.kind !== "boolean" && s.kind !== "array")
    .map((s) => flagName(s.name));
  const arrayFlags = specs.filter((s) => s.kind === "array").map((s) => flagName(s.name));
  const booleanFlags = specs.filter((s) => s.kind === "boolean").map((s) => flagName(s.name));

  const knownFlags = new Set([
    ...specs.map((s) => flagName(s.name)),
    "json",
    "url",
    "account",
    "bearer-env",
    "confirm",
    "yes",
    "dry-run",
    "help",
    "h",
  ]);
  const unknownFlags: string[] = [];
  const parsed = parseArgs(rest, {
    string: [...stringFlags, ...arrayFlags, "url", "account", "bearer-env", "confirm"],
    boolean: [...booleanFlags, "yes", "dry-run", "help", "h"],
    collect: arrayFlags,
    // --json may be bare (boolean) or valued (=full|raw); parse it manually below.
    unknown(arg, key) {
      if (key === undefined) return true; // positional — keep it.
      const bare = key.startsWith("no-") ? key.slice(3) : key;
      if (knownFlags.has(key) || knownFlags.has(bare)) return true;
      unknownFlags.push(arg);
      return false;
    },
  });
  if (unknownFlags.length > 0) {
    console.error(
      `Unknown flag(s) for ${BIN} ${op.name.replace(".", " ")}: ${unknownFlags.join(", ")}`,
    );
    console.error(`Run \`${BIN} ${op.name.replace(".", " ")} --help\` for the flag list.`);
    return 1;
  }

  const jsonMode = readJsonFlag(rest);

  // Apply --url / --account overrides to config/args.
  const effectiveConfig: V2Config = {
    ...config,
    ...(typeof parsed.url === "string" ? { stalwartBaseUrl: trimSlash(parsed.url) } : {}),
  };

  let args: Record<string, unknown>;
  try {
    args = await buildArgs(op, parsed, positionalsOf(parsed), rest);
    if (typeof parsed.account === "string" && !("account_id" in args)) {
      args.account_id = parsed.account;
    }
    // `--json=full|raw` selects the projection (design: "--json = brief; --json=full|raw for
    // more") unless --projection was given explicitly.
    if (
      (jsonMode === "full" || jsonMode === "raw") && "projection" in op.input &&
      !("projection" in args)
    ) {
      args.projection = jsonMode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const safety = applySafetyFlags(op, args, parsed);
  if (safety.block) {
    console.error(safety.block);
    return 1;
  }

  // Validate through the op's Zod shape exactly like the MCP surface does — this applies schema
  // defaults (limit 25, projection "brief", …) and rejects malformed input before any network call.
  try {
    const shape = op.confirmClass === "none"
      ? op.input
      : { ...op.input, confirm_token: z.string().min(16).optional() };
    args = z.object(shape).parse(args) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        console.error(`--${flagName(issue.path.map(String).join("."))}: ${issue.message}`);
      }
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let actor: Actor;
  try {
    actor = await cliActor(effectiveConfig, parsed);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const ctx: OpContext = {
    config: effectiveConfig,
    actor,
    jmap: new JmapClient(effectiveConfig),
    caldav: new CalDavClient(
      effectiveConfig as never,
      {
        authorization: actor.authorization,
        bearer: actor.bearer,
        source: "env-fallback",
      } as never,
    ),
    provider: stalwartProvider(),
    policy: effectiveConfig.confirmPolicy,
  };

  let result: unknown;
  try {
    result = await op.handler(args, ctx);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // A confirmation challenge always prints (as the "preview" of a dry run) and exits non-zero so a
  // script notices it did not execute.
  if (isConfirmChallenge(result)) {
    const mode = resolveOutputMode({
      json: !!jsonMode,
      isTty: Deno.stdout.isTerminal(),
      list: false,
    });
    console.log(mode === "table" ? renderChallenge(result) : renderResult(result, mode));
    return 2;
  }

  const list = isEnvelope(result);
  const mode = resolveOutputMode({
    json: !!jsonMode,
    isTty: Deno.stdout.isTerminal(),
    list,
  });
  console.log(renderResult(result, mode));

  // Exit 2 on partial failure (envelope carried a non-empty `failed` map).
  if (list) {
    const failed = (result as { failed?: Record<string, unknown> }).failed;
    if (failed && Object.keys(failed).length > 0) return 2;
  }
  return 0;
}

// deno-lint-ignore no-explicit-any
function positionalsOf(parsed: Record<string, any>): string[] {
  return (parsed._ ?? []).map(String);
}

// deno-lint-ignore no-explicit-any
function renderChallenge(c: any): string {
  return [
    "Confirmation required:",
    `  ${c.summary}`,
    "",
    c.preview !== undefined ? `Preview: ${JSON.stringify(c.preview)}` : "",
    "",
    "Re-run to execute:",
    `  --confirm ${c.confirm_token}`,
    c.expires_at ? `  (expires ${c.expires_at})` : "",
  ].filter(Boolean).join("\n");
}

/** Detect `--json`, `--json=full`, `--json=raw` from raw argv (parseArgs can't do the valued form). */
function readJsonFlag(argv: string[]): false | "brief" | "full" | "raw" {
  for (const token of argv) {
    if (token === "--json") return "brief";
    if (token.startsWith("--json=")) {
      const v = token.slice("--json=".length);
      if (v === "full" || v === "raw" || v === "brief") return v;
      return "brief";
    }
  }
  return false;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args));
}
