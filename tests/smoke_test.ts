import { parseAuthorizationHeader, parseBearerHeader } from "../src/auth.ts";
import { READ_ONLY_METHOD_RE } from "../src/constants.ts";
import { calendarEventQueryArgs } from "../src/tools/calendar.ts";
import { emailModifyPatch, parseMailSearchQuery } from "../src/tools/mail.ts";

Deno.test("parseBearerHeader accepts bearer tokens case-insensitively", () => {
  if (parseBearerHeader("Bearer abc123") !== "abc123") throw new Error("Bearer token not parsed");
  if (parseBearerHeader("bearer xyz") !== "xyz") throw new Error("lowercase bearer not parsed");
  if (parseBearerHeader("Basic abc123") !== undefined) throw new Error("non-bearer parsed");
});

Deno.test("parseAuthorizationHeader accepts bearer and basic pass-through", () => {
  if (parseAuthorizationHeader("Bearer abc123") !== "Bearer abc123") {
    throw new Error("Bearer authorization not parsed");
  }
  if (parseAuthorizationHeader("Basic abc123") !== "Basic abc123") {
    throw new Error("Basic authorization not parsed");
  }
  if (parseAuthorizationHeader("abc123") !== undefined) {
    throw new Error("scheme-less authorization should be rejected");
  }
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

Deno.test("mail search parser maps Gmail-like operators to JMAP filters", () => {
  const parsed = parseMailSearchQuery(
    'from:store@example.com has:attachment is:unread after:2026/07/01 label:"Newsletters"',
    [
      { id: "inbox", name: "Inbox", role: "inbox" },
      { id: "m-news", name: "Newsletters" },
    ],
  );

  const conditions = (parsed.filter.conditions as Record<string, unknown>[]) ?? [];
  if (parsed.filter.operator !== "AND") throw new Error("operator filters should be ANDed");
  if (!conditions.some((condition) => condition.from === "store@example.com")) {
    throw new Error("from operator was not translated");
  }
  if (!conditions.some((condition) => condition.hasAttachment === true)) {
    throw new Error("has:attachment was not translated");
  }
  if (!conditions.some((condition) => condition.notKeyword === "$seen")) {
    throw new Error("is:unread was not translated");
  }
  if (!conditions.some((condition) => condition.inMailbox === "m-news")) {
    throw new Error("label name was not resolved to mailbox id");
  }
});

Deno.test("mail search parser reports unsupported Gmail operators", () => {
  const parsed = parseMailSearchQuery("category:promotions filename:pdf receipt");
  if (parsed.unsupported.join(",") !== "category:promotions,filename:pdf") {
    throw new Error("unsupported operators should be reported");
  }
  if (parsed.filter.text !== "receipt") throw new Error("free text should still be searched");
});

Deno.test("email modify patch maps mailbox ids and keywords", () => {
  const patch = emailModifyPatch({
    addMailboxIds: ["label-a"],
    removeMailboxIds: ["inbox"],
    addKeywords: ["$seen"],
    removeKeywords: ["$flagged"],
  });

  if (patch["mailboxIds/label-a"] !== true) throw new Error("label add patch missing");
  if (patch["mailboxIds/inbox"] !== null) throw new Error("label remove patch missing");
  if (patch["keywords/$seen"] !== true) throw new Error("keyword add patch missing");
  if (patch["keywords/$flagged"] !== null) throw new Error("keyword remove patch missing");
});
