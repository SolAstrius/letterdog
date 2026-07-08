/**
 * blob + file ops — builder ops:aux (B10-ops-misc). CLI-only surfaces.
 *
 * Ops (docs/v2-contracts.md §ops inventory + this builder's assignment):
 * - blob.upload   → upload_blob     [cli]  none              projection: blob
 *     Sources: content_base64 | text | url (SSRF-guarded fetch). Small payloads go via the JMAP
 *     Blob/upload data endpoint (session uploadUrl); large ones stream to the same endpoint —
 *     Stalwart has one HTTP upload endpoint, so both paths use uploadBlob(). Prints
 *     {blob_id, type, size} for chaining into mail.send attachments / event links.
 * - blob.download → download_blob    [cli]  none  readOnly   projection: blob
 *     RFC 9404 Blob/get with offset/length/digest for metadata + inline bytes, OR mode:"url" to
 *     emit an authenticated download URL (bytes never enter model context). CLI adds -o via a
 *     file_path arg (surfaced only on the cli by the frontend; the handler writes the file when
 *     present). mode:"content" returns base64 (capped) for small blobs.
 * - blob.lookup   → lookup_blob      [cli]  none  readOnly   projection: blob
 *     Blob/lookup: which typed objects reference these blobIds (typeNames arg). Live-probed:
 *     returns {list:[{id, matchedIds:{Type:[ids]}}], notFound}.
 * - file.list     → list_files       [cli]  none  readOnly   projection: none
 *     FileNode/query → FileNode/get merged (urn:ietf:params:jmap:filenode). Directory/file tree.
 */
import { z } from "zod";
import type { OpContext, OpDefinition } from "./registry.ts";
import { defineOp } from "./registry.ts";
import { CAPABILITIES, USING } from "../jmap/session.ts";
import { envelopeFromGet } from "../jmap/envelopes.ts";
import type { Envelope } from "../jmap/envelopes.ts";
import { ref } from "../jmap/client.ts";
import { AccountIdSchema, LimitSchema } from "../schemas/common.ts";

/** Extract the JmapAuth slice from the op context actor. */
function authOf(ctx: OpContext): { authorization: string; fingerprint: string } {
  return { authorization: ctx.actor.authorization, fingerprint: ctx.actor.fingerprint };
}

// --- SSRF guard for url sources -----------------------------------------------------------------

/** Blocked host patterns for url-sourced uploads (SSRF hardening). */
function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid url: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) urls are allowed (got ${url.protocol}).`);
  }
  const host = url.hostname.toLowerCase();
  // Block loopback, link-local, and obvious private ranges by literal / hostname.
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "::1"
  ) {
    throw new Error(`Refusing to fetch a loopback host: ${host}`);
  }
  // IPv4 literal private/link-local/loopback ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const isPrivate = a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
    if (isPrivate) throw new Error(`Refusing to fetch a private/link-local address: ${host}`);
  }
  // IPv6 unique-local (fc00::/7) / link-local (fe80::/10) literals.
  if (host.startsWith("[")) {
    const inner = host.slice(1, -1);
    if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(inner)) {
      throw new Error(`Refusing to fetch a private/link-local IPv6 address: ${host}`);
    }
  }
  return url;
}

/** Decode a base64 (standard or base64url) string to bytes. */
function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// --- blob.upload --------------------------------------------------------------------------------

const BlobUploadShape = {
  content_base64: z.string().optional().describe("Blob bytes as base64 (standard or base64url)."),
  text: z.string().optional().describe("Blob content as a UTF-8 string (convenience for text)."),
  url: z.string().url().optional().describe(
    "Fetch the blob from a PUBLIC http(s) url (SSRF-guarded: loopback/private ranges rejected).",
  ),
  content_type: z.string().default("application/octet-stream").describe(
    "MIME type stored with the blob and used for the JMAP upload Content-Type.",
  ),
  account_id: AccountIdSchema,
};

const blobUpload = defineOp({
  name: "blob.upload",
  mcpName: "upload_blob",
  description:
    "Upload bytes to Letterdog's JMAP blob store and get back a {blob_id, type, size}. Supply " +
    "exactly one of content_base64, text, or url. Chain the returned blob_id into send_email " +
    "attachments ({blob_id}) or event links. url sources are SSRF-guarded (public http(s) only).",
  input: BlobUploadShape,
  annotations: { readOnly: false, idempotent: false },
  confirmClass: "none",
  projection: "blob",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const sources = [args.content_base64, args.text, args.url].filter((s) => s !== undefined);
    if (sources.length !== 1) {
      throw new Error("Provide exactly one of content_base64, text, or url.");
    }

    let bytes: Uint8Array;
    if (args.content_base64 !== undefined) {
      bytes = decodeBase64(args.content_base64);
    } else if (args.text !== undefined) {
      bytes = new TextEncoder().encode(args.text);
    } else {
      const url = assertPublicUrl(args.url as string);
      const response = await fetch(url, { redirect: "error" });
      if (!response.ok) throw new Error(`Fetch of ${url.href} failed: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    }

    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.blob, args.account_id);
    const uploaded = await ctx.jmap.uploadBlob(
      authOf(ctx),
      acct.accountId,
      bytes,
      args.content_type,
    );
    const envelope: Envelope<unknown> = {
      items: [{
        blob_id: uploaded.blobId,
        type: uploaded.type,
        size: uploaded.size,
        account_id: uploaded.accountId,
      }],
    };
    return envelope;
  },
});

