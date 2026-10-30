import { execFileSync } from 'child_process';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { createPgDataSource, resolvePgEnvironment } from '../../database/postgres';
import { DatabaseMetrics, databaseMetrics } from '../../database/runtime/database-metrics';
import { PgReplicaService } from '../../database/runtime/replica/pg-replica.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { SchemaResolverService } from '../../engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * Phase B (B4) replica LAB: a real PostgreSQL 16 primary + physical streaming standby (Docker, see the A3 lab script).
 * Opt-in: runs only when REPLICA_LAB_* are set; never against a shared database.
 *
 *   REPLICA_LAB_PRIMARY_APP_URL / REPLICA_LAB_STANDBY_APP_URL   crewflow_app on the primary / the standby
 *   REPLICA_LAB_PRIMARY_SU_URL  / REPLICA_LAB_STANDBY_SU_URL    the lab superuser (seeding, replay pause/resume)
 *   REPLICA_LAB_STANDBY_CONTAINER                               docker name of the standby (stop/start)
 */
const LAB = {
  primaryApp: process.env.REPLICA_LAB_PRIMARY_APP_URL ?? '',
  standbyApp: process.env.REPLICA_LAB_STANDBY_APP_URL ?? '',
  primarySu: process.env.REPLICA_LAB_PRIMARY_SU_URL ?? '',
  standbySu: process.env.REPLICA_LAB_STANDBY_SU_URL ?? '',
  container: process.env.REPLICA_LAB_STANDBY_CONTAINER ?? '',
};
const describeLab = LAB.primaryApp && LAB.standbyApp && LAB.primarySu && LAB.standbySu && LAB.container ? describe : describe.skip;

const MAX_LAG_MS = 1_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function su(url: string, sql: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(200);
  }
}

