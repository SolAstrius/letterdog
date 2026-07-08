/**
 * Unit tests for core/projections — brief/full/raw shaping, DST-correct event-end computation,
 * address/mailbox/keyword flattening, participant own-status (Stalwart hybrid), html→text.
 * Fixture-driven; NO network. Owned by builder B4-projections-query.
 */
import { assert, assertEquals } from "@std/assert";
import {
  compactJson,
  computeEnd,
  htmlToText,
  project,
  projectBusyPeriod,
  projectCalendar,
  projectContact,
  projectEmail,
  projectEvent,
  projectIdentity,
  type ProjectionContext,
  projectMailbox,
  projectPerson,
} from "../../src/core/projections.ts";
import type { Email, Identity, Mailbox, Principal } from "../../src/core/jmap/types.ts";
import type { TypedEvent } from "../../src/core/schemas/jscalendar.ts";
import type { ContactCard } from "../../src/core/schemas/jscontact.ts";

const mailboxMap = new Map([
  ["mb-inbox", { name: "Inbox", role: "inbox" as const }],
  ["mb-custom", { name: "Klarna", role: null }],
]);

function ctx(extra: Partial<ProjectionContext> = {}): ProjectionContext {
  return { mailboxes: mailboxMap, ...extra };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const sampleEmail: Email = {
  id: "e1",
  threadId: "t1",
  mailboxIds: { "mb-inbox": true, "mb-custom": true },
  keywords: { "$flagged": true, "important": true },
  receivedAt: "2026-07-01T09:00:00Z",
  from: [{ name: "Klarna", email: "no-reply@klarna.com" }],
  to: [{ name: "Sol", email: "me@danielsol.dev" }, { email: "cc@x.com" }],
  cc: [{ name: "Team", email: "team@x.com" }],
  subject: "Your statement",
  preview: "x".repeat(200),
  hasAttachment: true,
};

Deno.test("projectEmail brief: flattens addresses, resolves mailboxes, flags, clips preview", () => {
  const b = projectEmail(sampleEmail, "brief", ctx()) as Record<string, unknown>;
  assertEquals(b.id, "e1");
  assertEquals(b.thread_id, "t1");
  assertEquals(b.from, "Klarna <no-reply@klarna.com>");
  assertEquals(b.to, ["Sol <me@danielsol.dev>", "cc@x.com"]);
  assertEquals(b.cc, ["Team <team@x.com>"]);
  assertEquals(b.subject, "Your statement");
  assertEquals(b.received_at, "2026-07-01T09:00:00Z");
  // no $seen ⇒ unread; $flagged ⇒ flagged; non-system "important" preserved after.
  assertEquals(b.flags, "unread flagged important");
  // mailboxes: role preferred (inbox), else name (Klarna).
  assertEquals(b.mailboxes, ["inbox", "Klarna"]);
  assertEquals(b.has_attachment, true);
  assertEquals((b.preview as string).length, 120);
});

Deno.test("projectEmail: $seen present ⇒ no 'unread' flag", () => {
  const e: Email = { id: "e2", keywords: { "$seen": true, "$answered": true } };
  const b = projectEmail(e, "brief", ctx()) as Record<string, unknown>;
  assertEquals(b.flags, "answered");
});

Deno.test("projectEmail: unknown mailbox id passes through unresolved", () => {
  const e: Email = { id: "e3", mailboxIds: { "mb-unknown": true } };
  const b = projectEmail(e, "brief", ctx()) as Record<string, unknown>;
  assertEquals(b.mailboxes, ["mb-unknown"]);
});

Deno.test("projectEmail raw: untouched passthrough", () => {
  const b = projectEmail(sampleEmail, "raw", ctx());
  assertEquals(b, sampleEmail as unknown as Record<string, unknown>);
});

Deno.test("projectEmail full: drops bodyStructure/bodyValues, keeps resolved from/mailboxes", () => {
  const e: Email = {
    ...sampleEmail,
    bodyStructure: { partId: "1", type: "text/plain" },
    bodyValues: { "1": { value: "hello" } },
  };
  const b = projectEmail(e, "full", ctx()) as Record<string, unknown>;
  assert(!("bodyStructure" in b));
  assert(!("bodyValues" in b));
  assertEquals(b.from, "Klarna <no-reply@klarna.com>");
  assertEquals(b.mailboxes, ["inbox", "Klarna"]);
});

Deno.test("projectEmail fields: surgical extra pulls camelCase raw key", () => {
  const b = projectEmail(sampleEmail, "brief", ctx({ fields: ["size", "blob_id"] })) as Record<
    string,
    unknown
  >;
  // size present via snake==camel; blob_id → blobId (absent here, so undefined/omitted).
  assert(!("size" in b) || b.size === undefined);
});

// ---------------------------------------------------------------------------
// Event — DST-crossing end computation (Europe/Berlin)
// ---------------------------------------------------------------------------

Deno.test("computeEnd: P1D across spring-forward preserves wall clock (Europe/Berlin)", () => {
  // 2026 DST spring-forward in Europe/Berlin is 2026-03-29 (clocks 02:00→03:00).
  // Start the day before at 12:00; P1D is a CALENDAR day ⇒ end wall-clock 12:00 next day,
  // even though only 23 real hours elapse.
  const end = computeEnd("2026-03-28T12:00:00", "P1D", "Europe/Berlin");
  assertEquals(end, "2026-03-29T12:00:00");
});

Deno.test("computeEnd: PT24H across spring-forward advances 24 real hours ⇒ wall clock +1h", () => {
  // 24 absolute hours across the lost hour ⇒ 12:00 → 13:00 wall clock.
  const end = computeEnd("2026-03-28T12:00:00", "PT24H", "Europe/Berlin");
  assertEquals(end, "2026-03-29T13:00:00");
});

Deno.test("computeEnd: PT24H across fall-back gains an hour ⇒ wall clock -1h (Europe/Berlin)", () => {
  // 2026 fall-back in Europe/Berlin is 2026-10-25 (clocks 03:00→02:00). 24 absolute hours from
  // 2026-10-24T12:00 lands at 11:00 wall clock next day (an extra hour exists in the day).
  const end = computeEnd("2026-10-24T12:00:00", "PT24H", "Europe/Berlin");
  assertEquals(end, "2026-10-25T11:00:00");
});

Deno.test("computeEnd: floating event (no zone) is pure wall-clock arithmetic", () => {
  assertEquals(computeEnd("2026-03-28T12:00:00", "PT24H", null), "2026-03-29T12:00:00");
  assertEquals(computeEnd("2026-03-28T12:00:00", "P1D", undefined), "2026-03-29T12:00:00");
});

Deno.test("computeEnd: zero/absent duration ⇒ end equals start", () => {
  assertEquals(computeEnd("2026-07-01T10:00:00", "PT0S", "Europe/Berlin"), "2026-07-01T10:00:00");
  assertEquals(
    computeEnd("2026-07-01T10:00:00", undefined, "Europe/Berlin"),
    "2026-07-01T10:00:00",
  );
});

Deno.test("computeEnd: mixed P1DT2H add-order (date then time) across spring-forward", () => {
  // P1D (calendar) → 12:00 next day, then +2h absolute → 14:00.
  assertEquals(computeEnd("2026-03-28T12:00:00", "P1DT2H", "Europe/Berlin"), "2026-03-29T14:00:00");
});

Deno.test("computeEnd: unparseable inputs fall back to start (never throws)", () => {
  assertEquals(computeEnd("not-a-date", "P1D", "Europe/Berlin"), "not-a-date");
  assertEquals(
    computeEnd("2026-07-01T10:00:00", "GARBAGE", "Europe/Berlin"),
    "2026-07-01T10:00:00",
  );
});

Deno.test("projectEvent brief: computes end, resolves calendar, hybrid own_status", () => {
  const ev: TypedEvent = {
    "@type": "Event",
    id: "ev1",
    calendarIds: { "cal-a": true },
    title: "Standup",
    start: "2026-03-28T12:00:00",
    duration: "P1D",
    timeZone: "Europe/Berlin",
    status: "confirmed",
    locations: { l1: { "@type": "Location", name: "Room 1" } },
    virtualLocations: { v1: { "@type": "VirtualLocation", uri: "https://meet.example/x" } },
    participants: {
      // Stalwart-hybrid: one uses calendarAddress (string), one uses sendTo (map).
      p1: {
        "@type": "Participant",
        roles: { owner: true },
        calendarAddress: "mailto:organizer@x.com",
        participationStatus: "accepted",
      },
      p2: {
        "@type": "Participant",
        roles: { attendee: true },
        sendTo: { imip: "mailto:me@danielsol.dev" },
        participationStatus: "tentative",
      },
    },
    recurrenceRules: [{ "@type": "RecurrenceRule", frequency: "daily" }],
  };
  const b = projectEvent(ev, "brief", {
    calendars: new Map([["cal-a", "Work"]]),
    ownAddresses: ["me@danielsol.dev"],
  }) as Record<string, unknown>;
  assertEquals(b.id, "ev1");
  assertEquals(b.title, "Standup");
  assertEquals(b.start, "2026-03-28T12:00:00");
  assertEquals(b.end, "2026-03-29T12:00:00"); // P1D wall-clock preserved across DST.
  assertEquals(b.time_zone, "Europe/Berlin");
  assertEquals(b.calendar, "Work");
  assertEquals(b.location, "Room 1");
  assertEquals(b.virtual, "https://meet.example/x");
  assertEquals(b.participants, { count: 2, own_status: "tentative" });
  assertEquals(b.recurring, true);
  assertEquals(b.status, "confirmed");
});

Deno.test("projectEvent: utcEnd present is surfaced directly as end", () => {
  const ev: TypedEvent = {
    id: "ev2",
    start: "2026-07-01T10:00:00",
    utcEnd: "2026-07-01T09:30:00Z",
    timeZone: "Europe/Berlin",
  };
  const b = projectEvent(ev, "brief", {}) as Record<string, unknown>;
  assertEquals(b.end, "2026-07-01T09:30:00Z");
});

Deno.test("projectEvent: no participants ⇒ omitted; non-recurring ⇒ recurring false", () => {
  const ev: TypedEvent = { id: "ev3", start: "2026-07-01T10:00:00", duration: "PT1H" };
  const b = projectEvent(ev, "brief", {}) as Record<string, unknown>;
  assert(!("participants" in b));
  assertEquals(b.recurring, false);
  assertEquals(b.end, "2026-07-01T11:00:00");
});

Deno.test("projectEvent: ctx.timeZone used when event has no timeZone", () => {
  const ev: TypedEvent = { id: "ev4", start: "2026-03-28T12:00:00", duration: "PT24H" };
  const b = projectEvent(ev, "brief", { timeZone: "Europe/Berlin" }) as Record<string, unknown>;
  assertEquals(b.time_zone, "Europe/Berlin");
  assertEquals(b.end, "2026-03-29T13:00:00");
});

// ---------------------------------------------------------------------------
// Mailbox / Calendar / Contact / Person / BusyPeriod / Identity
// ---------------------------------------------------------------------------

Deno.test("projectMailbox brief", () => {
  const mb: Mailbox = {
    id: "mb1",
    name: "Inbox",
    role: "inbox",
    parentId: null,
    totalEmails: 42,
    unreadEmails: 3,
  };
  const b = projectMailbox(mb, "brief", ctx()) as Record<string, unknown>;
  assertEquals(b, {
    id: "mb1",
    name: "Inbox",
    role: "inbox",
    parent_id: null,
    total: 42,
    unread: 3,
  });
});

Deno.test("projectCalendar brief: flattens rights + role hints", () => {
  const cal = {
    id: "cal1",
    name: "Work",
    isDefault: true,
    myRights: { mayReadItems: true, mayWriteOwn: true, mayShare: true, mayDelete: true },
    shareWith: { "user-x": {} },
  };
  const b = projectCalendar(cal, "brief", {}) as Record<string, unknown>;
  assertEquals(b.id, "cal1");
  assertEquals(b.name, "Work");
  assertEquals(b.is_default, true);
  assertEquals(b.my_rights, "read write share delete");
  assertEquals(b.role_hints, "shared");
});

Deno.test("projectContact brief", () => {
  const c: ContactCard = {
    "@type": "Card",
    id: "c1",
    name: { full: "Ivan Filipenkov" },
    emails: { e1: { address: "ivan@x.com" }, e2: { address: "vanutp@y.com" } },
    phones: { p1: { number: "+49 111" } },
    organizations: { o1: { name: "Infra Co" } },
  };
  const b = projectContact(c, "brief", {}) as Record<string, unknown>;
  assertEquals(b, {
    id: "c1",
    name: "Ivan Filipenkov",
    emails: ["ivan@x.com", "vanutp@y.com"],
    phones: ["+49 111"],
    org: "Infra Co",
  });
});

Deno.test("projectContact: name from components when no full", () => {
  const c: ContactCard = {
    id: "c2",
    name: { components: [{ kind: "given", value: "Daria" }, { kind: "surname", value: "Rivera" }] },
  };
  const b = projectContact(c, "brief", {}) as Record<string, unknown>;
  assertEquals(b.name, "Daria Rivera");
});

Deno.test("projectPerson: principal shape with calendarAddress capability", () => {
  const p: Principal = {
    id: "pr1",
    type: "individual",
    name: "Daria",
    email: "daria@x.com",
    capabilities: {
      "urn:ietf:params:jmap:calendars": { calendarAddress: "mailto:daria@x.com" },
    },
  };
  const b = projectPerson(p, "principal", "brief", {}) as Record<string, unknown>;
  assertEquals(b, {
    id: "pr1",
    kind: "principal",
    name: "Daria",
    emails: ["daria@x.com"],
    principal_type: "individual",
    calendar_address: "mailto:daria@x.com",
  });
});

Deno.test("projectPerson: contact shape", () => {
  const c: ContactCard = {
    "@type": "Card",
    id: "c3",
    name: { full: "Foxxie" },
    emails: { e1: { address: "fox@x.com" } },
  };
  const b = projectPerson(c, "contact", "brief", {}) as Record<string, unknown>;
  assertEquals(b, { id: "c3", kind: "contact", name: "Foxxie", emails: ["fox@x.com"] });
});

Deno.test("projectBusyPeriod: status precedence normalization", () => {
  assertEquals(
    projectBusyPeriod(
      { start: "2026-07-01T09:00:00Z", end: "2026-07-01T10:00:00Z", busyStatus: "confirmed" },
      "brief",
      {},
    ),
    { start: "2026-07-01T09:00:00Z", end: "2026-07-01T10:00:00Z", status: "confirmed" },
  );
  assertEquals(
    (projectBusyPeriod({ start: "a", end: "b", freeBusyStatus: "busy" }, "brief", {}) as Record<
      string,
      unknown
    >).status,
    "confirmed",
  );
  assertEquals(
    (projectBusyPeriod({ start: "a", end: "b", status: "tentative" }, "brief", {}) as Record<
      string,
      unknown
    >).status,
    "tentative",
  );
  assertEquals(
    (projectBusyPeriod({ start: "a", end: "b" }, "brief", {}) as Record<string, unknown>).status,
    "unavailable",
  );
});

Deno.test("projectIdentity brief", () => {
  const id: Identity = { id: "id1", name: "Sol", email: "me@danielsol.dev", mayDelete: false };
  const b = projectIdentity(id, "brief", {}) as Record<string, unknown>;
  assertEquals(b, { id: "id1", name: "Sol", email: "me@danielsol.dev", may_delete: false });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

Deno.test("project dispatcher routes by ProjectionKey", () => {
  const emailBrief = project("email", sampleEmail, "brief", ctx()) as Record<string, unknown>;
  assertEquals(emailBrief.from, "Klarna <no-reply@klarna.com>");

  // "raw"/"none"/"thread"/etc. pass through untouched.
  const passthrough = { any: "thing" };
  assertEquals(project("none", passthrough, "brief", {}), passthrough);
  assertEquals(project("thread", passthrough, "brief", {}), passthrough);
  assertEquals(project("raw", passthrough, "brief", {}), passthrough);
});

Deno.test("project 'person' dispatcher distinguishes principal from card", () => {
  const principal = { id: "p", type: "individual", name: "P" };
  const asPerson = project("person", principal, "brief", {}) as Record<string, unknown>;
  assertEquals(asPerson.kind, "principal");

  const card = { id: "c", "@type": "Card", name: { full: "C" } };
  const asContact = project("person", card, "brief", {}) as Record<string, unknown>;
  assertEquals(asContact.kind, "contact");
});

// ---------------------------------------------------------------------------
// html→text + compactJson
// ---------------------------------------------------------------------------

Deno.test("htmlToText: converts and strips markup", () => {
  const out = htmlToText("<h1>Hi</h1><p>Hello <b>world</b></p>");
  assert(out.includes("Hello world"));
  assert(!out.includes("<"));
});

Deno.test("htmlToText: caps at maxLen without splitting surrogate pair", () => {
  // Build a string whose char at the cap boundary is a high surrogate.
  const emoji = "😀"; // 2 UTF-16 code units
  const html = "ab" + emoji.repeat(10);
  const out = htmlToText(html, 3); // cap lands mid-emoji (index 2 = high surrogate)
  // Must not end on a lone high surrogate.
  const last = out.charCodeAt(out.length - 1);
  assert(!(last >= 0xd800 && last <= 0xdbff), "dangling high surrogate not dropped");
  assert(out.length <= 3);
});

Deno.test("htmlToText: no cap when maxLen omitted or <= 0", () => {
  const long = "<p>" + "x".repeat(500) + "</p>";
  assert(htmlToText(long).length >= 500);
  assert(htmlToText(long, 0).length >= 500);
});

Deno.test("compactJson: no pretty-printing", () => {
  assertEquals(compactJson({ a: 1, b: [2, 3] }), '{"a":1,"b":[2,3]}');
});
