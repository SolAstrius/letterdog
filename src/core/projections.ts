/**
 * Projections — brief/full/raw shaping per object type; brief is the default EVERYWHERE.
 * Owner: builder B4-projections-query. Brief interfaces are normative (they ARE the design's
 * "Output economy" table).
 *
 * Rules:
 * - "raw" = spec-shape passthrough (faithfulness one arg away). "full" = raw minus token sinks
 *   (bodyStructure trees, bodyValues) with addresses/mailboxes still resolved.
 * - `fields` adds surgical extras onto brief (names = projected snake_case field names).
 * - Output is compact JSON: use compactJson() at the frontends, never pretty-print.
 * - Event `end` is COMPUTED from start+duration in the event's time zone (models don't do
 *   ISO-8601 arithmetic). DST-correct via Temporal, RFC 8984 duration-add order (date parts
 *   first, then time parts).
 */
import type { Email, Identity, Mailbox, Principal } from "./jmap/types.ts";
import type { ContactCard } from "./schemas/jscontact.ts";
import type { Participant, TypedEvent } from "./schemas/jscalendar.ts";
import type { ProjectionKey } from "./ops/registry.ts";

export type ProjectionMode = "brief" | "full" | "raw";

/** Resolution context the projectors need; ops populate what they have. */
export interface ProjectionContext {
  /** mailbox id → {name, role} for resolving Email.mailboxIds to ["inbox", …]. */
  mailboxes?: Map<string, { name: string; role?: string | null }>;
  /** calendar id → name. */
  calendars?: Map<string, string>;
  /** The caller's own addresses (identity emails + participant calendarAddresses, lowercased). */
  ownAddresses?: string[];
  /** Extra brief fields requested via the `fields` arg. */
  fields?: string[];
  /** Display time zone for computed event end. */
  timeZone?: string;
}

/** Design table row: Email brief. */
export interface BriefEmail {
  id: string;
  thread_id?: string;
  /** Flattened "Name <addr>". */
  from?: string;
  to?: string[];
  cc?: string[];
  subject?: string | null;
  received_at?: string;
  /** ≤120 chars. */
  preview?: string;
  /** Keywords collapsed to one field, e.g. "unread flagged" ("" = read, nothing notable). */
  flags?: string;
  /** Mailbox ids resolved to role/name, e.g. ["inbox"]. */
  mailboxes?: string[];
  has_attachment?: boolean;
}

/** Design table row: Event brief. end is COMPUTED from start+duration (models don't do ISO math). */
export interface BriefEvent {
  id: string;
  base_event_id?: string;
  title?: string;
  start?: string;
  end?: string;
  time_zone?: string | null;
  /** Calendar name(s), resolved. */
  calendar?: string;
  location?: string;
  /** VirtualLocation uri. */
  virtual?: string;
  participants?: { count: number; own_status?: string };
  recurring?: boolean;
  status?: string;
}

export interface BriefContact {
  id: string;
  name?: string;
  emails?: string[];
  phones?: string[];
  org?: string;
}

export interface BriefCalendar {
  id: string;
  name: string;
  /** e.g. "personal", "shared by <owner>" — whatever helps routing. */
  role_hints?: string;
  is_default?: boolean;
  /** Flattened CalendarRights, e.g. "read write share". */
  my_rights?: string;
}

export interface BriefBusyPeriod {
  start: string;
  end: string;
  status: "confirmed" | "tentative" | "unavailable";
}

/** search_people result — contacts and principals in one list. */
export interface BriefPerson {
  id: string;
  kind: "contact" | "principal";
  name?: string;
  emails?: string[];
  calendar_address?: string;
  principal_type?: string;
}

/** Mailbox brief — a compact, routing-useful slice. */
export interface BriefMailbox {
  id: string;
  name: string;
  role?: string | null;
  parent_id?: string | null;
  total?: number;
  unread?: number;
}

