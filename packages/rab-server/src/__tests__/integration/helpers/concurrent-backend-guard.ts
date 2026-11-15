/**
 * The "is a second test process running against this database?" check of the suites that TRUNCATE core.organisation
 * (ops-owner-login, containment-suspend-test-accounts): other CLIENT sessions of this database with a query in flight.
 * Only `backend_type = 'client backend'` counts: autovacuum and other background workers also show as `active` rows of the
 * database (C1-STATUS C1b.9) but are not a concurrent test process that could see or need the truncated data.
 */
export function otherActiveClientBackendsSql(source = 'pg_stat_activity'): string {
  if (!/^[a-z_]+$/.test(source)) throw new Error('otherActiveClientBackendsSql: invalid source relation');
  return `SELECT count(*)::int AS n FROM ${source}
    WHERE datname = current_database() AND pid != pg_backend_pid() AND state = 'active' AND backend_type = 'client backend'`;
}

export interface GuardQueryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Other active client sessions of this database right now (the guard's count). */
export async function otherActiveClientBackends(db: GuardQueryable): Promise<number> {
  const rows = (await db.query(otherActiveClientBackendsSql())) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
