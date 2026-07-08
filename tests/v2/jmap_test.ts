/**
 * Unit tests for core/jmap envelope normalization + session-cache/limit helpers.
 * Fixture-driven; NO network. Owned by builder B1-jmap.
 */
import {
  envelopeFromGet,
  envelopeFromQuery,
  expectResponse,
  JmapMethodError,
  type MethodResponse,
  setOutcome,
} from "../../src/core/jmap/envelopes.ts";
import { coreLimits, SessionCache } from "../../src/core/jmap/session.ts";
import type { JmapSession } from "../../src/core/jmap/session.ts";
import { mailboxRoleMap } from "../../src/core/jmap/types.ts";
import type { Mailbox } from "../../src/core/jmap/types.ts";

/**
 * Local zero-dependency assertions — matches the v1 tests/smoke_test.ts convention (no @std/assert
 * import, because deno.json is architect-owned and the lint bans inline jsr: specifiers).
 */
function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg?: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(msg ?? `expected ${e}, got ${a}`);
}

Deno.test("envelopeFromGet maps list/notFound/state", () => {
  const env = envelopeFromGet({
    accountId: "b",
    state: "s1",
    list: [{ id: "e1" }, { id: "e2" }],
    notFound: ["e9"],
  });
  assertEquals(env.items.length, 2);
  assertEquals(env.not_found, ["e9"]);
  assertEquals(env.state, "s1");
});

Deno.test("envelopeFromGet omits empty not_found and missing state", () => {
  const env = envelopeFromGet({ list: [], notFound: [] });
  assertEquals(env.items, []);
  assert(!("not_found" in env));
  assert(!("state" in env));
});

Deno.test("envelopeFromGet tolerates missing list", () => {
  const env = envelopeFromGet({ accountId: "b" });
  assertEquals(env.items, []);
});

Deno.test("envelopeFromQuery maps ids/total/position/queryState", () => {
  const env = envelopeFromQuery({
    accountId: "b",
    ids: ["e1", "e2", "e3"],
    total: 42,
    position: 10,
    queryState: "q1",
  });
  assertEquals(env.items, ["e1", "e2", "e3"]);
  assertEquals(env.total, 42);
  assertEquals(env.position, 10);
  assertEquals(env.state, "q1");
});

Deno.test("envelopeFromQuery omits total when not requested", () => {
  const env = envelopeFromQuery({ ids: ["e1"], queryState: "q1", position: 0 });
  assert(!("total" in env));
  assertEquals(env.position, 0);
});

Deno.test("setOutcome merges the three not* maps into failed", () => {
  const outcome = setOutcome({
    oldState: "s1",
    newState: "s2",
    created: { k1: { id: "e1", blobId: "b1" } },
    updated: { e2: null },
    destroyed: ["e3"],
    notCreated: { k2: { type: "invalidProperties", properties: ["from"] } },
    notUpdated: { e4: { type: "notFound" } },
    notDestroyed: { e5: { type: "forbidden" } },
  });
  assertEquals(outcome.created.k1.id, "e1");
  assertEquals(outcome.updated.e2, null);
  assertEquals(outcome.destroyed, ["e3"]);
  assertEquals(Object.keys(outcome.failed).sort(), ["e4", "e5", "k2"]);
  assertEquals(outcome.failed.k2.type, "invalidProperties");
  assertEquals(outcome.failed.k2.properties, ["from"]);
  assertEquals(outcome.old_state, "s1");
  assertEquals(outcome.new_state, "s2");
  assertEquals(outcome.allFailed, false);
});

Deno.test("setOutcome flags allFailed when zero successes and >=1 failure", () => {
  const outcome = setOutcome({
    newState: "s2",
    created: {},
    notCreated: {
      k1: { type: "tooManyRecipients", maxRecipients: 10 },
    },
  });
  assertEquals(outcome.allFailed, true);
  assertEquals(outcome.failed.k1.maxRecipients, 10);
});

Deno.test("setOutcome partial success is NOT allFailed", () => {
  const outcome = setOutcome({
    created: { k1: { id: "e1" } },
    notCreated: { k2: { type: "overQuota" } },
  });
  assertEquals(outcome.allFailed, false);
});

