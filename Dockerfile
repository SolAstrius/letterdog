FROM denoland/deno:2.8.2

WORKDIR /app

COPY deno.json deno.lock ./
COPY v2.ts ./v2.ts
COPY src ./src
COPY scripts ./scripts

RUN deno cache v2.ts

ENV MCP_TRANSPORT=http
ENV PORT=8787
ENV STALWART_BASE_URL=https://mail.astrius.ink
ENV STALWART_ALLOW_ENV_BEARER_FALLBACK=false
ENV CONFIRM_POLICY=balanced

EXPOSE 8787

USER deno

CMD ["run", "--allow-net", "--allow-env", "--allow-read=.env", "v2.ts"]
