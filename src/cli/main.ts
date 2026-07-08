/**
 * CLI frontend: `letterdog` — compiles ALL ops into subcommands (+ --help) from the registry.
 * CONTRACT STUB — TODO(builder: B11-frontends). Signatures normative; bodies throw.
 *
 * Mapping: op.name "mail.search" → `letterdog mail search`. Flags derived from op.input
 * (@std/cli parseArgs): arrays accept repeated flags or CSV; positional trailing args map to
 * `ids`; `-` reads ids from stdin (one per line — pipe from a search). Output: human tables on
 * TTY; `--json` (NDJSON for lists) = brief projection; `--json=full|raw` for more; agents get
 * stable JSON by default when piped (!isatty).
 *
 * Auth: STALWART_BEARER env (launchctl) / --url / --account → Actor{source:"env"|"flag"}.
 * Safety: reads just run; mutating ops print a one-line effect summary; outward sends need
 * --yes; destructive/blast need --confirm <token> (token printed by the dry run; same HMAC core
 * as MCP — core/safety.ts). --dry-run wherever meaningful. Gating: admin.* and sieve.* need
 * ENABLE_ADMIN_TOOLS, sync.* need ENABLE_SYNC_TOOLS.
 */
import { allOps } from "../core/ops/index.ts";

/** Parse argv, resolve the op, build OpContext, run, print. Returns the process exit code. */
export function runCli(_argv: string[]): Promise<number> {
  allOps(); // assemble the registry
  throw new Error("not implemented: cli/main runCli");
}

/** Registry-driven --help (also feeds the docs/tool-mapping.md regeneration). */
export function helpText(_commandPath?: string[]): string {
  throw new Error("not implemented: cli/main helpText");
}

if (import.meta.main) {
  Deno.exit(await runCli(Deno.args));
}