Deno.test("setOutcome empty /set is not allFailed", () => {
  const outcome = setOutcome({ newState: "s2", created: {}, updated: {}, destroyed: [] });
  assertEquals(outcome.allFailed, false);
  assertEquals(outcome.destroyed, []);
});

Deno.test("setOutcome preserves passthrough SetError extras (existingId)", () => {
  const outcome = setOutcome({
    notCreated: { k1: { type: "alreadyExists", existingId: "e7" } },
  });
  assertEquals(outcome.failed.k1.existingId, "e7");
});

Deno.test("expectResponse returns the matching call by id", () => {
  const responses: MethodResponse[] = [
    ["Email/query", { ids: ["e1"] }, "c1"],
    ["Email/get", { list: [{ id: "e1" }] }, "c2"],
  ];
  const got = expectResponse(responses, "Email/get", "c2");
  assertEquals((got.list as unknown[]).length, 1);
});

Deno.test("expectResponse throws JmapMethodError on an error slot", () => {
  const responses: MethodResponse[] = [
    ["error", { type: "invalidArguments", description: "bad" }, "c1"],
  ];
  let thrown: unknown;
  try {
    expectResponse(responses, "Email/get", "c1");
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof JmapMethodError);
  assertEquals((thrown as JmapMethodError).detail.type, "invalidArguments");
});

Deno.test("expectResponse throws when the call id is absent", () => {
  let thrown: unknown;
  try {
    expectResponse([["Email/get", {}, "c1"]], "Email/get", "c9");
  } catch (e) {
    thrown = e;
  }
  assert(thrown instanceof JmapMethodError);
});

function fixtureSession(core: Record<string, unknown>): JmapSession {
  return {
    apiUrl: "https://example/jmap/",
    capabilities: { "urn:ietf:params:jmap:core": core },
    accounts: {},
    primaryAccounts: {},
  };
}

Deno.test("coreLimits reads present values", () => {
  const limits = coreLimits(fixtureSession({
    maxSizeUpload: 1000,
    maxSizeRequest: 2000,
    maxCallsInRequest: 8,
    maxObjectsInGet: 100,
    maxObjectsInSet: 200,
  }));
  assertEquals(limits.maxObjectsInGet, 100);
  assertEquals(limits.maxObjectsInSet, 200);
  assertEquals(limits.maxCallsInRequest, 8);
});

Deno.test("coreLimits falls back to RFC minimums when absent/invalid", () => {
  const limits = coreLimits(fixtureSession({ maxObjectsInGet: 0 }));
  assertEquals(limits.maxObjectsInGet, 500);
  assertEquals(limits.maxObjectsInSet, 500);
  assertEquals(limits.maxCallsInRequest, 16);
});

Deno.test("coreLimits handles a session with no core capability", () => {
  const session: JmapSession = {
    apiUrl: "https://example/jmap/",
    capabilities: {},
    accounts: {},
    primaryAccounts: {},
  };
  assertEquals(coreLimits(session).maxObjectsInSet, 500);
});

Deno.test("SessionCache stores and returns within TTL", () => {
  const cache = new SessionCache(60_000);
  const session = fixtureSession({});
  cache.put("fp", session);
  assertEquals(cache.get("fp"), session);
});

Deno.test("SessionCache expires entries past TTL", () => {
  const cache = new SessionCache(-1); // already-expired on read
  cache.put("fp", fixtureSession({}));
  assertEquals(cache.get("fp"), undefined);
});

Deno.test("SessionCache invalidate drops the entry", () => {
  const cache = new SessionCache(60_000);
  cache.put("fp", fixtureSession({}));
  cache.invalidate("fp");
  assertEquals(cache.get("fp"), undefined);
});

Deno.test("mailboxRoleMap indexes roles, skips role-less mailboxes", () => {
  const mailboxes: Mailbox[] = [
    { id: "m1", name: "Inbox", role: "inbox" },
    { id: "m2", name: "Sent", role: "sent" },
    { id: "m3", name: "Project X" },
  ];
  const map = mailboxRoleMap(mailboxes);
  assertEquals(map.inbox, "m1");
  assertEquals(map.sent, "m2");
  assertEquals(Object.keys(map).sort(), ["inbox", "sent"]);
});
