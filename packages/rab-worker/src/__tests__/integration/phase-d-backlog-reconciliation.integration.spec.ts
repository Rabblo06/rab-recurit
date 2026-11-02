import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { DispatchCoordinator, DispatchCoordinatorOptions } from '../../core/wake/dispatch-coordinator';
import { dispatchEmailScope, runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * #24 — bounded, fair follow-up reconciliation against the REAL per_scope email cycle (batch 50 per organisation) as the
 * restricted `crewflow_worker` login, on a disposable test database.
 *
 * Pointerless pending work (rows written before the pointer triggers existed, or whose pointer was lost) is found only by
 * the legacy sweep. Before #24 a global-mode Worker swept once per reconcile window, so a backlog above one batch per
 * organisation took one window (900 s) per 50 rows. Now a sweep that returns a FULL batch for any scope is followed by a
 * prompt follow-up sweep (bounded per window), so the backlog drains within the window.
 *
 * OPT-IN like the other Phase D suites: PHASE_D_SQL_APPROVED=true and TEST_DATABASE_WORKER_URL (the operator-created
 * `crewflow_worker` login). The admin connection must be the test cluster's SUPERUSER: only it can remove the fixtures'
 * pointers (rab_secure_owner table, FORCE RLS). It removes ONLY the pointers of this suite's own rows.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL && process.env.DATABASE_URL);
const describeIfApproved = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const BATCH = 50; // the per_scope email cycle's per-organisation batch
const DELAY_MS = 20; // follow-up spacing for the test (production default 5 s)

describeIfApproved('Phase D #24: pointerless email backlog drains through bounded follow-up sweeps (integration — opt-in)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  const workers: DataSource[] = [];
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  const coordinators: DispatchCoordinator[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    const [{ rolsuper }] = await admin.query<[{ rolsuper: boolean }]>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(rolsuper).toBe(true);
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  });

  afterEach(async () => {
    for (const c of coordinators.splice(0)) {
      c.stop();
      await c.idle();
    }
  });

  afterAll(async () => {
    for (const w of workers) await w.destroy();
    await app?.close();
    await admin?.destroy();
  });

  async function workerDataSource(name: string): Promise<DataSource> {
    const ds = new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 4, application_name: name } });
    await ds.initialize();
    const [{ current_user: who }] = await ds.query<[{ current_user: string }]>('SELECT current_user');
    expect(who).toBe('crewflow_worker');
    workers.push(ds);
    return ds;
  }

  async function organisation(label: string): Promise<string> {
    const seeded = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label });
    return seeded.managers[0]!.organisationId;
  }

  /** `n` PENDING email rows in `organisationId`, written as "before the triggers existed": their pointers removed. */
  async function seedPointerless(organisationId: string, n: number): Promise<string[]> {
    if (n === 0) return [];
    const rows = await admin.query<Array<{ id: string }>>(
      `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, rendered_text)
       SELECT gen_random_uuid(), $1, 'NOTIFICATION', 'PENDING', 'backlog@example.test', 'Subject', '<p>body</p>', 'body'
         FROM generate_series(1, $2)
       RETURNING id`,
      [organisationId, n],
    );
    const ids = rows.map((r) => r.id);
    await admin.query('DELETE FROM core.worker_dispatch_pointer WHERE subject_id = ANY($1::uuid[])', [ids]);
    const [{ left }] = await admin.query<[{ left: number }]>('SELECT count(*)::int AS left FROM core.worker_dispatch_pointer WHERE subject_id = ANY($1::uuid[])', [ids]);
    expect(left).toBe(0);
    return ids;
  }

  async function pendingCount(ids: string[]): Promise<number> {
    const [{ n }] = await admin.query<[{ n: number }]>(`SELECT count(*)::int AS n FROM core.email_outbox WHERE id = ANY($1::uuid[]) AND status = 'PENDING'`, [ids]);
    return n;
  }

  interface Published {
    id: string;
    organisationId: string;
    sweep: number;
    republish: boolean;
  }

  /** A global-mode email coordinator whose legacy sweep is the real per_scope cycle, recording every publish per sweep. */
  function emailCoordinator(worker: DataSource, published: Published[], opts: Partial<DispatchCoordinatorOptions> & { failPublish?: () => boolean } = {}) {
    let sweep = 0;
    const sweepsAt: number[] = [];
    const publish = async (id: string, organisationId: string) => {
      if (opts.failPublish?.()) throw new Error('Redis connection refused'); // queue outage: the claim stays committed (QUEUED)
      published.push({ id, organisationId, sweep, republish: false });
    };
    const republish = async (id: string, organisationId: string) => {
      if (opts.failPublish?.()) throw new Error('Redis connection refused');
      published.push({ id, organisationId, sweep, republish: true });
    };
    const coordinator = new DispatchCoordinator(
      [
        {
          queue: 'email',
          legacy: async () => {
            sweep += 1;
            sweepsAt.push(Date.now());
            return (await runEmailDispatchCycle(worker, tenantContext, publish, republish, true)).claimed > 0;
          },
          processScope: async (scope) => (await dispatchEmailScope(tenantContext, scope.organisationId, scope.subjectIds, publish, republish, true)).claimed,
        },
      ],
      { claimer: worker, batch: 200, reconcileMs: 900_000, followUpDelayMs: DELAY_MS, logger: { log: () => undefined, warn: () => undefined }, ...opts },
    );
    coordinators.push(coordinator);
    return { coordinator, sweeps: () => sweep, sweepsAt };
  }

  async function waitFor(done: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await done())) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the backlog to drain');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const perSweep = (published: Published[], organisationId: string) => {
    const counts = new Map<number, number>();
    for (const p of published) if (p.organisationId === organisationId) counts.set(p.sweep, (counts.get(p.sweep) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a - b).map(([, n]) => n);
  };

  it('0 / 49 / 50 / 51 / 500 pointerless rows in five organisations: one tick drains all of it, one batch per organisation per sweep, each row exactly once under its own organisation', async () => {
    const sizes = [0, 49, 50, 51, 500];
    const orgs: string[] = [];
    const ids = new Map<string, string[]>();
    for (const n of sizes) {
      const org = await organisation(`bl-${n}`);
      orgs.push(org);
      ids.set(org, await seedPointerless(org, n));
    }
    const all = [...ids.values()].flat();
    const worker = await workerDataSource('crewflow-worker-it-24a');
    const published: Published[] = [];
    const { coordinator, sweeps, sweepsAt } = emailCoordinator(worker, published);
    const started = Date.now();
    await coordinator.tick('email'); // the only tick: everything after it is follow-ups
    await waitFor(async () => (await pendingCount(all)) === 0);
    const drainedMs = Date.now() - started;
    // The last full sweep schedules one confirming follow-up (it finds the rest empty, then the chain ends): let it run.
    let settled = -1;
    while (settled !== sweeps()) {
      settled = sweeps();
      await new Promise((r) => setTimeout(r, DELAY_MS * 10));
      await coordinator.idle();
    }

    const ours = published.filter((p) => all.includes(p.id));
    expect(ours).toHaveLength(all.length); // every row published …
    expect(new Set(ours.map((p) => p.id)).size).toBe(all.length); // … exactly once
    for (const [org, orgIds] of ids) {
      for (const p of ours.filter((x) => orgIds.includes(x.id))) expect(p.organisationId).toBe(org); // under its own organisation
    }
    // Fairness and the bound: every sweep takes at most one batch per organisation; the small organisations finish in the
    // first sweep(s) while the 500-row one is still draining.
    expect(perSweep(ours, orgs[1]!)).toEqual([49]);
    expect(perSweep(ours, orgs[2]!)).toEqual([50]);
    expect(perSweep(ours, orgs[3]!)).toEqual([50, 1]);
    expect(perSweep(ours, orgs[4]!)).toEqual(Array.from({ length: 10 }, () => BATCH));
    expect(sweeps()).toBeGreaterThanOrEqual(11); // 10 full sweeps for the 500 + the confirming one
    expect(sweeps()).toBeLessThanOrEqual(31); // 1 + the default follow-up budget per window
    // Recovery time: within ONE reconcile window (900 s) — here seconds; before #24 the 500-row backlog took 10 windows.
    expect(drainedMs).toBeLessThan(900_000);
    process.stdout.write(`[24-measure] backlog=650 sweeps=${sweeps()} drainMs=${drainedMs} sweepGapsMs=${sweepsAt.slice(1).map((t, i) => t - sweepsAt[i]!).join(',')}\n`);
  });

  it('two Worker replicas drain one 300-row backlog together: every row exactly once (SKIP LOCKED + the QUEUED transition)', async () => {
    const org = await organisation('bl-2r');
    const ids = await seedPointerless(org, 300);
    const published: Published[] = [];
    const a = emailCoordinator(await workerDataSource('crewflow-worker-it-24b1'), published);
    const b = emailCoordinator(await workerDataSource('crewflow-worker-it-24b2'), published);
    await Promise.all([a.coordinator.tick('email'), b.coordinator.tick('email')]);
    await waitFor(async () => (await pendingCount(ids)) === 0);
    await Promise.all([a.coordinator.idle(), b.coordinator.idle()]);
    const ours = published.filter((p) => ids.includes(p.id));
    expect(ours).toHaveLength(300);
    expect(new Set(ours.map((p) => p.id)).size).toBe(300);
  });

  it('Redis outage mid-drain: publishes fail but the claims stay committed (QUEUED); after recovery the stale-QUEUED rule re-publishes them — nothing lost', async () => {
    const org = await organisation('bl-redis');
    const ids = await seedPointerless(org, 120);
    const published: Published[] = [];
    let outage = true;
    const worker = await workerDataSource('crewflow-worker-it-24c');
    const { coordinator } = emailCoordinator(worker, published, { failPublish: () => outage });
    await coordinator.tick('email');
    await waitFor(async () => (await pendingCount(ids)) === 0); // the follow-ups keep claiming during the outage
    await coordinator.idle();
    expect(published.filter((p) => ids.includes(p.id))).toHaveLength(0);
    const [{ queued }] = await admin.query<[{ queued: number }]>(`SELECT count(*)::int AS queued FROM core.email_outbox WHERE id = ANY($1::uuid[]) AND status = 'QUEUED'`, [ids]);
    expect(queued).toBe(120); // durable in PostgreSQL, not in Redis
    // Redis is back; simulate the 2-minute QUEUED staleness passing (the existing recovery rule), then the next window's sweep.
    outage = false;
    await admin.query(`UPDATE core.email_outbox SET queued_at = now() - interval '3 minutes' WHERE id = ANY($1::uuid[])`, [ids]);
    const recovery = emailCoordinator(worker, published);
    await recovery.coordinator.tick('email');
    await waitFor(async () => new Set(published.filter((p) => ids.includes(p.id)).map((p) => p.id)).size === 120);
    await recovery.coordinator.idle();
    expect(new Set(published.filter((p) => ids.includes(p.id)).map((p) => p.id)).size).toBe(120);
    expect(published.filter((p) => ids.includes(p.id)).every((p) => p.republish)).toBe(true); // a new generation, never the old job
  });

  it('Worker interruption mid-drain: stop() halts it; a restarted coordinator sweeps on its first tick and finishes — every row exactly once', async () => {
    const org = await organisation('bl-stop');
    const ids = await seedPointerless(org, 300);
    const published: Published[] = [];
    const worker = await workerDataSource('crewflow-worker-it-24d');
    const first = emailCoordinator(worker, published, { followUpDelayMs: 200 });
    await first.coordinator.tick('email'); // sweep 1 (50 rows), follow-up pending
    first.coordinator.stop();
    await first.coordinator.idle();
    await new Promise((r) => setTimeout(r, 400));
    expect(first.sweeps()).toBe(1);
    expect(await pendingCount(ids)).toBe(250);
    const second = emailCoordinator(worker, published);
    await second.coordinator.tick('email');
    await waitFor(async () => (await pendingCount(ids)) === 0);
    await second.coordinator.idle();
    const ours = published.filter((p) => ids.includes(p.id));
    expect(ours).toHaveLength(300);
    expect(new Set(ours.map((p) => p.id)).size).toBe(300);
  });

  it('every runtime PostgreSQL session terminated mid-drain (as a server restart does): the drain recovers and still publishes every row exactly once', async () => {
    const org = await organisation('bl-pgkill');
    const ids = await seedPointerless(org, 300);
    const published: Published[] = [];
    const worker = await workerDataSource('crewflow-worker-it-24e');
    // reconcileMs 2 s → the failed-sweep retry is min(60 s, 2 s): the test does not wait a minute.
    const { coordinator } = emailCoordinator(worker, published, { reconcileMs: 2_000, followUpDelayMs: 100 });
    await coordinator.tick('email');
    // Every runtime session of this database dies (the Worker's crewflow_worker pool and the tenant-context crewflow_app pool).
    const [{ killed }] = await admin.query<[{ killed: number }]>(
      `SELECT count(pg_terminate_backend(pid))::int AS killed FROM pg_stat_activity
        WHERE datname = current_database() AND usename IN ('crewflow_worker', 'crewflow_app') AND pid <> pg_backend_pid()`,
    );
    expect(killed).toBeGreaterThan(0);
    const poll = setInterval(() => void coordinator.tick('email').catch(() => undefined), 250); // the scan's own poll ticks
    try {
      await waitFor(async () => (await pendingCount(ids)) === 0, 120_000);
    } finally {
      clearInterval(poll);
    }
    await coordinator.idle();
    const ours = published.filter((p) => ids.includes(p.id));
    expect(new Set(ours.map((p) => p.id)).size).toBe(300);
    expect(ours).toHaveLength(300);
  });
});