/** Identity brief — for list_identities. */
export interface BriefIdentity {
  id: string;
  name?: string;
  email: string;
  may_delete?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** deno-lint safe access to Temporal (Deno ships it; types may lag). */
// deno-lint-ignore no-explicit-any
const Temporal: any = (globalThis as any).Temporal;

/** Flatten an EmailAddress-like value to `"Name <addr>"` (or just `<addr>` when unnamed). */
function flattenAddress(a: { name?: string | null; email?: string | null } | null | undefined):
  | string
  | undefined {
  if (!a || !a.email) return undefined;
  const name = a.name?.trim();
  return name ? `${name} <${a.email}>` : a.email;
}

function flattenAddressList(
  list: ({ name?: string | null; email?: string | null } | null)[] | null | undefined,
): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  const out: string[] = [];
  for (const a of list) {
    const s = flattenAddress(a ?? undefined);
    if (s) out.push(s);
  }
  return out.length ? out : undefined;
}

/** Map JMAP keyword set → compact human flags string. Absence of $seen ⇒ "unread". */
function keywordsToFlags(keywords: Record<string, boolean> | undefined): string {
  const flags: string[] = [];
  const kw = keywords ?? {};
  // $seen means read; its absence means unread — surface the actionable state.
  if (!kw["$seen"]) flags.push("unread");
  if (kw["$flagged"]) flags.push("flagged");
  if (kw["$answered"]) flags.push("answered");
  if (kw["$forwarded"]) flags.push("forwarded");
  if (kw["$draft"]) flags.push("draft");
  if (kw["$junk"]) flags.push("junk");
  // Preserve any non-system keywords (user labels) after the system ones. Skip blank keys —
  // Stalwart has been observed serving a literal `"": true` keyword.
  for (const k of Object.keys(kw)) {
    if (!kw[k]) continue;
    if (!k.startsWith("$") && k.trim() !== "") flags.push(k);
  }
  return flags.join(" ");
}

/** Resolve mailbox ids to role (preferred) or name via the provided map. */
function resolveMailboxes(
  ids: Record<string, boolean> | undefined,
  map: ProjectionContext["mailboxes"],
): string[] | undefined {
  if (!ids) return undefined;
  const out: string[] = [];
  for (const id of Object.keys(ids)) {
    if (!ids[id]) continue;
    const mb = map?.get(id);
    if (mb) out.push(mb.role || mb.name || id);
    else out.push(id);
  }
  return out.length ? out : undefined;
}

/** Truncate to n chars (grapheme-naive but byte-safe: operates on JS string length). */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n);
}

/**
 * Attach any requested extra `fields` from the raw object onto a projected brief object.
 * Field names are the projected snake_case names; unknown fields fall back to the raw camelCase
 * key of the same name if present. Never overwrites an already-set brief field.
 */
function applyFields<T extends object>(
  brief: T,
  raw: Record<string, unknown>,
  fields: string[] | undefined,
): T {
  if (!fields || fields.length === 0) return brief;
  const target = brief as Record<string, unknown>;
  for (const f of fields) {
    if (f in target && target[f] !== undefined) continue;
    if (f in raw) {
      target[f] = raw[f];
      continue;
    }
    // snake_case → camelCase fallback for spec-shaped raw objects.
    const camel = f.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
    if (camel in raw) target[f] = raw[camel];
  }
  return brief;
}

// ---------------------------------------------------------------------------
// Event end computation (DST-correct, Temporal-based)
// ---------------------------------------------------------------------------

/**
 * Compute event end = start + duration in the event's zone (DST-correct).
 *
 * `start` is a LocalDateTime (no zone/offset). `duration` is an RFC 8984 Duration
 * (`P[nW][nD][T[nH][nM][nS]]`, never negative). `timeZone` is an IANA id, or null/undefined for
 * a floating event.
 *
 * RFC 8984 §2 duration-add order: add the date (calendar) parts first, then convert to absolute
 * time, add the time parts, convert back. Temporal's `ZonedDateTime.add(Duration)` already
 * applies exactly this order, so a single `add` is correct across DST transitions:
 *   - `P1D` across spring-forward preserves wall-clock (+1 calendar day, 23 real hours),
 *   - `PT24H` across the same boundary advances 24 real hours (wall-clock jumps +1h).
 *
 * Returns a LocalDateTime string (matching the input's zone-less shape). Falls back to returning
 * `start` unchanged if inputs are unparseable, so a projector never throws.
 */