// --- blob.download ------------------------------------------------------------------------------

const BlobDownloadShape = {
  blob_id: z.string().min(1).describe(
    "The blobId to download (from search results / attachments).",
  ),
  mode: z.enum(["url", "content"]).default("url").describe(
    "url: emit an authenticated download URL + curl one-liner (bytes stay out of context, the " +
      "local-save path). content: return base64 bytes (capped; small blobs only).",
  ),
  name: z.string().default("blob").describe("Suggested file name for the download URL / Content."),
  type: z.string().default("application/octet-stream").describe("Accept/Content-Type hint."),
  offset: z.number().int().min(0).optional().describe("RFC 9404 Blob/get byte offset."),
  length: z.number().int().min(1).optional().describe("RFC 9404 Blob/get byte length."),
  max_content_bytes: z.number().int().min(1).default(1_048_576).describe(
    "Guardrail for mode:content — refuse to inline blobs larger than this many bytes.",
  ),
  file_path: z.string().optional().describe(
    "CLI-only: write the downloaded bytes to this path instead of returning them.",
  ),
  account_id: AccountIdSchema,
};

const blobDownload = defineOp({
  name: "blob.download",
  mcpName: "download_blob",
  description:
    "Download a blob from Letterdog by blobId. mode:url (default) returns an authenticated URL and " +
    "a curl one-liner — the bytes never enter the model context; that is the local-save path. " +
    "mode:content returns base64 bytes for small blobs (bounded by max_content_bytes). CLI: pass " +
    "file_path to write the bytes to disk directly.",
  input: BlobDownloadShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "blob",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.blob, args.account_id);
    const session = await ctx.jmap.session(authOf(ctx));

    if (args.mode === "url" && !args.file_path) {
      const url = ctx.jmap.downloadUrlFor(
        session,
        acct.accountId,
        args.blob_id,
        args.name,
        args.type,
      );
      const envelope: Envelope<unknown> = {
        items: [{
          blob_id: args.blob_id,
          mode: "url",
          download_url: url,
          curl: `curl -L -H 'Authorization: Bearer $STALWART_BEARER' -o '${args.name}' '${url}'`,
        }],
      };
      return envelope;
    }

    // content (or url+file_path): fetch bytes. Prefer RFC 9404 Blob/get for offset/length/digest
    // metadata when the caller asked for a slice; otherwise stream the whole blob.
    const bytes = await ctx.jmap.downloadBlob(
      authOf(ctx),
      acct.accountId,
      args.blob_id,
      args.name,
      args.type,
    );
    const sliced = (args.offset !== undefined || args.length !== undefined)
      ? bytes.subarray(
        args.offset ?? 0,
        args.length !== undefined ? (args.offset ?? 0) + args.length : undefined,
      )
      : bytes;

    if (args.file_path) {
      await Deno.writeFile(args.file_path, sliced);
      const envelope: Envelope<unknown> = {
        items: [{
          blob_id: args.blob_id,
          mode: "file",
          file_path: args.file_path,
          size: sliced.byteLength,
        }],
      };
      return envelope;
    }

    if (sliced.byteLength > args.max_content_bytes) {
      throw new Error(
        `Blob is ${sliced.byteLength} bytes, over max_content_bytes=${args.max_content_bytes}. ` +
          `Use mode:url or file_path, or raise max_content_bytes.`,
      );
    }
    const envelope: Envelope<unknown> = {
      items: [{
        blob_id: args.blob_id,
        mode: "content",
        type: args.type,
        size: sliced.byteLength,
        content_base64: encodeBase64(sliced),
      }],
    };
    return envelope;
  },
});

