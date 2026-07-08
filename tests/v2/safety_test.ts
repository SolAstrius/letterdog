import {
  actorFingerprint,
  canonicalJson,
  type ConfirmIntent,
  effectiveGate,
  type Gate,
  type GateSignals,
  hashJson,
  isReadOnlyJmapMethod,
  mintConfirmToken,
  verifyConfirmToken,
} from "../../src/core/safety.ts";
import type { ConfirmPolicy } from "../../src/core/config.ts";
import type { ConfirmClass } from "../../src/core/ops/registry.ts";

const SECRET = "test-confirmation-secret";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function baseIntent(): ConfirmIntent {
  return {
    op: "mail.delete",
    account_id: "b",
    // Deliberately unsorted to prove the token normalizes order.
    resource_ids: ["m3", "m1", "m2"],
    payload: { permanent: true },
    actor_fingerprint: "actor-abc",
  };
}

// --- token roundtrip ---------------------------------------------------------------------------

Deno.test("confirm token round-trips for the exact intent", async () => {
  const intent = baseIntent();
  const token = await mintConfirmToken(SECRET, intent);
  assert(token.startsWith("ld2."), "token must carry the ld2 version prefix");
  assert(token.split(".").length === 3, "token must have three dot-separated segments");

  const verdict = await verifyConfirmToken(SECRET, token, intent);
  assert(verdict.ok, `valid token should verify: ${JSON.stringify(verdict)}`);
});

Deno.test("confirm token is order-insensitive on resource_ids", async () => {
  const token = await mintConfirmToken(SECRET, baseIntent());
  const reordered: ConfirmIntent = { ...baseIntent(), resource_ids: ["m2", "m3", "m1"] };
  const verdict = await verifyConfirmToken(SECRET, token, reordered);
  assert(verdict.ok, "same ids in a different order must still verify");
});

// --- expiry ------------------------------------------------------------------------------------

Deno.test("confirm token expires", async () => {
  const intent = baseIntent();
  const token = await mintConfirmToken(SECRET, intent, -1); // already expired
  const verdict = await verifyConfirmToken(SECRET, token, intent);
  assert(!verdict.ok, "expired token must not verify");
  assert(verdict.reason === "expired", `expected expired, got ${verdict.reason}`);
});

Deno.test("confirm token within ttl does not report expired", async () => {
  const intent = baseIntent();
  const token = await mintConfirmToken(SECRET, intent, 60_000);
  const verdict = await verifyConfirmToken(SECRET, token, intent);
  assert(verdict.ok, "fresh token should verify");
});

// --- tamper / mismatch -------------------------------------------------------------------------

Deno.test("tampering with the claims segment fails signature check", async () => {
  const token = await mintConfirmToken(SECRET, baseIntent());
  const [ver, _claims, sig] = token.split(".");
  // Swap in different claims while keeping the old signature.
  const forgedClaims = await mintConfirmToken(SECRET, { ...baseIntent(), account_id: "evil" });
  const forgedClaimsSegment = forgedClaims.split(".")[1];
  const tampered = `${ver}.${forgedClaimsSegment}.${sig}`;
  const verdict = await verifyConfirmToken(SECRET, tampered, baseIntent());
  assert(!verdict.ok, "tampered token must not verify");
  assert(verdict.reason === "mismatch", `expected mismatch, got ${verdict.reason}`);
});

Deno.test("wrong secret fails verification", async () => {
  const token = await mintConfirmToken(SECRET, baseIntent());
  const verdict = await verifyConfirmToken("other-secret", token, baseIntent());
  assert(!verdict.ok, "token signed with a different secret must not verify");
  assert(verdict.reason === "mismatch", `expected mismatch, got ${verdict.reason}`);
});

