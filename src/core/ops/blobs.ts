/**
 * blob ops — TODO(builder: B10-ops-misc)
 *
 * Ops to implement (see docs/v2-contracts.md §ops inventory):
 * - blob.upload → upload_blob          [cli]  none
 *   file path → HTTP upload endpoint (or Blob/upload for small payloads, RFC 9404); prints
 *   {blob_id, type, size} for chaining into mail.send / event links.
 * - blob.download → download_blob      [cli]  none  readOnly
 *   blob_id → disk path via authenticated downloadUrl template; bytes never enter context.
 * - blob.lookup → lookup_blob          [cli]  none  readOnly
 *   Blob/lookup: which objects reference these blobIds (typeNames arg).
 */
import type { OpDefinition } from "./registry.ts";

export const ops: OpDefinition[] = [];