export function computeEnd(
  start: string,
  duration: string | undefined,
  timeZone: string | null | undefined,
): string {
  if (!start) return start;
  const dur = duration && duration !== "PT0S" ? duration : undefined;
  if (!dur) return start; // zero/absent duration ⇒ end === start.
  try {
    const durObj = Temporal.Duration.from(dur);
    if (timeZone) {
      const zdt = Temporal.PlainDateTime.from(start).toZonedDateTime(timeZone);
      const ended = zdt.add(durObj);
      // Return LocalDateTime (zone-less) to match the input shape; the zone lives in time_zone.
      return ended.toPlainDateTime().toString();
    }
    // Floating event: pure wall-clock arithmetic, no zone.
    const pdt = Temporal.PlainDateTime.from(start);
    return pdt.add(durObj).toString();
  } catch {
    return start;
  }
}

// ---------------------------------------------------------------------------
// Participant resolution (Stalwart hybrid tolerant: sendTo map OR calendarAddress string)
// ---------------------------------------------------------------------------

/** Extract a participant's address, tolerant of the Stalwart hybrid shape. */
function participantAddress(p: Participant): string | undefined {
  if (p.calendarAddress) return stripMailto(p.calendarAddress);
  const sendTo = p.sendTo;
  if (sendTo) {
    const uri = sendTo["imip"] ?? Object.values(sendTo)[0];
    if (uri) return stripMailto(uri);
  }
  if (p.email) return p.email.toLowerCase();
  return undefined;
}

function stripMailto(uri: string): string {
  return uri.replace(/^mailto:/i, "").toLowerCase();
}

