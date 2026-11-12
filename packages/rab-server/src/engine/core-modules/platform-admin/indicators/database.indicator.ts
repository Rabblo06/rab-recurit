import type { DataSource } from 'typeorm';

import type { AdminHealthCard } from '../admin-health.service';

/**
 * Phase X Part 2, X2.4 — the database indicator. Twenty: `admin-panel/indicators/database.health.ts:28-100` (version,
 * active connections from the statistics views against `max_connections`, utilisation percent; up whenever the queries
 * answer). Re-implemented as ONE read-only SELECT on statistics views and settings — no table, no tenant data, no write:
 *  - connections = `sum(numbackends)` over `pg_stat_database` (client backends of every database in the cluster, which
 *    is what `max_connections` limits);
 *  - `max_connections` and `superuser_reserved_connections` from `current_setting`;
 *  - the server's major version from `server_version_num`.
 * The API's own pool (in use of max) is read from the driver in process, as before. The `warning` for a slow answer
 * (> 500 ms) is the existing Crewflow rule, unchanged; utilisation itself never changes the status (Twenty has no
 * threshold either) — it is shown for the operator to judge.
 */
export const DATABASE_INDICATOR_SQL = `SELECT
  (SELECT coalesce(sum(numbackends), 0) FROM pg_catalog.pg_stat_database)::int AS connections,
  current_setting('max_connections')::int AS max_connections,
  current_setting('superuser_reserved_connections')::int AS reserved_connections,
  current_setting('server_version_num')::int AS server_version_num`;

const SLOW_MS = 500;

interface DatabaseIndicatorRow {
  connections: number | string;
  max_connections: number | string;
  reserved_connections: number | string;
  server_version_num: number | string;
}

export async function databaseIndicator(dataSource: DataSource): Promise<AdminHealthCard> {
  const started = Date.now();
  const [row] = await dataSource.query<DatabaseIndicatorRow[]>(DATABASE_INDICATOR_SQL);
  const latencyMs = Date.now() - started;
  const connections = toInt(row?.connections);
  const max = toInt(row?.max_connections);
  const reserved = toInt(row?.reserved_connections);
  const versionNum = toInt(row?.server_version_num);
  if (connections === null || max === null || max <= 0) throw new Error('database indicator: unexpected statistics row');
  const percent = Math.round((connections / max) * 100);
  const major = versionNum !== null ? Math.floor(versionNum / 10_000) : null;

  const pool = (dataSource.driver as unknown as { master?: { totalCount?: number; idleCount?: number; options?: { max?: number } } }).master;
  const inUse = typeof pool?.totalCount === 'number' && typeof pool?.idleCount === 'number' ? pool.totalCount - pool.idleCount : null;
  const poolMax = typeof pool?.options?.max === 'number' ? pool.options.max : null;
  const poolText = inUse !== null && poolMax !== null ? `${inUse} of ${poolMax} in use` : null;

  return {
    key: 'database',
    status: latencyMs > SLOW_MS ? 'warning' : 'healthy',
    detail: `PostgreSQL${major !== null ? ` ${major}` : ''} · ${latencyMs} ms · ${connections} of ${max} connections (${percent}%)${poolText ? ` · pool ${poolText}` : ''}`,
    latencyMs,
    facts: [
      { label: 'Connections', value: `${connections} of ${max} (${percent}%)` },
      ...(reserved !== null ? [{ label: 'Reserved for superusers', value: String(reserved) }] : []),
      ...(poolText ? [{ label: 'This API process pool', value: poolText }] : []),
      ...(major !== null ? [{ label: 'Version', value: `PostgreSQL ${major}` }] : []),
    ],
  };
}

function toInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
