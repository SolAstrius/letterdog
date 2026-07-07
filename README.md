# Stalwart JMAP MCP

Deno MCP server for Stalwart's JMAP, CalDAV, and Stalwart management surfaces.

The server is stateless. In HTTP mode, every MCP request supplies a bearer token in
`Authorization: Bearer ...`; that bearer is forwarded to Stalwart and used to resolve the live JMAP
session and account capabilities. `.env` bearer fallback is for local development and stdio only.

CalDAV discovery, collection listing, calendar-query, and multiget use `@nextcloud/cdav-library`,
with a Deno XML DOM/XPath shim and raw fetch fallbacks for GET/PUT/DELETE iCalendar resources.

## Development

```bash
deno task schemas
deno task dev:http
deno task smoke:http
deno task probe:live
deno task check
```

Default local HTTP endpoint:

```text
http://127.0.0.1:8787/mcp
```

Production target:

```text
https://mcp.mail.astrius.ink/mcp
```

See [docs/tool-mapping.md](docs/tool-mapping.md) for the public tool-to-method mapping.

`mcp-client.example.json` contains a minimal Streamable HTTP client registration snippet.
