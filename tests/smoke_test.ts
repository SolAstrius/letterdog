import { parseBearerHeader } from "../src/auth.ts";
import { READ_ONLY_METHOD_RE } from "../src/constants.ts";
import { calendarEventQueryArgs } from "../src/tools/calendar.ts";

Deno.test("parseBearerHeader accepts bearer tokens case-insensitively", () => {
  if (parseBearerHeader("Bearer abc123") !== "abc123") throw new Error("Bearer token not parsed");
  if (parseBearerHeader("bearer xyz") !== "xyz") throw new Error("lowercase bearer not parsed");
  if (parseBearerHeader("Basic abc123") !== undefined) throw new Error("non-bearer parsed");
});

Deno.test("read-only JMAP method classifier separates mutation methods", () => {
  if (!READ_ONLY_METHOD_RE.test("CalendarEvent/get")) throw new Error("get should be read-only");
  if (!READ_ONLY_METHOD_RE.test("Principal/getAvailability")) {
    throw new Error("getAvailability should be read-only");
  }
  if (READ_ONLY_METHOD_RE.test("CalendarEvent/set")) throw new Error("set should be mutating");
});

Deno.test("bounded calendar event searches expand recurrences by default", () => {
  const args = calendarEventQueryArgs({
    accountId: "b",
    calendar_ids: ["c"],
    time_min: "2026-07-06T00:00:00+03:00",
    time_max: "2026-07-13T00:00:00+03:00",
    calculateTotal: true,
  });

  if (args.expandRecurrences !== true) {
    throw new Error("bounded event searches should request expanded recurrence instances");
  }
  const filter = args.filter as Record<string, unknown>;
  if (filter.operator !== "AND") throw new Error("calendar and time filters should be combined");
});

Deno.test("calendar event searches allow recurrence expansion opt-out", () => {
  const args = calendarEventQueryArgs({
    accountId: "b",
    calendar_ids: ["c"],
    time_min: "2026-07-06T00:00:00+03:00",
    time_max: "2026-07-13T00:00:00+03:00",
    expand_recurrences: false,
  });

  if (args.expandRecurrences !== false) {
    throw new Error("explicit recurrence expansion opt-out should be preserved");
  }
});
