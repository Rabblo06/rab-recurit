import { createHash } from 'node:crypto';

/**
 * Canonical JSON (PHASE5_TWENTY_PLAN §2.2): object keys sorted at every level, `undefined` members dropped, arrays kept
 * in order, `Date` as ISO-8601. Two snapshots of the same row state always serialise to the same string; any change in a
 * snapshotted field changes it. Refuses values that have no stable JSON form (functions, symbols, non-finite numbers,
 * bigint) — fail closed rather than hash something ambiguous.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

function normalise(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('canonicalJson: invalid date');
    return value.toISOString();
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : normalise(item)));
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const member = (value as Record<string, unknown>)[key];
        if (member !== undefined) out[key] = normalise(member);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
  }
}

/** SHA-256 (lower-case hex, 64 chars — the `ai_action_proposal.snapshot_hash` CHECK) of the canonical JSON. */
export function snapshotHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * SQL for a timestamptz snapshot field: UTC, microsecond precision, as text — a JS Date would drop the microseconds, so
 * two writes within the same millisecond could otherwise hash alike.
 */
export const snapshotTimestamp = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
