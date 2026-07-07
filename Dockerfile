FROM denoland/deno:2.8.2

WORKDIR /app

COPY deno.json deno.lock ./
COPY main.ts ./main.ts
COPY src ./src
COPY scripts ./scripts

RUN deno cache main.ts scripts/fetch_schemas.ts scripts/mcp_smoke.ts scripts/mcp_live_probe.ts

ENV MCP_TRANSPORT=http
ENV PORT=8787
ENV STALWART_BASE_URL=https://mail.astrius.ink
ENV STALWART_ALLOW_ENV_BEARER_FALLBACK=false

EXPOSE 8787

USER deno

CMD ["run", "--allow-net", "--allow-env", "--allow-read=.env", "main.ts"]