Deno.test("changed payload yields an actionable diff, not a bare mismatch", async () => {
  const token = await mintConfirmToken(SECRET, baseIntent());
  const changed: ConfirmIntent = { ...baseIntent(), payload: { permanent: false } };
  const verdict = await verifyConfirmToken(SECRET, token, changed);
  assert(!verdict.ok, "changed payload must not verify");
  assert(verdict.reason === "mismatch", "reason should be mismatch");
  assert(
    verdict.diff !== undefined && "payload_hash" in verdict.diff,
    "diff must name payload_hash",
  );
});

Deno.test("changed resource ids yield a resource_ids diff", async () => {
  const token = await mintConfirmToken(SECRET, baseIntent());
  const changed: ConfirmIntent = { ...baseIntent(), resource_ids: ["m1", "m2", "m9"] };
  const verdict = await verifyConfirmToken(SECRET, token, changed);
  assert(!verdict.ok, "changed ids must not verify");
  assert(
    verdict.diff !== undefined && "resource_ids" in verdict.diff,
    "diff must name resource_ids",
  );
});

Deno.test("changed op and account produce named diffs", async () => {
  const token = await mintConfirmToken(SECRET, baseIntent());
  const changed: ConfirmIntent = { ...baseIntent(), op: "mail.forward", account_id: "c" };
  const verdict = await verifyConfirmToken(SECRET, token, changed);
  assert(verdict.diff !== undefined, "diff expected");
  assert("op" in verdict.diff!, "op drift must be named");
  assert("account_id" in verdict.diff!, "account_id drift must be named");
});

Deno.test("malformed tokens are rejected without throwing", async () => {
  for (const bad of ["", "not-a-token", "ld2.only-two", "v1.claims.sig", "ld2..sig"]) {
    const verdict = await verifyConfirmToken(SECRET, bad, baseIntent());
    assert(!verdict.ok, `bad token ${JSON.stringify(bad)} must not verify`);
    assert(
      verdict.reason === "malformed" || verdict.reason === "mismatch",
      `bad token ${JSON.stringify(bad)} reason: ${verdict.reason}`,
    );
  }
});

// --- canonicalJson / hashJson / fingerprint ----------------------------------------------------

Deno.test("canonicalJson sorts keys deterministically", () => {
  const a = canonicalJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert(a === b, "key order must not affect canonical form");
  assert(a === '{"a":2,"b":1,"c":{"y":2,"z":1}}', `unexpected canonical form: ${a}`);
});

Deno.test("hashJson is stable and order-insensitive on object keys", async () => {
  const h1 = await hashJson({ a: 1, b: [1, 2, 3] });
  const h2 = await hashJson({ b: [1, 2, 3], a: 1 });
  assert(h1 === h2, "hash must ignore key order");
  const h3 = await hashJson({ b: [3, 2, 1], a: 1 });
  assert(h1 !== h3, "array order is significant and must change the hash");
});

Deno.test("actorFingerprint is 24 base64url chars and deterministic", async () => {
  const f1 = await actorFingerprint(SECRET, "Bearer xyz");
  const f2 = await actorFingerprint(SECRET, "Bearer xyz");
  assert(f1 === f2, "fingerprint must be deterministic");
  assert(f1.length === 24, `fingerprint should be 24 chars, got ${f1.length}`);
  assert(/^[A-Za-z0-9_-]+$/.test(f1), "fingerprint must be base64url");
  const f3 = await actorFingerprint(SECRET, "Bearer abc");
  assert(f1 !== f3, "different credentials must fingerprint differently");
});

// --- read-only JMAP method classifier ----------------------------------------------------------

Deno.test("isReadOnlyJmapMethod allows reads and rejects mutations", () => {
  for (
    const m of [
      "Email/get",
      "Email/query",
      "Email/changes",
      "Email/queryChanges",
      "Email/parse",
      "Blob/lookup",
      "Core/echo",
      "Principal/getAvailability",
    ]
  ) {
    assert(isReadOnlyJmapMethod(m), `${m} should be read-only`);
  }
  for (const m of ["Email/set", "Mailbox/set", "EmailSubmission/set", "Blob/upload"]) {
    assert(!isReadOnlyJmapMethod(m), `${m} should be mutating`);
  }
});