describeLab('read replica lab (B4: primary + physical standby)', () => {
  const labEnv = { PG_DATABASE_URL: LAB.primaryApp, NODE_ENV: 'test' };
  // The process-wide registry: TenantContextService records reads/fallbacks there, PgReplicaService its state.
  const metrics = databaseMetrics;
  let primary: DataSource;
  let replica: PgReplicaService;
  let tenant: TenantContextService;
  let orgA: { org: string; ws: string };
  let orgB: { org: string; ws: string };
  const counts: Record<string, number> = {};

  const ctxOf = (o: { org: string; ws: string }): AuthContext => ({ organisationId: o.org, workspaceId: o.ws, userId: '', role: '', actorType: 'worker' });
  const VISIBLE = `SELECT pg_catalog.pg_is_in_recovery() AS standby, current_setting('rab.organisation_id') AS org,
                          (SELECT count(*)::int FROM core.venue WHERE name LIKE 'a3-lab-%') AS venues`;

  beforeAll(async () => {
    metrics.reset();
    // Seed: venues for two organisations, as the lab superuser, on the primary only.
    const ws = await su(
      LAB.primarySu,
      `SELECT DISTINCT ON (organisation_id) id::text AS ws, organisation_id::text AS org FROM core.manager_workspace WHERE organisation_id IS NOT NULL ORDER BY organisation_id, id LIMIT 2`,
    );
    if (ws.length < 2) throw new Error('lab database needs two organisations with a workspace');
    [orgA, orgB] = ws.map((r) => ({ org: String(r.org), ws: String(r.ws) }));
    await su(LAB.primarySu, `DELETE FROM core.venue WHERE name LIKE 'a3-lab-%'`);
    for (const [o, n] of [[orgA, 3], [orgB, 2]] as const) {
      for (let i = 0; i < n; i += 1) {
        await su(LAB.primarySu, `INSERT INTO core.venue (organisation_id, workspace_id, name) VALUES ($1, $2, $3)`, [o.org, o.ws, `a3-lab-${i}`]);
      }
    }
    await waitFor('seed replicated to the standby', async () => {
      const [r] = await su(LAB.standbySu, `SELECT count(*)::int AS n FROM core.venue WHERE name LIKE 'a3-lab-%'`);
      return r.n === 5;
    });

    primary = createPgDataSource(resolvePgEnvironment(labEnv, { processRole: 'api' }), { endpoint: 'primary', purpose: 'runtime', max: 4 }, { entities: [] });
    await primary.initialize();
    replica = new PgReplicaService(primary, {
      url: LAB.standbyApp,
      enabled: true,
      production: false,
      maxLagMs: MAX_LAG_MS,
      probeIntervalMs: 200,
      poolMax: 3,
      env: labEnv,
      metrics,
    });
    const env = { get: () => false } as unknown as EnvironmentService;
    tenant = new TenantContextService(primary, { resolve: async () => 'core' } as unknown as SchemaResolverService, env, replica);
  }, 120_000);

  afterAll(async () => {
    try {
      execFileSync('docker', ['start', LAB.container], { stdio: 'ignore' });
      await su(LAB.standbySu, 'SELECT pg_catalog.pg_wal_replay_resume()').catch(() => undefined);
    } catch {
      // best effort
    }
    await replica?.onApplicationShutdown();
    await su(LAB.primarySu, `DELETE FROM core.venue WHERE name LIKE 'a3-lab-%'`).catch(() => undefined);
    if (primary?.isInitialized) await primary.destroy();
    // eslint-disable-next-line no-console
    console.log(`[replica-lab] counts ${JSON.stringify(counts)} metrics ${JSON.stringify(metrics.snapshot().replica)}`);
  });

  it('a replica URL that is really the primary is refused at startup (writable primary)', async () => {
    const wrong = new PgReplicaService(primary, { url: LAB.primaryApp, enabled: true, production: false, maxLagMs: MAX_LAG_MS, startProbe: false, poolMax: 1, env: labEnv, metrics: new DatabaseMetrics() });
    await expect(wrong.onModuleInit()).rejects.toThrow(/writable primary/);
    expect(wrong.currentState).toBe('refused');
    await wrong.onApplicationShutdown();
  });

  it('the standby is recognised and validated (in recovery, crewflow_app, same cluster, FORCE RLS, identity, ledger head) and fresh', async () => {
    await replica.onModuleInit();
    expect(replica.currentState).toBe('validated');
    await waitFor('fresh', () => replica.routeRead().dataSource !== null, 10_000);
    expect(metrics.snapshot().replica).toMatchObject({ configured: true, state: 'validated', available: 1 });
    const pool = metrics.snapshot().pools.find((p) => p.name === 'replica');
    expect(pool).toMatchObject({ registered: true, max: 3 });
  });

  it('tenant binding on the standby: own organisation only, cross-organisation isolation, no context = 0 rows', async () => {
    const a = await tenant.runInWorkspaceContext(ctxOf(orgA), (m) => m.query(VISIBLE), { useReplica: true });
    const b = await tenant.runInWorkspaceContext(ctxOf(orgB), (m) => m.query(VISIBLE), { useReplica: true });
    const none = await tenant.runInTenantContext({ organisationId: null, workspaceId: null, userId: '', role: '' }, (m) => m.query(VISIBLE), { useReplica: true });
    expect(a[0]).toEqual({ standby: true, org: orgA.org, venues: 3 });
    expect(b[0]).toEqual({ standby: true, org: orgB.org, venues: 2 });
    expect(none[0]).toMatchObject({ standby: true, venues: 0 });
    const crossOrg = await tenant.runInWorkspaceContext(ctxOf(orgB), (m) => m.query(`SELECT id FROM core.venue WHERE organisation_id = $1`, [orgA.org]), { useReplica: true });
    expect(crossOrg).toEqual([]);
    // Outside any tenant transaction (no GUC bound at all) the runtime role sees nothing on the standby either.
    const replicaDs = replica.routeRead().dataSource!;
    expect(await replicaDs.query(`SELECT count(*)::int AS n FROM core.venue`)).toEqual([{ n: 0 }]);
    const [force] = await replicaDs.query(`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'core.venue'::regclass`);
    expect(force).toEqual({ enabled: true, forced: true });
    counts.isolationChecks = 6;
  });

  it('set_config is transaction-local on the standby: nothing leaks to the next transaction on the same pool', async () => {
    const replicaDs = replica.routeRead().dataSource!;
    await tenant.runInWorkspaceContext(ctxOf(orgA), async () => undefined, { useReplica: true });
    const after = await replicaDs.query(`SELECT current_setting('rab.organisation_id', true) AS org`);
    expect(['', null]).toContain(after[0].org);
  });

  it('writes are refused on the replica (25006) — inside a routed read, and directly — and never retried on the primary', async () => {
    const before = await su(LAB.primarySu, `SELECT count(*)::int AS n FROM core.venue WHERE name = 'a3-lab-write'`);
    const write = tenant.runInWorkspaceContext(
      ctxOf(orgA),
      (m) => m.query(`INSERT INTO core.venue (organisation_id, workspace_id, name) VALUES ($1, $2, 'a3-lab-write')`, [orgA.org, orgA.ws]),
      { useReplica: true },
    );
    await expect(write).rejects.toMatchObject({ code: '25006' });
    await expect(replica.routeRead().dataSource!.query(`DELETE FROM core.venue WHERE false`)).rejects.toMatchObject({ code: '25006' });
    const after = await su(LAB.primarySu, `SELECT count(*)::int AS n FROM core.venue WHERE name = 'a3-lab-write'`);
    expect(after).toEqual(before);
  });

  it('spy: writes and un-flagged reads (auth, security, read-your-writes) never touch the replica', async () => {
    const replicaDs = replica.routeRead().dataSource!;
    const spy = jest.spyOn(replicaDs, 'transaction');
    await tenant.runInWorkspaceContext(ctxOf(orgA), (m) =>
      m.query(`INSERT INTO core.venue (organisation_id, workspace_id, name) VALUES ($1, $2, 'a3-lab-spy')`, [orgA.org, orgA.ws]),
    );
    const readBack = await tenant.runInWorkspaceContext(ctxOf(orgA), (m) => m.query(`SELECT pg_is_in_recovery() AS standby, count(*)::int AS n FROM core.venue WHERE name = 'a3-lab-spy'`));
    expect(readBack).toEqual([{ standby: false, n: 1 }]); // read-your-writes: the un-flagged read is on the primary
    await primary.query(`SELECT 1`); // the auth-path style direct query
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await su(LAB.primarySu, `DELETE FROM core.venue WHERE name = 'a3-lab-spy'`);
  });

  it('artificial lag (replay paused): stale → reads go to the primary and see the newest write; resumed → replica again', async () => {
    await su(LAB.standbySu, 'SELECT pg_catalog.pg_wal_replay_pause()');
    try {
    await su(LAB.primarySu, `INSERT INTO core.venue (organisation_id, workspace_id, name) VALUES ($1, $2, 'a3-lab-lag')`, [orgA.org, orgA.ws]);
    await waitFor('stale', () => (replica.routeRead() as { reason?: string }).reason === 'stale', 10_000);
    const stale = await tenant.runInWorkspaceContext(ctxOf(orgA), (m) => m.query(VISIBLE), { useReplica: true });
    expect(stale[0]).toMatchObject({ standby: false, venues: 4 }); // primary: sees the write the paused standby has not replayed
    const [standbyView] = await su(LAB.standbySu, `SELECT count(*)::int AS n FROM core.venue WHERE name = 'a3-lab-lag'`);
    expect(standbyView.n).toBe(0); // proves the standby really is behind
    expect(metrics.snapshot().replica.fallbacks.stale).toBeGreaterThanOrEqual(1);
    expect(metrics.snapshot().replica.lagMs).toBeGreaterThan(0);
    } finally {
      await su(LAB.standbySu, 'SELECT pg_catalog.pg_wal_replay_resume()');
    }
    await waitFor('fresh again', () => replica.routeRead().dataSource !== null, 10_000);
    const fresh = await tenant.runInWorkspaceContext(ctxOf(orgA), (m) => m.query(VISIBLE), { useReplica: true });
    expect(fresh[0]).toMatchObject({ standby: true, venues: 4 });
    counts.lagFallbacks = metrics.snapshot().replica.fallbacks.stale;
  }, 60_000);

  it('an idle, caught-up replica stays fresh even when its last replayed transaction is older than the max lag', async () => {
    await sleep(4 * MAX_LAG_MS);
    let freshChecks = 0;
    for (let i = 0; i < 10; i += 1) {
      if (replica.routeRead().dataSource) freshChecks += 1;
      await sleep(200);
    }
    const [age] = await su(LAB.standbySu, `SELECT (extract(epoch FROM now() - pg_last_xact_replay_timestamp()) * 1000)::int AS ms`);
    counts.idleReplayAgeMs = Number(age.ms);
    expect(Number(age.ms)).toBeGreaterThan(MAX_LAG_MS);
    expect(freshChecks).toBe(10);
  }, 30_000);

  it('replica stopped → reads fall back to the primary (retry, then unavailable); restarted → validated again', async () => {
    execFileSync('docker', ['stop', '-t', '2', LAB.container], { stdio: 'ignore' });
    try {
    const during = await tenant.runInWorkspaceContext(ctxOf(orgA), (m) => m.query(VISIBLE), { useReplica: true });
    expect(during[0]).toMatchObject({ standby: false, venues: 4 });
    await waitFor('unavailable', () => replica.currentState === 'unavailable', 15_000);
    const fallback = await tenant.runInWorkspaceContext(ctxOf(orgB), (m) => m.query(VISIBLE), { useReplica: true });
    expect(fallback[0]).toMatchObject({ standby: false, org: orgB.org, venues: 2 });
    const snap = metrics.snapshot().replica;
    expect(snap.fallbacks.unavailable + snap.fallbacks['replica-error']).toBeGreaterThanOrEqual(2);
    expect(snap.connectionFailures).toBeGreaterThanOrEqual(1);
    counts.stoppedFallbacks = snap.fallbacks.unavailable + snap.fallbacks['replica-error'];
    } finally {
      execFileSync('docker', ['start', LAB.container], { stdio: 'ignore' });
    }
    await waitFor('validated and fresh after restart', () => replica.currentState === 'validated' && replica.routeRead().dataSource !== null, 90_000);
    const back = await tenant.runInWorkspaceContext(ctxOf(orgA), (m) => m.query(VISIBLE), { useReplica: true });
    expect(back[0]).toMatchObject({ standby: true, venues: 4 });
    counts.replicaReads = metrics.snapshot().replica.reads;
  }, 150_000);
});