/** Find the caller's own participation status among an event's participants. */
function ownParticipationStatus(
  participants: Record<string, Participant> | undefined,
  ownAddresses: string[] | undefined,
): string | undefined {
  if (!participants || !ownAddresses || ownAddresses.length === 0) return undefined;
  const own = new Set(ownAddresses.map((a) => stripMailto(a)));
  for (const p of Object.values(participants)) {
    const addr = participantAddress(p);
    if (addr && own.has(addr)) return p.participationStatus ?? "needs-action";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Projectors
// ---------------------------------------------------------------------------

export function projectEmail(
  raw: Email,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefEmail | Record<string, unknown> {
  if (mode === "raw") return raw as Record<string, unknown>;
  if (mode === "full") {
    // Raw minus token sinks; addresses/mailboxes still resolved for convenience.
    const { bodyStructure: _bs, bodyValues: _bv, ...rest } = raw;
    const full = { ...rest } as Record<string, unknown>;
    full.from = flattenAddress(raw.from?.[0] ?? undefined);
    full.to = flattenAddressList(raw.to);
    full.cc = flattenAddressList(raw.cc);
    full.mailboxes = resolveMailboxes(raw.mailboxIds, ctx.mailboxes);
    full.flags = keywordsToFlags(raw.keywords);
    return full;
  }
  const brief: BriefEmail = { id: raw.id };
  if (raw.threadId) brief.thread_id = raw.threadId;
  const from = flattenAddress(raw.from?.[0] ?? undefined);
  if (from) brief.from = from;
  const to = flattenAddressList(raw.to);
  if (to) brief.to = to;
  const cc = flattenAddressList(raw.cc);
  if (cc) brief.cc = cc;
  if (raw.subject !== undefined) brief.subject = raw.subject;
  if (raw.receivedAt) brief.received_at = raw.receivedAt;
  if (raw.preview !== undefined) brief.preview = clip(raw.preview, 120);
  if (raw.keywords !== undefined) brief.flags = keywordsToFlags(raw.keywords);
  const mailboxes = resolveMailboxes(raw.mailboxIds, ctx.mailboxes);
  if (mailboxes) brief.mailboxes = mailboxes;
  if (raw.hasAttachment !== undefined) brief.has_attachment = raw.hasAttachment;
  return applyFields(brief, raw as unknown as Record<string, unknown>, ctx.fields);
}

export function projectEvent(
  raw: TypedEvent,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefEvent | Record<string, unknown> {
  if (mode === "raw") return raw as Record<string, unknown>;

  const zone = raw.timeZone ?? ctx.timeZone ?? null;
  // Prefer the DST-correct computed local end when a duration is present so brief start/end stay
  // in the SAME representation (both LocalDateTime in the event zone); utcEnd is the fallback for
  // events/instances carrying no duration; a start with neither means a zero-duration end.
  const computedEnd = raw.start && (raw.duration || !raw.utcEnd)
    ? computeEnd(raw.start, raw.duration, zone)
    : undefined;

  if (mode === "full") {
    const full = { ...raw } as Record<string, unknown>;
    if (raw.start) full.end = computedEnd ?? raw.utcEnd;
    if (raw.calendarIds) {
      full.calendar = resolveCalendars(raw.calendarIds, ctx.calendars);
    }
    return full;
  }

  const brief: BriefEvent = { id: raw.id ?? "" };
  if (raw.baseEventId) brief.base_event_id = raw.baseEventId;
  if (raw.title !== undefined) brief.title = raw.title;
  if (raw.start !== undefined) brief.start = raw.start;
  const end = computedEnd ?? raw.utcEnd;
  if (end !== undefined) brief.end = end;
  brief.time_zone = zone;
  const calendar = resolveCalendars(raw.calendarIds, ctx.calendars);
  if (calendar) brief.calendar = calendar;
  const location = firstLocationName(raw);
  if (location) brief.location = location;
  const virtual = firstVirtualUri(raw);
  if (virtual) brief.virtual = virtual;
  if (raw.participants && Object.keys(raw.participants).length > 0) {
    const own = ownParticipationStatus(raw.participants, ctx.ownAddresses);
    brief.participants = {
      count: Object.keys(raw.participants).length,
      ...(own ? { own_status: own } : {}),
    };
  }
  // Hybrid-tolerant: RFC 8984 plural `recurrenceRules` OR the Stalwart v0.16 bis-style singular
  // `recurrenceRule` (observed live; same class of hybrid as sendTo/calendarAddress).
  const singularRule = (raw as Record<string, unknown>).recurrenceRule;
  brief.recurring = !!(raw.recurrenceRules && raw.recurrenceRules.length > 0) ||
    (singularRule !== undefined && singularRule !== null) ||
    !!(raw.recurrenceOverrides && Object.keys(raw.recurrenceOverrides).length > 0);
  if (raw.status !== undefined) brief.status = raw.status;
  return applyFields(brief, raw as unknown as Record<string, unknown>, ctx.fields);
}

function resolveCalendars(
  ids: Record<string, true> | undefined,
  map: ProjectionContext["calendars"],
): string | undefined {
  if (!ids) return undefined;
  const names: string[] = [];
  for (const id of Object.keys(ids)) {
    if (!ids[id]) continue;
    names.push(map?.get(id) ?? id);
  }
  return names.length ? names.join(", ") : undefined;
}

function firstLocationName(raw: TypedEvent): string | undefined {
  if (!raw.locations) return undefined;
  for (const loc of Object.values(raw.locations)) {
    if (loc?.name) return loc.name;
  }
  return undefined;
}

function firstVirtualUri(raw: TypedEvent): string | undefined {
  if (!raw.virtualLocations) return undefined;
  for (const v of Object.values(raw.virtualLocations)) {
    if (v?.uri) return v.uri;
  }
  return undefined;
}

export function projectMailbox(
  raw: Mailbox,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefMailbox | Record<string, unknown> {
  if (mode === "raw" || mode === "full") return raw as Record<string, unknown>;
  const brief: BriefMailbox = { id: raw.id, name: raw.name };
  if (raw.role !== undefined) brief.role = raw.role;
  if (raw.parentId !== undefined) brief.parent_id = raw.parentId;
  if (raw.totalEmails !== undefined) brief.total = raw.totalEmails;
  if (raw.unreadEmails !== undefined) brief.unread = raw.unreadEmails;
  return applyFields(brief, raw as unknown as Record<string, unknown>, ctx.fields);
}

export function projectCalendar(
  raw: Record<string, unknown>,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefCalendar | Record<string, unknown> {
  if (mode === "raw" || mode === "full") return raw;
  const brief: BriefCalendar = {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
  };
  const roleHints = calendarRoleHints(raw);
  if (roleHints) brief.role_hints = roleHints;
  if (typeof raw.isDefault === "boolean") brief.is_default = raw.isDefault;
  const rights = flattenCalendarRights(raw.myRights);
  if (rights) brief.my_rights = rights;
  return applyFields(brief, raw, ctx.fields);
}

function calendarRoleHints(raw: Record<string, unknown>): string | undefined {
  const hints: string[] = [];
  // Ownership/share hints, tolerant of provider shape.
  if (raw.isSubscribed === false) hints.push("unsubscribed");
  const shareWith = raw.shareWith;
  if (shareWith && typeof shareWith === "object" && Object.keys(shareWith).length > 0) {
    hints.push("shared");
  }
  if (typeof raw.color === "string" && raw.color) hints.push(`color:${raw.color}`);
  return hints.length ? hints.join(" ") : undefined;
}

/** Flatten a CalendarRights-like object to a compact "read write share" string. */
function flattenCalendarRights(rights: unknown): string | undefined {
  if (!rights || typeof rights !== "object") return undefined;
  const r = rights as Record<string, unknown>;
  const parts: string[] = [];
  if (r.mayReadItems || r.mayRead) parts.push("read");
  if (r.mayWriteAll || r.mayWriteOwn || r.mayAddItems || r.mayUpdatePrivate) parts.push("write");
  if (r.mayAdmin || r.mayShare) parts.push("share");
  if (r.mayDelete) parts.push("delete");
  return parts.length ? parts.join(" ") : undefined;
}

export function projectContact(
  raw: ContactCard,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefContact | Record<string, unknown> {
  if (mode === "raw" || mode === "full") return raw as Record<string, unknown>;
  const brief: BriefContact = { id: raw.id ?? raw.uid ?? "" };
  const name = contactName(raw);
  if (name) brief.name = name;
  const emails = contactEmails(raw);
  if (emails) brief.emails = emails;
  const phones = contactPhones(raw);
  if (phones) brief.phones = phones;
  const org = contactOrg(raw);
  if (org) brief.org = org;
  return applyFields(brief, raw as unknown as Record<string, unknown>, ctx.fields);
}

function contactName(raw: ContactCard): string | undefined {
  const n = raw.name;
  if (n?.full) return n.full;
  if (n?.components && n.components.length > 0) {
    return n.components.map((c) => c.value).filter(Boolean).join(" ") || undefined;
  }
  return undefined;
}

function contactEmails(raw: ContactCard): string[] | undefined {
  if (!raw.emails) return undefined;
  const out: string[] = [];
  for (const e of Object.values(raw.emails)) {
    if (e?.address) out.push(e.address);
  }
  return out.length ? out : undefined;
}

function contactPhones(raw: ContactCard): string[] | undefined {
  if (!raw.phones) return undefined;
  const out: string[] = [];
  for (const p of Object.values(raw.phones)) {
    if (p?.number) out.push(p.number);
  }
  return out.length ? out : undefined;
}

function contactOrg(raw: ContactCard): string | undefined {
  if (!raw.organizations) return undefined;
  for (const o of Object.values(raw.organizations)) {
    if (o?.name) return o.name;
  }
  return undefined;
}

export function projectPerson(
  raw: ContactCard | Principal,
  kind: "contact" | "principal",
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefPerson | Record<string, unknown> {
  if (mode === "raw" || mode === "full") return raw as Record<string, unknown>;
  const brief: BriefPerson = { id: String((raw as { id?: string }).id ?? ""), kind };
  if (kind === "contact") {
    const c = raw as ContactCard;
    const name = contactName(c);
    if (name) brief.name = name;
    const emails = contactEmails(c);
    if (emails) brief.emails = emails;
  } else {
    const p = raw as Principal;
    if (p.name) brief.name = p.name;
    if (p.email) brief.emails = [p.email];
    if (p.type) brief.principal_type = p.type;
    const ca = principalCalendarAddress(p);
    if (ca) brief.calendar_address = ca;
  }
  return applyFields(brief, raw as unknown as Record<string, unknown>, ctx.fields);
}

function principalCalendarAddress(p: Principal): string | undefined {
  const caps = p.capabilities;
  if (!caps) return undefined;
  const cal = caps["urn:ietf:params:jmap:calendars"];
  const addr = cal?.["calendarAddress"];
  return typeof addr === "string" ? addr : undefined;
}

export function projectBusyPeriod(
  raw: Record<string, unknown>,
  mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefBusyPeriod | Record<string, unknown> {
  if (mode === "raw" || mode === "full") return raw;
  // Normalize freeBusyStatus/status → the design's precedence-ordered enum.
  const start = String(raw.start ?? raw.utcStart ?? "");
  const end = String(raw.end ?? raw.utcEnd ?? "");
  const status = normalizeBusyStatus(raw);
  return { start, end, status };
}

function normalizeBusyStatus(
  raw: Record<string, unknown>,
): "confirmed" | "tentative" | "unavailable" {
  // Accept either an event-style "status" or a free-busy "freeBusyStatus"/"busyStatus".
  const s = String(
    raw.busyStatus ?? raw.status ?? raw.freeBusyStatus ?? "",
  ).toLowerCase();
  if (s === "tentative") return "tentative";
  if (s === "confirmed" || s === "busy") return "confirmed";
  // Anything else that made it into a busy period is treated as blocking time.
  return "unavailable";
}

export function projectIdentity(
  raw: Identity,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): BriefIdentity | Record<string, unknown> {
  if (mode === "raw" || mode === "full") return raw as Record<string, unknown>;
  const brief: BriefIdentity = { id: raw.id, email: raw.email };
  if (raw.name !== undefined) brief.name = raw.name;
  if (raw.mayDelete !== undefined) brief.may_delete = raw.mayDelete;
  return applyFields(brief, raw as unknown as Record<string, unknown>, ctx.fields);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Generic dispatcher keyed by an op's ProjectionKey. "none"/"raw"/"session"/"notification"/
 * "thread"/"blob" pass through untouched (no dedicated projector — the op shapes those itself).
 */
export function project(
  kind: ProjectionKey,
  raw: unknown,
  mode: ProjectionMode,
  ctx: ProjectionContext,
): unknown {
  switch (kind) {
    case "email":
      return projectEmail(raw as Email, mode, ctx);
    case "event":
      return projectEvent(raw as TypedEvent, mode, ctx);
    case "mailbox":
      return projectMailbox(raw as Mailbox, mode, ctx);
    case "calendar":
      return projectCalendar(raw as Record<string, unknown>, mode, ctx);
    case "contact":
      return projectContact(raw as ContactCard, mode, ctx);
    case "person": {
      // Distinguish a Principal (has "type") from a Card ("@type" === "Card").
      const r = raw as Record<string, unknown>;
      const isPrincipal = typeof r.type === "string" && r["@type"] !== "Card";
      return projectPerson(
        raw as ContactCard | Principal,
        isPrincipal ? "principal" : "contact",
        mode,
        ctx,
      );
    }
    case "busy":
      return projectBusyPeriod(raw as Record<string, unknown>, mode, ctx);
    case "identity":
      return projectIdentity(raw as Identity, mode, ctx);
    case "thread":
    case "notification":
    case "blob":
    case "session":
    case "raw":
    case "none":
    default:
      return raw;
  }
}

/** Compact-JSON printer used by both frontends (no pretty-printing — token economy). */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// HTML → text (server-side body conversion; cuts email bodies 5–20×)
// ---------------------------------------------------------------------------

import { convert as htmlConvert } from "html-to-text";

/**
 * Convert HTML to plain text, capped at `maxLen` chars (UTF-8-safe: char-based, never splits a
 * surrogate pair). Falls back to a naive tag-strip if the dep throws. `maxLen <= 0` ⇒ no cap.
 */
export function htmlToText(html: string, maxLen?: number): string {
  let text: string;
  try {
    text = htmlConvert(html, {
      wordwrap: false,
      selectors: [
        { selector: "img", format: "skip" },
        { selector: "a", options: { ignoreHref: false } },
      ],
    });
  } catch {
    text = stripTags(html);
  }
  return capChars(text, maxLen);
}

/** Naive fallback: strip tags, decode a few common entities, collapse whitespace. */
function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cap a string at `maxLen` *characters* without splitting a UTF-16 surrogate pair. If the cap
 * would land between a high and low surrogate, drop the dangling high surrogate.
 */
function capChars(s: string, maxLen?: number): string {
  if (maxLen === undefined || maxLen <= 0 || s.length <= maxLen) return s;
  let cut = s.slice(0, maxLen);
  const last = cut.charCodeAt(cut.length - 1);
  // High surrogate range D800–DBFF: a trailing lone high surrogate means we split a pair.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}