// --- policy matrix (3 policies × 4 classes) ----------------------------------------------------

function gate(
  confirmClass: ConfirmClass,
  policy: ConfirmPolicy,
  extra: Partial<GateSignals> = {},
): Gate {
  return effectiveGate({ confirmClass, policy, ...extra });
}

Deno.test("policy matrix: class none is always direct", () => {
  for (const policy of ["strict", "balanced", "minimal"] as ConfirmPolicy[]) {
    assert(gate("none", policy) === "direct", `none/${policy} should be direct`);
    // Even a large explicit set of trash moves stays direct.
    assert(
      gate("none", policy, { itemCount: 500 }) === "direct",
      `none/${policy} bulk still direct`,
    );
  }
});

Deno.test("policy matrix: class destructive is always two-phase", () => {
  for (const policy of ["strict", "balanced", "minimal"] as ConfirmPolicy[]) {
    assert(
      gate("destructive", policy) === "two_phase",
      `destructive/${policy} should be two_phase`,
    );
  }
});

Deno.test("policy matrix: class blast is always two-phase", () => {
  for (const policy of ["strict", "balanced", "minimal"] as ConfirmPolicy[]) {
    assert(gate("blast", policy) === "two_phase", `blast/${policy} should be two_phase`);
  }
});

Deno.test("policy matrix: class outward under strict is always two-phase", () => {
  assert(gate("outward", "strict") === "two_phase", "outward/strict small should be two_phase");
  assert(
    gate("outward", "strict", { recipientCount: 1 }) === "two_phase",
    "outward/strict single recipient should be two_phase",
  );
});

Deno.test("policy matrix: class outward under minimal is always direct", () => {
  assert(gate("outward", "minimal") === "direct", "outward/minimal should be direct");
  assert(
    gate("outward", "minimal", { recipientCount: 50, queryPowered: true }) === "direct",
    "outward/minimal stays direct even for large query-powered sends",
  );
});

Deno.test("policy matrix: class outward under balanced is conditional", () => {
  // ≤3 recipients and not query-powered → direct.
  assert(
    gate("outward", "balanced", { recipientCount: 3, queryPowered: false }) === "direct",
    "outward/balanced ≤3 recipients not query-powered should be direct",
  );
  assert(
    gate("outward", "balanced", { recipientCount: 0 }) === "direct",
    "outward/balanced with no recipient info defaults to direct",
  );
  // >3 recipients → two-phase.
  assert(
    gate("outward", "balanced", { recipientCount: 4 }) === "two_phase",
    "outward/balanced >3 recipients should be two_phase",
  );
  // query-powered → two-phase even with few recipients.
  assert(
    gate("outward", "balanced", { recipientCount: 1, queryPowered: true }) === "two_phase",
    "outward/balanced query-powered should be two_phase",
  );
});

Deno.test("per-call override de-escalates the static class", () => {
  // mail.delete is destructive, but a non-permanent trash move overrides to none.
  assert(
    gate("destructive", "balanced", { effectiveClassOverride: "none" }) === "direct",
    "destructive op overridden to none should be direct",
  );
});

Deno.test("query-powered bulk over 100 items escalates any op to blast", () => {
  // An otherwise-direct outward/minimal call escalates when the query touches >100 items.
  assert(
    gate("outward", "minimal", { queryPowered: true, itemCount: 101 }) === "two_phase",
    "query-powered bulk >100 should escalate to two_phase",
  );
  // Exactly at the threshold does NOT escalate.
  assert(
    gate("outward", "minimal", { queryPowered: true, itemCount: 100 }) === "direct",
    "query-powered bulk at the 100 threshold should not escalate under minimal",
  );
  // Non-query-powered bulk does not escalate.
  assert(
    gate("none", "balanced", { itemCount: 1000 }) === "direct",
    "non-query-powered bulk should not escalate",
  );
});
