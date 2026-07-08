/**
 * CLI rendering: human tables on a TTY, machine JSON/NDJSON otherwise.
 * Owner: builder B11-frontends.
 *
 * The op handlers already brief-project their envelope items, so rendering works off flat objects.
 * Table columns are derived from the union of keys across the rendered rows (brief-projection
 * fields), with nested arrays/objects compacted to a single cell. NDJSON is emitted for list-shaped
 * envelopes so agents can pipe one object per line; scalar / non-list results print as one JSON
 * document.
 */
import { compactJson } from "../core/projections.ts";

export type OutputMode = "table" | "json" | "ndjson";

/** Decide the output mode from flags + TTY-ness. `--json[=…]` forces JSON; a TTY defaults to table. */
export function resolveOutputMode(opts: {
  json: boolean;
  isTty: boolean;
  list: boolean;
}): OutputMode {
  if (opts.json) return opts.list ? "ndjson" : "json";
  if (opts.isTty) return "table";
  // Piped without --json: agents still get stable JSON by default.
  return opts.list ? "ndjson" : "json";
}

/** True when the value is an Envelope-shaped result with an `items` array. */
export function isEnvelope(value: unknown): value is { items: unknown[]; [k: string]: unknown } {
  return !!value && typeof value === "object" &&
    Array.isArray((value as { items?: unknown }).items);
}

/** True when a handler returned a two-phase confirmation challenge. */
export function isConfirmChallenge(
  value: unknown,
): value is { confirmation_required: true; summary: string; confirm_token: string } {
  return !!value && typeof value === "object" &&
    (value as { confirmation_required?: unknown }).confirmation_required === true;
}

/**
 * Render a handler result to a string for stdout. `mode` chosen by resolveOutputMode; `rows` is the
 * projected item list when the result is an envelope (else the whole value is treated as one row).
 */
export function renderResult(value: unknown, mode: OutputMode): string {
  if (mode === "json") return compactJson(value);

  const rows = isEnvelope(value) ? value.items : [value];

  if (mode === "ndjson") {
    return rows.map((row) => compactJson(row)).join("\n");
  }

  // table
  return renderTable(rows) + envelopeFooter(value);
}

/** A `key: value` block for a single non-list object (e.g. whoami, a single event). */
function renderRecord(row: Record<string, unknown>): string {
  const keys = Object.keys(row);
  const width = keys.reduce((m, k) => Math.max(m, k.length), 0);
  return keys.map((k) => `${k.padEnd(width)}  ${cell(row[k])}`).join("\n");
}

/** Render an array of flat objects as a bordered column table; scalars/objects handled gracefully. */
export function renderTable(rows: unknown[]): string {
  if (rows.length === 0) return "(no results)";

  // A single object result reads better as a key/value block than a one-row table.
  if (rows.length === 1 && isPlainObject(rows[0])) {
    return renderRecord(rows[0] as Record<string, unknown>);
  }

  const objectRows = rows.filter(isPlainObject) as Record<string, unknown>[];
  if (objectRows.length !== rows.length) {
    // Mixed / scalar rows: fall back to one compact JSON per line.
    return rows.map((r) => cell(r)).join("\n");
  }

  const columns: string[] = [];
  for (const row of objectRows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const header = columns;
  const body = objectRows.map((row) => columns.map((col) => cell(row[col])));

  const widths = columns.map((col, i) => Math.max(col.length, ...body.map((r) => r[i].length), 0));

  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();

  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(header), sep, ...body.map(line)].join("\n");
}

/** Trailing summary line for envelope metadata (total / failed / not_found / state). */
function envelopeFooter(value: unknown): string {
  if (!isEnvelope(value)) return "";
  const parts: string[] = [];
  const env = value as Record<string, unknown>;
  parts.push(`${(env.items as unknown[]).length} item(s)`);
  if (typeof env.total === "number") parts.push(`total ${env.total}`);
  const failed = env.failed as Record<string, unknown> | undefined;
  if (failed && Object.keys(failed).length > 0) parts.push(`${Object.keys(failed).length} failed`);
  const notFound = env.not_found as unknown[] | undefined;
  if (Array.isArray(notFound) && notFound.length > 0) parts.push(`${notFound.length} not_found`);
  return "\n\n" + parts.join(" · ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Render one table cell: scalars verbatim, arrays joined, objects compacted to JSON. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => scalar(v)).join(", ");
  if (typeof value === "object") return compactJson(value);
  return scalar(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return compactJson(value);
  return String(value);
}
