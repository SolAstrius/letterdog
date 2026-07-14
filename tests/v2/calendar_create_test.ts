/**
 * event.create defaults — regression guard for the missing-uid iTIP bug.
 *
 * Stalwart v0.16.11 does NOT auto-assign a UID on JMAP CalendarEvent/set create. An event without
 * a UID makes iTIP scheduling silently no-op (itip_snapshot → MissingUid, swallowed by the server),
 * so send_invitations never emails external attendees. applyEventCreateDefaults mints the uid so
 * invitations actually deliver; these tests lock that in (plus the default-calendar / is_draft folds).
 */
import { assert, assertEquals } from "@std/assert";
import { applyEventCreateDefaults } from "../../src/core/ops/calendar.ts";
import type { TypedEvent } from "../../src/core/schemas/jscalendar.ts";

const ev = (o: Record<string, unknown>) => o as unknown as TypedEvent;

Deno.test("applyEventCreateDefaults mints a uid when the event has none (iTIP needs it)", () => {
  const body = applyEventCreateDefaults(ev({ title: "x" }), { uid: "gen-uid-1" });
  assertEquals(body.uid, "gen-uid-1", "a uid must be assigned or invitations silently fail");
  assert(body.uid && body.uid.length > 0);
});

Deno.test("applyEventCreateDefaults preserves an existing uid", () => {
  const body = applyEventCreateDefaults(ev({ title: "x", uid: "keep-me" }), { uid: "gen-uid-1" });
  assertEquals(body.uid, "keep-me");
});

Deno.test("applyEventCreateDefaults defaults calendarIds only when absent", () => {
  const defaulted = applyEventCreateDefaults(ev({ title: "x" }), {
    uid: "u",
    fallbackCalendarId: "b",
  });
  assertEquals(defaulted.calendarIds, { b: true });

  const explicit = applyEventCreateDefaults(ev({ title: "x", calendarIds: { c: true } }), {
    uid: "u",
    fallbackCalendarId: "b",
  });
  assertEquals(explicit.calendarIds, { c: true }, "an explicit calendar must be respected");
});

Deno.test("applyEventCreateDefaults folds is_draft when requested", () => {
  const draft = applyEventCreateDefaults(ev({ title: "x" }), { uid: "u", isDraft: true });
  assertEquals(draft.isDraft, true);
  const notDraft = applyEventCreateDefaults(ev({ title: "x" }), { uid: "u" });
  assertEquals(notDraft.isDraft, undefined);
});

Deno.test("applyEventCreateDefaults sets an organizer when the event has participants and none", () => {
  const body = applyEventCreateDefaults(
    ev({ title: "x", participants: { g: { calendarAddress: "mailto:g@ext.com" } } }),
    { uid: "u", organizerAddress: "mailto:me@astrius.ink" },
  );
  assertEquals(body.organizerCalendarAddress, "mailto:me@astrius.ink");
});

Deno.test("applyEventCreateDefaults does not set an organizer without participants", () => {
  const body = applyEventCreateDefaults(ev({ title: "x" }), {
    uid: "u",
    organizerAddress: "mailto:me@astrius.ink",
  });
  assertEquals(body.organizerCalendarAddress, undefined);
});

Deno.test("applyEventCreateDefaults respects an existing organizer (organizerCalendarAddress or replyTo)", () => {
  const a = applyEventCreateDefaults(
    ev({
      title: "x",
      participants: { g: { calendarAddress: "mailto:g@ext.com" } },
      organizerCalendarAddress: "mailto:keep@astrius.ink",
    }),
    { uid: "u", organizerAddress: "mailto:me@astrius.ink" },
  );
  assertEquals(a.organizerCalendarAddress, "mailto:keep@astrius.ink");

  const b = applyEventCreateDefaults(
    ev({
      title: "x",
      participants: { g: { calendarAddress: "mailto:g@ext.com" } },
      replyTo: { imip: "mailto:keep@astrius.ink" },
    }),
    { uid: "u", organizerAddress: "mailto:me@astrius.ink" },
  );
  assertEquals(b.organizerCalendarAddress, undefined, "replyTo already provides the organizer");
});

Deno.test("applyEventCreateDefaults does not mutate the input event", () => {
  const input = ev({ title: "x", participants: { g: { calendarAddress: "mailto:g@ext.com" } } });
  applyEventCreateDefaults(input, {
    uid: "u",
    fallbackCalendarId: "b",
    isDraft: true,
    organizerAddress: "mailto:me@astrius.ink",
  });
  assertEquals(input.uid, undefined);
  assertEquals(input.calendarIds, undefined);
  assertEquals(input.isDraft, undefined);
  assertEquals(input.organizerCalendarAddress, undefined);
});
