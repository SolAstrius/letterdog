import { parseBearerHeader } from "../src/auth.ts";
import { READ_ONLY_METHOD_RE } from "../src/constants.ts";

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
