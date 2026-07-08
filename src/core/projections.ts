/**
 * Projections — brief/full/raw shaping per object type; brief is the default EVERYWHERE.
 * CONTRACT STUB — TODO(builder: B4-projections-query). Brief interfaces are normative (they ARE
 * the design's "Output economy" table); function bodies throw.
 *
 * Rules:
 * - "raw" = spec-shape passthrough (faithfulness one arg away). "full" = raw minus token sinks
 *   (bodyStructure trees, bodyValues) with addresses/mailboxes still resolved.
 * - `fields` adds surgical extras onto brief (names = projected snake_case field names).
 * - Output is compact JSON: use compactJson() at the frontends, never pretty-print.
 */
import type { Email, Mailbox, Principal } from "./jmap/types.ts";
import type { ContactCard } from "./schemas/jscontact.ts";
import type { TypedEvent } from "./schemas/jscalendar.ts";
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

export function projectEmail(
  _raw: Email,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefEmail | Record<string, unknown> {
  throw new Error("not implemented: core/projections projectEmail");
}

export function projectEvent(
  _raw: TypedEvent,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefEvent | Record<string, unknown> {
  throw new Error("not implemented: core/projections projectEvent");
}

export function projectMailbox(
  _raw: Mailbox,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): Record<string, unknown> {
  throw new Error("not implemented: core/projections projectMailbox");
}

export function projectCalendar(
  _raw: Record<string, unknown>,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefCalendar | Record<string, unknown> {
  throw new Error("not implemented: core/projections projectCalendar");
}

export function projectContact(
  _raw: ContactCard,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefContact | Record<string, unknown> {
  throw new Error("not implemented: core/projections projectContact");
}

export function projectPerson(
  _raw: ContactCard | Principal,
  _kind: "contact" | "principal",
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefPerson | Record<string, unknown> {
  throw new Error("not implemented: core/projections projectPerson");
}

export function projectBusyPeriod(
  _raw: Record<string, unknown>,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): BriefBusyPeriod | Record<string, unknown> {
  throw new Error("not implemented: core/projections projectBusyPeriod");
}

/** Generic dispatcher keyed by an op's ProjectionKey ("none"/"raw" pass through). */
export function project(
  _kind: ProjectionKey,
  _raw: unknown,
  _mode: ProjectionMode,
  _ctx: ProjectionContext,
): unknown {
  throw new Error("not implemented: core/projections project");
}

/** Compute event end = start + duration in the event's zone (DST-correct, Temporal-based). */
export function computeEnd(
  _start: string,
  _duration: string | undefined,
  _timeZone: string | null | undefined,
): string {
  throw new Error("not implemented: core/projections computeEnd");
}

/** Compact-JSON printer used by both frontends (no pretty-printing — token economy). */
export function compactJson(value: unknown): string {
  return JSON.stringify(value);
}
