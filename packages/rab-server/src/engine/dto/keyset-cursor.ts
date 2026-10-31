import { BadRequestException } from '@nestjs/common';

/**
 * Phase C1 (contract §3): the ONE opaque keyset cursor shared by every list endpoint that offers cursor paging
 * (`/offers/mine`, `/attendance/me/history`, `/shifts/sent`, `/shifts/requests`).
 *
 * The cursor is ONLY an ordering bound: base64url of `{"v":1,"t":<timestamp>,"i":<id>}` — the (timestamp, id) of the last
 * row of the previous page, for an `ORDER BY <timestamp> DESC, id DESC` walk. It carries no tenant, workspace, user,
 * scope or filter: every query that accepts it re-applies tenant context, RLS and the caller's own scope exactly as it
 * does without one, so a forged or foreign cursor can only move the starting point inside rows the caller may already
 * see (never another tenant's ids). Anything that is not exactly this shape is a 400, never a silently ignored bound.
 *
 * The timestamp travels as text with MICROSECOND precision (`2026-10-30T12:34:56.123456Z`), produced by PostgreSQL
 * (`keysetTimestampSql`) and bound back as `$n::timestamptz`. A JS `Date` would truncate to milliseconds, and a bound
 * that is a fraction of a millisecond too high/low would skip or repeat rows that share the same millisecond.
 */
export interface KeysetPosition {
  /** ISO-8601 UTC timestamp with exactly six fractional digits, e.g. `2026-10-30T12:34:56.123456Z`. */
  t: string;
  /** The row id (UUID, lower-case) — the tie-breaker for rows with the same timestamp. */
  i: string;
}

/** Longest cursor accepted. A real one is ~114 characters; anything longer is rejected before decoding. */
export const KEYSET_CURSOR_MAX_LENGTH = 160;

const CURSOR_VERSION = 1;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(): never {
  throw new BadRequestException('Invalid cursor.');
}

/** True for a real calendar instant in the strict `TIMESTAMP` shape (rejects 2026-02-30, 24:00, 23:59:60 ...). */
function isStrictTimestamp(value: string): boolean {
  const m = TIMESTAMP.exec(value);
  if (!m) return false;
  // Year 0 is valid for JS Date but not for PostgreSQL (no year zero AD): it would be a 500 at the ::timestamptz cast.
  if (Number(m[1]) < 1) return false;
  // Re-format the millisecond prefix through Date and require an exact round trip: any out-of-range component is
  // either rejected by Date (NaN) or normalised into a different string (Feb 30 -> Mar 2).
  const millis = `${value.slice(0, 23)}Z`;
  const parsed = new Date(millis);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === millis;
}

export function encodeKeysetCursor(position: KeysetPosition): string {
  if (!isStrictTimestamp(position.t) || !UUID.test(position.i)) throw new Error('Refusing to encode an invalid keyset position.');
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, t: position.t, i: position.i }), 'utf8').toString('base64url');
}

/**
 * Strict decode. Throws 400 `Invalid cursor.` for anything that is not a cursor this server would have produced:
 * over-long input, non-base64url characters, non-canonical base64url, non-JSON, extra/missing keys, a wrong version, a
 * timestamp that is not an exact UTC microsecond instant, or an id that is not a UUID.
 */
export function decodeKeysetCursor(raw: string): KeysetPosition {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > KEYSET_CURSOR_MAX_LENGTH || !BASE64URL.test(raw)) invalid();
  const bytes = Buffer.from(raw, 'base64url');
  // Canonical form only: one cursor value per position (no padding variants or trailing garbage bits).
  if (bytes.toString('base64url') !== raw) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    invalid();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) invalid();
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'i' || keys[1] !== 't' || keys[2] !== 'v') invalid();
  if (record.v !== CURSOR_VERSION || typeof record.t !== 'string' || typeof record.i !== 'string') invalid();
  const id = record.i.toLowerCase();
  if (!isStrictTimestamp(record.t) || !UUID.test(id)) invalid();
  return { t: record.t, i: id };
}

/** Optional-cursor convenience for services: `undefined`/empty -> first page. */
export function decodeOptionalKeysetCursor(raw: string | undefined): KeysetPosition | null {
  return raw === undefined || raw === '' ? null : decodeKeysetCursor(raw);
}

/**
 * SQL rendering a timestamptz column as the cursor's exact text form (UTC, microseconds). `column` is a trusted SQL
 * expression built in code (an alias.column), never client input.
 */
export function keysetTimestampSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * The `ORDER BY ts DESC, id DESC` page bound: rows strictly after the cursor position in that order. A row comparison,
 * so a `(…, ts DESC, id DESC)` btree index can serve it as an index condition. `tsParam`/`idParam` are placeholders
 * (`$n` or `:name`) bound to `position.t` / `position.i`.
 */
export function keysetBeforeSql(tsColumn: string, idColumn: string, tsParam: string, idParam: string): string {
  return `(${tsColumn}, ${idColumn}) < (${tsParam}::timestamptz, ${idParam}::uuid)`;
}

/**
 * Splits a `take + 1` fetch into the page and its `nextCursor` (null = no more rows). `position` reads the keyset
 * position of a row (the `keysetTimestampSql` text column + the row id).
 */
export function keysetPage<T>(rows: T[], take: number, position: (row: T) => KeysetPosition): { data: T[]; nextCursor: string | null } {
  if (rows.length <= take) return { data: rows, nextCursor: null };
  const data = rows.slice(0, take);
  return { data, nextCursor: encodeKeysetCursor(position(data[data.length - 1]!)) };
}
