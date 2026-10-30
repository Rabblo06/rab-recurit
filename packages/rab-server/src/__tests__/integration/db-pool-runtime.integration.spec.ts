import { DataSource } from 'typeorm';

import { createPgClient, createPgDataSource, resolvePgEnvironment } from '../../database/postgres';
import { assertConnectionBudget, readServerCapacity } from '../../database/runtime/connection-budget';
import { DatabaseMetrics, registerDataSourcePoolMetrics } from '../../database/runtime/database-metrics';

/**
 * Phase B (B5), against the disposable test database as the runtime role:
 *   - the factory's per-session settings really reach the server (SHOW, per session; nothing global is changed);
 *   - idle_in_transaction_session_timeout really ends an idle transaction;
 *   - a full pool fails a waiting caller with a bounded acquisition timeout (never hangs), counted in the metrics;
 *   - the metrics snapshot carries no credential, host or tenant data;
 *   - the budget check reads the real server limits.
 */
const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('database pools and sessions (B5, live)', () => {
  const resolved = () => resolvePgEnvironment(process.env, { processRole: 'api' });
  const opened: DataSource[] = [];
  const open = async (request: Parameters<typeof createPgDataSource>[1]) => {
    const ds = createPgDataSource(resolved(), request, { entities: [] });
    await ds.initialize();
    opened.push(ds);
    return ds;
  };

  afterAll(async () => {
    for (const ds of opened) if (ds.isInitialized) await ds.destroy().catch(() => undefined);
  });

  it('a runtime session carries statement_timeout 30s, idle_in_transaction_session_timeout 1min and its application_name', async () => {
    const ds = await open({ endpoint: 'primary', purpose: 'runtime' });
    const [row] = await ds.query(
      `SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS iit,
              current_setting('application_name') AS app, current_setting('default_transaction_read_only') AS ro, current_user AS who`,
    );
    expect(row).toMatchObject({ st: '30s', iit: '1min', app: 'crewflow-api', ro: 'off', who: 'crewflow_app' });
    // The database-wide defaults are untouched: the values come from this session's startup options only.
    const [defaults] = await ds.query(`SELECT setting FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'`);
    const [source] = await ds.query(`SELECT source FROM pg_settings WHERE name = 'idle_in_transaction_session_timeout'`);
    expect(source.source).toBe('client');
    expect(defaults.setting).toBe('60000');
  });

  it("a replica-role session is read-only by default (the factory's role 'replica')", async () => {
    const ds = await open({ endpoint: 'primary', purpose: 'probe', role: 'replica', max: 1 });
    const [row] = await ds.query(`SELECT current_setting('default_transaction_read_only') AS ro, current_setting('application_name') AS app`);
    expect(row).toEqual({ ro: 'on', app: 'crewflow-api-probe-replica' });
    await expect(ds.query(`CREATE TEMP TABLE a3_should_fail (x int)`)).rejects.toMatchObject({ code: '25006' });
  });

  it('idle_in_transaction_session_timeout ends a transaction left idle (server FATAL 25P03)', async () => {
    const client = createPgClient(resolved(), { endpoint: 'primary', purpose: 'probe', idleInTransactionTimeoutMs: 1_000 });
    const events: Array<{ code?: string; message: string }> = [];
    client.on('error', (e: Error & { code?: string }) => events.push({ code: e.code, message: e.message }));
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT 1');
    await new Promise((r) => setTimeout(r, 2_500));
    const failed = await client.query('SELECT 1').then(
      () => null,
      (e: Error & { code?: string }) => ({ code: e.code, message: e.message }),
    );
    const seen = [...events, ...(failed ? [failed] : [])];
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((e) => e.code === '25P03' || /idle-in-transaction/i.test(e.message))).toBe(true);
    await client.end().catch(() => undefined);
  }, 20_000);

  it('pool exhaustion: the next caller fails with a bounded acquisition timeout (not a hang), counted in the metrics', async () => {
    const metrics = new DatabaseMetrics();
    const ds = await open({ endpoint: 'primary', purpose: 'probe', max: 1 });
    registerDataSourcePoolMetrics('primary', ds, metrics);
    const holder = ds.createQueryRunner();
    await holder.connect();
    await holder.startTransaction();
    const started = Date.now();
    const error = await ds.query('SELECT 1').catch((e: Error) => e);
    const waited = Date.now() - started;
    expect((error as Error).message).toMatch(/timeout exceeded when trying to connect/);
    expect(waited).toBeGreaterThanOrEqual(9_000);
    expect(waited).toBeLessThan(15_000);
    const pool = metrics.snapshot().pools.find((p) => p.name === 'primary')!;
    expect(pool).toMatchObject({ max: 1, acquisitionTimeouts: 1, acquisitionFailures: 1 });
    await holder.rollbackTransaction();
    await holder.release();
    await expect(ds.query('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }]);
    expect(metrics.snapshot().pools[0].acquisitions).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('the metrics snapshot names pools and counts only: no URL, host, user, password or database name', async () => {
    const metrics = new DatabaseMetrics();
    const ds = await open({ endpoint: 'primary', purpose: 'probe', max: 2 });
    registerDataSourcePoolMetrics('primary', ds, metrics);
    await ds.query('SELECT 1');
    const target = resolved().primary.target;
    const text = JSON.stringify(metrics.snapshot()) + metrics.summaryLines().join('\n');
    for (const secret of [target.password, target.user, target.host, target.database, 'postgres://', 'postgresql://']) {
      if (secret) expect(text).not.toContain(secret);
    }
    expect(metrics.snapshot().pools[0]).toMatchObject({ name: 'primary', max: 2, acquisitions: 1 });
  });

  it('the budget check reads the real server limits as the runtime role', async () => {
    const ds = await open({ endpoint: 'primary', purpose: 'probe', max: 1 });
    const capacity = await readServerCapacity((sql) => ds.query(sql));
    const [shown] = await ds.query('SHOW max_connections');
    expect(capacity.maxConnections).toBe(Number(shown.max_connections));
    expect(capacity.superuserReserved).toBeGreaterThanOrEqual(0);
    const huge = { PG_EXPECTED_API_INSTANCES: '50', PG_EXPECTED_WORKER_INSTANCES: '10' };
    await expect(assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: huge, query: (sql) => ds.query(sql), log: () => undefined })).rejects.toThrow(
      /connection budget exceeded/,
    );
    const small = { PG_EXPECTED_API_INSTANCES: '1', PG_EXPECTED_WORKER_INSTANCES: '0' };
    await expect(
      assertConnectionBudget({ processRole: 'api', ownPoolMax: 10, env: small, query: (sql) => ds.query(sql), log: () => undefined }),
    ).resolves.toMatchObject({ checked: true });
  });
});
