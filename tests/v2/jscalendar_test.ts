/**
 * JSCalendar / JSContact schema tests — valid & invalid fixtures for every superRefine invariant.
 * Covers core/schemas/jscalendar.ts + core/schemas/jscontact.ts (builder core:jscalendar).
 */
import {
  AlertSchema,
  EventCreateSchema,
  EventFilterConditionSchema,
  EventPatchSchema,
  NDaySchema,
  ParticipantSchema,
  RecurrenceRuleSchema,
} from "../../src/core/schemas/jscalendar.ts";
import {
  ContactCardSchema,
  ContactFilterConditionSchema,
} from "../../src/core/schemas/jscontact.ts";

/**
 * Local zero-dependency assertions — matches the tests/v2/jmap_test.ts convention (no @std/assert
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

// deno-lint-ignore no-explicit-any
const valid = (schema: any, input: unknown) => schema.safeParse(input).success === true;
// deno-lint-ignore no-explicit-any
const invalid = (schema: any, input: unknown) => schema.safeParse(input).success === false;

// ---------------------------------------------------------------------------------------------
// NDay
// ---------------------------------------------------------------------------------------------

Deno.test("NDay: @type default injected, nthOfPeriod non-zero", () => {
  assertEquals(NDaySchema.parse({ day: "mo" })["@type"], "NDay");
  assert(valid(NDaySchema, { day: "fr", nthOfPeriod: -1 }));
  assert(invalid(NDaySchema, { day: "mo", nthOfPeriod: 0 }));
  assert(invalid(NDaySchema, { day: "xx" }));
});

// ---------------------------------------------------------------------------------------------
// RecurrenceRule — count XOR until, byX bounds, byMonth "L" suffix
// ---------------------------------------------------------------------------------------------

Deno.test("RecurrenceRule: frequency required, @type default", () => {
  assert(invalid(RecurrenceRuleSchema, {}));
  assert(valid(RecurrenceRuleSchema, { frequency: "daily" }));
  assertEquals(RecurrenceRuleSchema.parse({ frequency: "weekly" })["@type"], "RecurrenceRule");
});

Deno.test("RecurrenceRule: count and until are mutually exclusive", () => {
  assert(valid(RecurrenceRuleSchema, { frequency: "daily", count: 10 }));
  assert(valid(RecurrenceRuleSchema, { frequency: "daily", until: "2026-12-31T00:00:00" }));
  assert(invalid(RecurrenceRuleSchema, {
    frequency: "daily",
    count: 10,
    until: "2026-12-31T00:00:00",
  }));
});

Deno.test("RecurrenceRule: byMonth strings with optional L suffix", () => {
  assert(valid(RecurrenceRuleSchema, { frequency: "yearly", byMonth: ["1", "12", "3L"] }));
  assert(invalid(RecurrenceRuleSchema, { frequency: "yearly", byMonth: ["13"] }));
  assert(invalid(RecurrenceRuleSchema, { frequency: "yearly", byMonth: ["0"] }));
  assert(invalid(RecurrenceRuleSchema, { frequency: "yearly", byMonth: [] })); // ≥1 required
});

Deno.test("RecurrenceRule: byDay NDay entries, bounded byX arrays", () => {
  assert(valid(RecurrenceRuleSchema, {
    frequency: "monthly",
    byDay: [{ day: "mo", nthOfPeriod: 2 }],
    byMonthDay: [1, -1],
    bySetPosition: [-1],
  }));
  assert(invalid(RecurrenceRuleSchema, { frequency: "monthly", byMonthDay: [0] }));
  assert(invalid(RecurrenceRuleSchema, { frequency: "hourly", byHour: [24] }));
  assert(valid(RecurrenceRuleSchema, { frequency: "secondly", bySecond: [60] })); // leap second
  assert(invalid(RecurrenceRuleSchema, { frequency: "daily", interval: 0 }));
});

// ---------------------------------------------------------------------------------------------
// Participant — Stalwart hybrid, roles set-of-true with unknown keys
// ---------------------------------------------------------------------------------------------

Deno.test("Participant: roles mandatory with ≥1 entry", () => {
  assert(invalid(ParticipantSchema, { name: "no roles" }));
  assert(invalid(ParticipantSchema, { roles: {} }));
  assert(valid(ParticipantSchema, { roles: { owner: true } }));
});

Deno.test("Participant: unknown role keys accepted (Stalwart 'required')", () => {
  assert(valid(ParticipantSchema, { roles: { required: true } }));
  assert(valid(ParticipantSchema, { roles: { attendee: true, "x-custom": true } }));
});

Deno.test("Participant: hybrid sendTo map OR calendarAddress string", () => {
  assert(valid(ParticipantSchema, { roles: { owner: true }, sendTo: { imip: "mailto:a@b.c" } }));
  assert(valid(ParticipantSchema, { roles: { attendee: true }, calendarAddress: "mailto:a@b.c" }));
  // "omit rather than {}" — empty sendTo rejected.
  assert(invalid(ParticipantSchema, { roles: { owner: true }, sendTo: {} }));
});

Deno.test("Participant: passthrough preserves unknown props", () => {
  const p = ParticipantSchema.parse({ roles: { owner: true }, scheduleStatus: ["2.0"] });
  // deno-lint-ignore no-explicit-any
  assertEquals((p as any).scheduleStatus, ["2.0"]);
});

// ---------------------------------------------------------------------------------------------
// Alert — discriminated OffsetTrigger / AbsoluteTrigger, preserved UnknownTrigger
// ---------------------------------------------------------------------------------------------

Deno.test("Alert: OffsetTrigger requires signed duration offset", () => {
  assert(valid(AlertSchema, { trigger: { "@type": "OffsetTrigger", offset: "-PT15M" } }));
  assert(valid(AlertSchema, {
    trigger: { "@type": "OffsetTrigger", offset: "PT0S", relativeTo: "end" },
  }));
  // malformed known trigger MUST NOT slip through to UnknownTrigger.
  assert(invalid(AlertSchema, { trigger: { "@type": "OffsetTrigger", offset: "15 minutes" } }));
});

Deno.test("Alert: AbsoluteTrigger requires UTCDateTime", () => {
  assert(
    valid(AlertSchema, { trigger: { "@type": "AbsoluteTrigger", when: "2026-07-08T10:00:00Z" } }),
  );
  assert(
    invalid(AlertSchema, { trigger: { "@type": "AbsoluteTrigger", when: "2026-07-08T10:00:00" } }),
  );
});

Deno.test("Alert: unknown trigger @type preserved", () => {
  assert(valid(AlertSchema, { trigger: { "@type": "GeoTrigger", where: "geo:1,2" } }));
  // snooze relation shape round-trips.
  assert(valid(AlertSchema, {
    trigger: { "@type": "AbsoluteTrigger", when: "2026-07-08T10:00:00Z" },
    relatedTo: { orig: { "@type": "Relation", relation: { parent: true } } },
    action: "display",
  }));
});

// ---------------------------------------------------------------------------------------------
// EventCreate — start required, server-set rejection, cross-field invariants
// ---------------------------------------------------------------------------------------------

Deno.test("EventCreate: start required unless utcStart used", () => {
  assert(valid(EventCreateSchema, { start: "2026-07-08T10:00:00", timeZone: "Europe/Berlin" }));
  assert(invalid(EventCreateSchema, { title: "no start" }));
  assert(valid(EventCreateSchema, { utcStart: "2026-07-08T10:00:00Z" }));
});

Deno.test("EventCreate: utcStart/utcEnd XOR start/duration", () => {
  assert(invalid(EventCreateSchema, {
    start: "2026-07-08T10:00:00",
    utcStart: "2026-07-08T10:00:00Z",
  }));
  assert(invalid(EventCreateSchema, { utcStart: "2026-07-08T10:00:00Z", duration: "PT1H" }));
  assert(valid(EventCreateSchema, {
    utcStart: "2026-07-08T10:00:00Z",
    utcEnd: "2026-07-08T11:00:00Z",
  }));
});

Deno.test("EventCreate: server-set props rejected", () => {
  for (
    const key of [
      "id",
      "uid",
      "baseEventId",
      "isOrigin",
      "sequence",
      "updated",
      "created",
      "organizerCalendarAddress",
    ]
  ) {
    assert(
      invalid(EventCreateSchema, {
        start: "2026-07-08T10:00:00",
        [key]: key === "isOrigin" ? true : "x",
      }),
      `expected ${key} to be rejected on create`,
    );
  }
});

Deno.test("EventCreate: recurrenceId invariants", () => {
  const base = { start: "2026-07-08T10:00:00" };
  // recurrenceId without its time zone → invalid.
  assert(invalid(EventCreateSchema, { ...base, recurrenceId: "2026-07-08T10:00:00" }));
  // recurrenceIdTimeZone without recurrenceId → invalid.
  assert(invalid(EventCreateSchema, { ...base, recurrenceIdTimeZone: "Europe/Berlin" }));
  // both together → valid.
  assert(valid(EventCreateSchema, {
    ...base,
    recurrenceId: "2026-07-08T10:00:00",
    recurrenceIdTimeZone: "Europe/Berlin",
  }));
  // recurrenceId excludes recurrenceRules and recurrenceOverrides.
  assert(invalid(EventCreateSchema, {
    ...base,
    recurrenceId: "2026-07-08T10:00:00",
    recurrenceIdTimeZone: "Europe/Berlin",
    recurrenceRules: [{ frequency: "daily" }],
  }));
  assert(invalid(EventCreateSchema, {
    ...base,
    recurrenceId: "2026-07-08T10:00:00",
    recurrenceIdTimeZone: "Europe/Berlin",
    recurrenceOverrides: { "2026-07-09T10:00:00": {} },
  }));
});

Deno.test("EventCreate: floating timeZone null and passthrough extensions", () => {
  assert(valid(EventCreateSchema, { start: "2026-07-08T10:00:00", timeZone: null }));
  const ev = EventCreateSchema.parse({ start: "2026-07-08T10:00:00", "x:foo": { a: 1 } });
  // deno-lint-ignore no-explicit-any
  assertEquals((ev as any)["x:foo"], { a: 1 });
});

Deno.test("EventCreate: hybrid replyTo map accepted", () => {
  assert(valid(EventCreateSchema, {
    start: "2026-07-08T10:00:00",
    replyTo: { imip: "mailto:organizer@b.c" },
    participants: { p1: { roles: { owner: true }, calendarAddress: "mailto:organizer@b.c" } },
  }));
});

Deno.test("EventCreate: recurrenceRule with count and byX round-trips", () => {
  assert(valid(EventCreateSchema, {
    start: "2026-07-08T10:00:00",
    timeZone: "Europe/Berlin",
    recurrenceRules: [{
      frequency: "monthly",
      byDay: [{ day: "we", nthOfPeriod: -1 }],
      count: 12,
    }],
  }));
});

// ---------------------------------------------------------------------------------------------
// EventPatch — no start requirement, still rejects server-set, still enforces invariants
// ---------------------------------------------------------------------------------------------

Deno.test("EventPatch: empty and partial patches valid; server-set still rejected", () => {
  assert(valid(EventPatchSchema, {}));
  assert(valid(EventPatchSchema, { title: "renamed" }));
  assert(invalid(EventPatchSchema, { uid: "reassign" }));
  assert(invalid(EventPatchSchema, {
    utcStart: "2026-07-08T10:00:00Z",
    start: "2026-07-08T10:00:00",
  }));
});

// ---------------------------------------------------------------------------------------------
// EventFilterCondition
// ---------------------------------------------------------------------------------------------

Deno.test("EventFilterCondition: inCalendar singular + LocalDateTime bounds", () => {
  assert(valid(EventFilterConditionSchema, {
    inCalendar: "cal1",
    after: "2026-07-01T00:00:00",
    before: "2026-08-01T00:00:00",
    text: "standup",
  }));
  // after/before are LocalDateTime, not UTCDateTime.
  assert(invalid(EventFilterConditionSchema, { after: "2026-07-01T00:00:00Z" }));
});

// ---------------------------------------------------------------------------------------------
// JSContact — tolerant passthrough
// ---------------------------------------------------------------------------------------------

Deno.test("ContactCard: typed slices + passthrough tolerance", () => {
  assert(valid(ContactCardSchema, {}));
  assert(valid(ContactCardSchema, {
    name: { full: "Jane Doe", components: [{ kind: "given", value: "Jane" }] },
    emails: { e1: { address: "jane@example.com", pref: 1 } },
    phones: { p1: { number: "+49 30 123", contexts: { work: true } } },
    organizations: { o1: { name: "Ashborn LLC" } },
    notes: { n1: { note: "met at conf" } },
  }));
  // unknown top-level props preserved.
  const c = ContactCardSchema.parse({ "x:custom": true });
  // deno-lint-ignore no-explicit-any
  assertEquals((c as any)["x:custom"], true);
  // typed subfield still enforced.
  assert(invalid(ContactCardSchema, { emails: { e1: { pref: 1 } } })); // missing address
});

Deno.test("ContactFilterCondition: loose text/email/name/uid + passthrough", () => {
  assert(valid(ContactFilterConditionSchema, { text: "daria" }));
  assert(valid(ContactFilterConditionSchema, { email: "a@b.c", extra: 1 }));
  assert(valid(ContactFilterConditionSchema, {}));
});