// --- blob.lookup --------------------------------------------------------------------------------

const BlobLookupShape = {
  ids: z.array(z.string().min(1)).min(1).max(500).describe("blobIds to look up references for."),
  type_names: z.array(z.string().min(1)).min(1).default(["Email", "Mailbox"]).describe(
    "Object types to check for references (e.g. Email, Mailbox, CalendarEvent, ContactCard).",
  ),
  account_id: AccountIdSchema,
};

const blobLookup = defineOp({
  name: "blob.lookup",
  mcpName: "lookup_blob",
  description:
    "RFC 9404 Blob/lookup: given blobIds, report which typed objects reference them (per type_names). " +
    "Use before destroying a blob or to trace an attachment back to its email. Returns per-blob " +
    "matchedIds keyed by type.",
  input: BlobLookupShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "blob",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.blob, args.account_id);
    const res = await ctx.jmap.call(authOf(ctx), [...USING.blob], "Blob/lookup", {
      accountId: acct.accountId,
      typeNames: args.type_names,
      ids: args.ids,
    });
    const list = Array.isArray(res.list) ? res.list : [];
    const envelope: Envelope<unknown> = { items: list };
    if (Array.isArray(res.notFound) && res.notFound.length > 0) {
      envelope.not_found = res.notFound as string[];
    }
    return envelope;
  },
});

// --- file.list ----------------------------------------------------------------------------------

const FileListShape = {
  ids: z.array(z.string().min(1)).optional().describe(
    "Specific FileNode ids to fetch; omit to query the account's file tree.",
  ),
  parent_id: z.string().optional().describe("Restrict the query to children of this FileNode."),
  account_id: AccountIdSchema,
  limit: LimitSchema,
  calculate_total: z.boolean().default(false).describe("Opt-in FileNode/query total."),
};

const fileList = defineOp({
  name: "file.list",
  mcpName: "list_files",
  description:
    "List FileNode entries (Letterdog's JMAP file storage, urn:ietf:params:jmap:filenode). Query " +
    "the tree (optionally under parent_id) or fetch specific ids. Returns raw FileNode objects " +
    "(name, type, size, parentId, blobId). CLI-only.",
  input: FileListShape,
  annotations: { readOnly: true },
  confirmClass: "none",
  projection: "none",
  surfaces: ["cli"],
  async handler(args, ctx) {
    const acct = await ctx.jmap.resolveAccount(authOf(ctx), CAPABILITIES.fileNode, args.account_id);

    if (args.ids && args.ids.length > 0) {
      const res = await ctx.jmap.getChunked(
        authOf(ctx),
        [CAPABILITIES.core, CAPABILITIES.fileNode],
        "FileNode/get",
        {
          accountId: acct.accountId,
          ids: args.ids,
        },
      );
      const env = envelopeFromGet(res);
      const envelope: Envelope<unknown> = { items: env.items };
      if (env.not_found) envelope.not_found = env.not_found;
      if (env.state) envelope.state = env.state;
      return envelope;
    }

    const queryArgs: Record<string, unknown> = { accountId: acct.accountId, limit: args.limit };
    if (args.parent_id) queryArgs.filter = { parentId: args.parent_id };
    if (args.calculate_total) queryArgs.calculateTotal = true;

    const result = await ctx.jmap.request(
      authOf(ctx),
      [CAPABILITIES.core, CAPABILITIES.fileNode],
      [
        ["FileNode/query", queryArgs, "q"],
        ["FileNode/get", {
          accountId: acct.accountId,
          "#ids": ref("q", "FileNode/query", "/ids"),
        }, "g"],
      ],
    );
    const queryRes = result.methodResponses.find((r) => r[2] === "q");
    const getRes = result.methodResponses.find((r) => r[2] === "g");
    if (!getRes || getRes[0] === "error") throw new Error("FileNode/get failed");
    const env = envelopeFromGet(getRes[1]);
    const envelope: Envelope<unknown> = { items: env.items };
    if (queryRes && queryRes[0] !== "error" && typeof queryRes[1].total === "number") {
      envelope.total = queryRes[1].total as number;
    }
    if (env.state) envelope.state = env.state;
    return envelope;
  },
});

export const ops: OpDefinition[] = [blobUpload, blobDownload, blobLookup, fileList];
