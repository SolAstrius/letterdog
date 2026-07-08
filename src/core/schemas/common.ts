/**
 * Shared Zod building blocks: JMAP/JSCalendar scalars, set-as-map helper, common tool args.
 * Scalar schemas below are REAL (regexes verified against docs/rfc-notes); the file is owned by
 * builder B2-schemas-mail for additions. Do NOT remove todoSchema() until no stub references
 * remain anywhere (grep "todoSchema").
 */
import { z } from "zod";

/**
 * Placeholder for schemas whose real definition a builder still owes. Compiles and type-checks
 * as z.ZodType<T>; throws on first parse. Builders MUST replace usages in their own files.
 */
export function todoSchema<T>(what: string): z.ZodType<T> {
  return z.custom<T>(() => {
    throw new Error(`not implemented: ${what}`);
  });
}

/** JSCalendar Id: 1–255 octets, base64url alphabet (RFC 8984 §1.4.1). */
export const IdSchema = z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/);

/** Loose JMAP object id (Stalwart ids incl. synthetic instance ids are base64url-ish too). */
export const JmapIdSchema = z.string().min(1).max(255);

/** Batch ids argument — batch-first policy: singular use = array of one. */
export const IdsSchema = z.array(JmapIdSchema).min(1).max(500);

/**
 * RFC 8984 UTCDateTime: uppercase letters, literal Z, fractional seconds only when non-zero
 * and without trailing zeros (canonical single representation).
 */
export const UTC_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?Z$/;
export const UtcDateTimeSchema = z.string().regex(
  UTC_DATETIME_RE,
  "expected UTCDateTime like 2026-07-08T10:00:00Z",
);

/** RFC 8984 LocalDateTime: same, but NO zone/offset info at all (no Z, no offset). */
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d*[1-9])?$/;
export const LocalDateTimeSchema = z.string().regex(
  LOCAL_DATETIME_RE,
  "expected LocalDateTime like 2026-07-08T10:00:00 (no Z/offset)",
);

/** RFC 8984 Duration subset: P[nW][nD][T[nH][nM][nS[.frac]]], non-negative, canonical fractions. */
const DURATION_BODY = "P(?!$)(\\d+W)?(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d*[1-9])?S)?)?";
export const DURATION_RE = new RegExp(`^${DURATION_BODY}$`);
export const DurationSchema = z.string().regex(
  DURATION_RE,
  "expected ISO-8601 duration like PT1H30M",
);

/** RFC 8984 SignedDuration: optional +/- prefix; negative = at-or-before the anchor. */
export const SIGNED_DURATION_RE = new RegExp(`^[+-]?${DURATION_BODY}$`);
export const SignedDurationSchema = z.string().regex(
  SIGNED_DURATION_RE,
  "expected signed duration like -PT15M",
);

/** IANA TZDB name or custom id starting with "/" (RFC 8984 §1.4.10). */
export const TimeZoneIdSchema = z.string().min(1);

/** Set-as-map: {"key": true, ...} — keywords, roles, features, mailboxIds… */
export function setOfTrue() {
  return z.record(z.string(), z.literal(true));
}

/**
 * PatchObject: JSON-Pointer keys with implicit leading "/", null = remove. Pointer rules
 * (no in-array pointers, existing intermediates, no prefix pairs) are validated at the server;
 * ops re-state them in descriptions rather than re-implementing RFC 6901 here.
 */
export const PatchObjectSchema = z.record(z.string(), z.unknown());

/** Read-op projection selector; brief is the default EVERYWHERE (design "Output economy"). */
export const ProjectionSchema = z.enum(["brief", "full", "raw"]).default("brief");

/** Surgical extras on top of brief — names follow the projected (snake_case) field names. */
export const FieldsSchema = z.array(z.string().min(1)).optional();

/** List page size; total is opt-in via calculate_total. */
export const LimitSchema = z.number().int().min(1).max(200).default(25);

/** Explicit account override; defaults resolve via JmapClient.resolveAccount. */
export const AccountIdSchema = z.string().min(1).optional();

/** Two-phase confirmation token (self-contained HMAC, embeds its own expiry). */
export const ConfirmTokenSchema = z.string().min(16).optional();
