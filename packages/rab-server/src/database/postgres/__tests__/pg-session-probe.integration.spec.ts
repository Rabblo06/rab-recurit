import { Client } from 'pg';

import { createPgClient, createPgDataSource, pgClientConfig } from '../create-pg-pool';
import { resolvePgEnvironment } from '../pg-config';
import { probePgSessionAffinity, PgSessionProbeError } from '../pg-session-probe';

// Phase B (B1/P4), against the disposable test database (TEST_DATABASE_URL, the restricted runtime role):
//   - the session probe passes on a direct connection;
//   - the libpq-style startup options really reach the server (statement_timeout, idle_in_transaction_session_timeout,
//     application_name), for a plain Client and for a TypeORM DataSource built by the factory.
// Optional: PGBOUNCER_TRANSACTION_URL (a throwaway PgBouncer in transaction mode in front of the same database) proves
// the probe refuses a real transaction pooler.
const appUrl = process.env.TEST_DATABASE_URL;
const describeDb = appUrl ? describe : describe.skip;

describeDb('pg factory against a real PostgreSQL', () => {
  const resolved = () => resolvePgEnvironment({ PG_DATABASE_URL: appUrl }, { processRole: 'worker' });

  it('the session probe passes on a direct connection and leaves no probe lock behind', async () => {
    const result = await probePgSessionAffinity(pgClientConfig(resolved(), { endpoint: 'lock', purpose: 'probe', statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }));
    expect(result.pidA).not.toBe(result.pidB);
    const check = createPgClient(resolved(), { purpose: 'probe' });
    await check.connect();
    try {
      const { rows } = await check.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND pid = ANY($1::int[])`,
        [[result.pidA, result.pidB]],
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await check.end();
    }
  });

  it('a plain Client gets the startup options and application_name', async () => {
    const client: Client = createPgClient(resolved(), { endpoint: 'lock', purpose: 'lock', statementTimeoutMs: 5_000 });
    await client.connect();
    try {
      const { rows } = await client.query<{ st: string; iit: string; app: string; ssl: boolean | null }>(
        `SELECT current_setting('statement_timeout') AS st,
                current_setting('idle_in_transaction_session_timeout') AS iit,
                current_setting('application_name') AS app,
                (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl`,
      );
      expect(rows[0]).toMatchObject({ st: '5s', iit: '1min', app: 'crewflow-worker-lock', ssl: false });
    } finally {
      await client.end();
    }
  });

  it('a TypeORM DataSource from the factory gets the runtime settings and its explicit max', async () => {
    const ds = createPgDataSource(resolved(), { endpoint: 'lock', purpose: 'lock', max: 6 }, { entities: [], synchronize: false });
    await ds.initialize();
    try {
      const [row] = (await ds.query(
        `SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS iit, current_setting('application_name') AS app`,
      )) as Array<{ st: string; iit: string; app: string }>;
      expect(row).toEqual({ st: '30s', iit: '1min', app: 'crewflow-worker-lock' });
      expect((ds.driver as unknown as { master: { options: { max: number } } }).master.options.max).toBe(6);
    } finally {
      await ds.destroy();
    }
  });

  const bouncerUrl = process.env.PGBOUNCER_TRANSACTION_URL;
  (bouncerUrl ? it : it.skip)('the session probe refuses a real PgBouncer in transaction mode', async () => {
    // PgBouncer rejects unknown startup parameters, so the probe connects with the bare target only.
    const target = new URL(bouncerUrl!);
    const config = {
      host: target.hostname,
      port: Number(target.port),
      user: decodeURIComponent(target.username),
      password: decodeURIComponent(target.password),
      database: target.pathname.slice(1),
      ssl: false as const,
    };
    const error = await probePgSessionAffinity(config, { label: 'the PgBouncer connection' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PgSessionProbeError);
    // Refused for the session reason, not because the pooler was unreachable.
    expect((error as Error).message).toMatch(/the PgBouncer connection is not session-stable/);
  }, 30_000);
});
