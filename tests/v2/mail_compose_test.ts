/**
 * mail_compose attachment planning — regression guard for the inline-attachment bug.
 *
 * Small attachments used to ride an in-request Blob/upload referenced as `blobId:"#att0"` in the
 * Email/set bodyStructure. Stalwart rejects #creationId back-references there ("Cannot set
 * property" on bodyStructure/blobId), so the create failed and the chained EmailSubmission
 * "#emailId" ref cascaded. planMessageAttachments now always uploads to a CONCRETE blobId first;
 * these tests assert no `#`-prefixed blobId ever reaches a body part or the folded bodyStructure.
 */
import { assert, assertEquals } from "@std/assert";
import { planMessageAttachments, withAttachments } from "../../src/core/ops/mail_compose.ts";
import type { OpContext } from "../../src/core/ops/registry.ts";
import type { AccountRef } from "../../src/core/jmap/client.ts";
import type { EmailCreatePayload } from "../../src/core/compose.ts";

/** Minimal OpContext stub that records uploadBlob calls and returns a fixed concrete blobId. */
function stubCtx() {
  const uploads: Array<{ bytes: Uint8Array; type: string }> = [];
  const ctx = {
    actor: { authorization: "Bearer test", fingerprint: "fp" },
    jmap: {
      uploadBlob(_auth: unknown, accountId: string, bytes: Uint8Array, type: string) {
        uploads.push({ bytes, type });
        return Promise.resolve({
          accountId,
          blobId: `concrete-${uploads.length}`,
          type,
          size: bytes.byteLength,
        });
      },
    },
  } as unknown as OpContext;
  return { ctx, uploads };
}

const account = { accountId: "b" } as unknown as AccountRef;

Deno.test("planMessageAttachments uploads a small text source to a concrete blobId (no #creationId)", async () => {
  const { ctx, uploads } = stubCtx();
  const plan = await planMessageAttachments(ctx, account, [
    {
      text: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR",
      name: "e.ics",
      type: "text/calendar",
    },
  ]);

  assertEquals(uploads.length, 1, "small attachment must still be uploaded to a real blob");
  assertEquals(uploads[0].type, "text/calendar");
  assertEquals(plan.bodyParts.length, 1);
  assertEquals(plan.bodyParts[0].blobId, "concrete-1");
  assert(!plan.bodyParts[0].blobId.startsWith("#"), "body part must not carry a #creationId ref");
});

Deno.test("withAttachments folds concrete blobIds into a multipart/mixed bodyStructure", async () => {
  const { ctx } = stubCtx();
  const plan = await planMessageAttachments(ctx, account, [
    { text: "hello", name: "note.txt", type: "text/plain" },
  ]);

  const create = {
    bodyStructure: { partId: "text", type: "text/plain" },
    bodyValues: { text: { value: "body" } },
  } as unknown as EmailCreatePayload;

  const folded = withAttachments(create, plan);
  const structure = folded.bodyStructure as {
    type: string;
    subParts: Array<Record<string, unknown>>;
  };
  assertEquals(structure.type, "multipart/mixed");

  const attach = structure.subParts.find((p) => p.blobId === "concrete-1");
  assert(attach !== undefined, "attachment folded with its concrete blobId");
  for (const part of structure.subParts) {
    const blobId = part.blobId;
    if (typeof blobId === "string") {
      assert(!blobId.startsWith("#"), "no #creationId ref may appear in the final bodyStructure");
    }
  }
});

Deno.test("planMessageAttachments passes blob_id sources through untouched", async () => {
  const { ctx, uploads } = stubCtx();
  const plan = await planMessageAttachments(ctx, account, [
    { blob_id: "already-a-blob", name: "x.pdf", type: "application/pdf" },
  ]);

  assertEquals(uploads.length, 0, "an existing blob_id needs no upload");
  assertEquals(plan.bodyParts.length, 1);
  assertEquals(plan.bodyParts[0].blobId, "already-a-blob");
});
