# Letterdog

Letterdog is a personal PIM connector: one Deno domain core over JMAP (mail, calendars, contacts,
principals, blobs) with two surfaces built from a single operation registry —

- an **MCP server** (deployed, Streamable HTTP) exposing 22 curated everyday tools for claude.ai /
  mobile / Cowork / local agents, and
- a **CLI** (`letterdog`) exposing every op at full spec fidelity for local agents (Bash), bulk
  pipelines, and humans.

The backend it fronts is a self-hosted [Stalwart](https://stalw.art) server (JMAP primary, CalDAV as
the raw-iCalendar escape hatch), but the core targets JMAP-the-standard through a provider adapter.
Design: [docs/v2-design.md](docs/v2-design.md); normative contracts and op inventory:
[docs/v2-contracts.md](docs/v2-contracts.md); generated surface map:
[docs/tool-mapping.md](docs/tool-mapping.md). Live Stalwart deviations the connector works around:
[docs/stalwart-conformance.md](docs/stalwart-conformance.md) (per-RFC detail in
[docs/rfc-notes/](docs/rfc-notes/)).

The v1 server (`main.ts`, `src/*.ts`, `src/tools/`) remains deployed and untouched; v2 lives in
`src/core/`, `src/mcp/`, `src/cli/`, entrypoint `v2.ts`.

## Layout (v2)

```
v2.ts                MCP entrypoint (HTTP default; MCP_TRANSPORT=stdio for local)
src/core/ops/        THE op registry — every capability defined once, surfaced twice
src/core/jmap/       typed JMAP client, session cache (per actor fingerprint), envelopes
src/core/schemas/    Zod: RFC 8621 mail filters, RFC 8984 JSCalendar, JSContact
src/core/projections.ts  brief/full/raw output shaping (brief default everywhere)
src/core/safety.ts   confirmation policy matrix + self-contained signed confirm tokens
src/core/compose.ts  RFC-correct reply threading, forwards, attachment planning
src/core/query.ts    Gmail-syntax → Email/query filter translation
src/core/provider/   Stalwart adapter (v0.16 hybrid shapes) + generic JMAP fallback
src/mcp/server.ts    MCP frontend (ops tagged "mcp" → tools)
src/cli/             CLI frontend (ALL ops → subcommands, registry-driven --help)
tests/v2/            unit tests (no network)
skills/              letterdog-* skills for Claude Code / Cowork
```

## Development

```bash
deno task check:v2          # fmt + lint + typecheck + unit tests (v2)
deno task dev:v2:http       # MCP server on http://127.0.0.1:8787/mcp
deno task dev:v2:stdio      # MCP server on stdio (env bearer fallback allowed)
deno task cli -- mail search "in:inbox is:unread" --limit 10 --json
deno task gen:tool-mapping  # regenerate docs/tool-mapping.md from the registry
deno task check             # v1 suite (unchanged)
```

Local auth: put `STALWART_BEARER=...` in `.env` (or the environment). The HTTP server forwards each
request's `Authorization` header verbatim to Stalwart — the env bearer is a local-dev / stdio
fallback only (`STALWART_ALLOW_ENV_BEARER_FALLBACK`).

## CLI install

The CLI is a Deno program; compile it to a binary on PATH:

```bash
deno compile --allow-net --allow-env --allow-read --allow-write \
  -o ~/.local/bin/letterdog src/cli/main.ts
letterdog --help
letterdog mail search 'from:klarna after:2026-06-01' --json
```

Auth: `STALWART_BEARER` in the environment (on this machine: launchctl env), `--bearer-env NAME` to
read a different variable, `--url` / `--account` to override the target. Output: human tables on a
TTY; NDJSON with `--json` (or when piped); `--json=full|raw` for deeper projections.

## Registration

**Claude Code / claude.ai (remote MCP):** the repo doubles as a plugin
(`.claude-plugin/plugin.json` + `.mcp.json` + `skills/`). One-command install via the marketplace
entry:

```
/plugin marketplace add <this repo>
/plugin install letterdog@letterdog-marketplace
```

or register just the MCP server in any project's `.mcp.json`:

```json
{
  "mcpServers": {
    "letterdog": {
      "type": "http",
      "url": "https://mcp.mail.astrius.ink/mcp",
      "headers": { "Authorization": "Bearer ${STALWART_BEARER}" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.letterdog]
url = "https://mcp.mail.astrius.ink/mcp"
bearer_token_env_var = "STALWART_BEARER"
```

## Confirmation policy

Two-phase confirmation is reserved for actions that are both hard to reverse and high blast radius,
controlled per deployment by `CONFIRM_POLICY` (`strict` | `balanced` (default) | `minimal` — the
personal deployment runs `minimal`):

| Action class                                                                       | strict    | balanced                                | minimal   |
| ---------------------------------------------------------------------------------- | --------- | --------------------------------------- | --------- |
| Reversible / low blast (labels, marks, moves incl. trash, archive, drafts, alerts) | direct    | direct                                  | direct    |
| Outward messaging (send/reply/forward, invitations, RSVP replies)                  | two-phase | direct ≤3 recipients & not query-driven | direct    |
| Irreversible destruction (permanent destroy; calendar/mailbox delete with content) | two-phase | two-phase                               | two-phase |
| High blast radius (share ACLs, admin, raw JMAP mutations, query-bulk >100)         | two-phase | two-phase                               | two-phase |

Two-phase flow: the call returns `confirmation_required` + a brief preview + a self-contained signed
`confirm_token` (embedded expiry, bound to the actor and the exact intent); repeat the identical
call with `confirm_token` to execute. CLI: `--dry-run` prints the challenge, `--confirm <token>`
executes, `--yes` approves routine outward sends.

## Server configuration

| Env var                              | Default                    | Meaning                            |
| ------------------------------------ | -------------------------- | ---------------------------------- |
| `STALWART_BASE_URL`                  | `https://mail.astrius.ink` | JMAP server base URL               |
| `CONFIRM_POLICY`                     | `balanced`                 | strict / balanced / minimal        |
| `CONFIRMATION_SECRET`                | random per process         | HMAC secret for confirm tokens     |
| `ENABLE_ADMIN_TOOLS`                 | `false`                    | register `admin.*` / `sieve.*` ops |
| `ENABLE_SYNC_TOOLS`                  | `false`                    | register `sync.*` ops              |
| `SESSION_CACHE_TTL_MS`               | `60000`                    | JMAP session cache per actor       |
| `STALWART_ALLOW_ENV_BEARER_FALLBACK` | stdio: true, http: false   | allow env bearer when no header    |
| `MCP_TRANSPORT` / `PORT`             | `http` / `8787`            | transport / listen port            |

Production MCP endpoint: `https://mcp.mail.astrius.ink/mcp` (k8s manifest in
[k8s/deployment.yaml](k8s/deployment.yaml)).

## v1 (legacy, still deployed)

```bash
deno task dev:http   # v1 server
deno task smoke:http
deno task probe:live
deno task check      # v1 checks
```

v1 remains the deployed image until the v2 rollout completes; `mcp-client.example.json` is its
minimal client registration snippet.
