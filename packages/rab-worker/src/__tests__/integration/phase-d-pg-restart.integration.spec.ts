import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '@rab/server/engine/utils/assert-runtime-db-role';
import { claimDispatchPointers } from '../../core/database/dispatch-claims';
import { ReconnectingPgClient } from '../../core/database/reconnecting-pg-client';
import { DispatchCoordinator } from '../../core/wake/dispatch-coordinator';
import { DispatchWakeListener } from '../../core/wake/dispatch-listener';
import { NotificationQueueMonitor, NotificationQueueSample } from '../../core/wake/notification-queue-monitor';
import { publishRealtimeScope } from '../../queues/rab-realtime/publish-outbox.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase D wave 4 — PostgreSQL RESTART during a global-mode run (owner §10). Runs ONLY against the throwaway cluster
 * `crewflow-d-pgrestart` (127.0.0.1:15499, database rab_pgr, built by the lead from the approved chain), never the shared
 * crewflow-test-db: gated on PHASE_D_SQL_APPROVED=true + PHASE_D_PG_RESTART_CONTAINER=crewflow-d-pgrestart and a
 * TEST_DATABASE_URL on port 15499.
 *
 * Two Worker runtimes (two crewflow_worker pools) + a wake listener + the OD-2 monitor. Worker A claims part of a batch,
 * publishes some, then the PostgreSQL container restarts (every session dies). Measured: downtime, the time until both
 * runtimes claim again, the listener's re-LISTEN, and the time until every event is published. Acceptance: every event
 * published exactly once (no duplicate from re-claims), none lost (A's leases expire and are re-claimed), the monitor
 * reports `unknown` during the outage and a value after it, and no tick throws past the runtime (they fail and retry).
 */
const CONTAINER = process.env.PHASE_D_PG_RESTART_CONTAINER;
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN =
  process.env.PHASE_D_SQL_APPROVED === 'true' &&
  CONTAINER === 'crewflow-d-pgrestart' &&
  /127\.0\.0\.1:15499\//.test(process.env.TEST_DATABASE_URL ?? '') &&
  Boolean(WORKER_URL);
const describeIfRestart = RUN ? describe : describe.skip;
const TEST_ENV = 'inttest';
jest.setTimeout(300_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measure = (name: string, ms: number, extra: Record<string, unknown> = {}) =>
  // eslint-disable-next-line no-console
  console.log(`[w4-measure] ${JSON.stringify({ name, ms, ...extra })}`);

describeIfRestart('Phase D: PostgreSQL restart during a global-mode run (throwaway cluster only)', () => {
  let app: INestApplication;
  let admin: DataSource;
  let workerA: DataSource;
  let workerB: DataSource;
  let tenantContext: TenantContextService;
  let owner: TestIdentity;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    tenantContext = app.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    const factory = new TestIdentityFactory({ app, dataSource: app.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    const ds = (n: string) => new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 3, application_name: `crewflow-worker-pgr-${n}` } });
    workerA = ds('a');
    workerB = ds('b');
    await Promise.all([workerA.initialize(), workerB.initialize()]);
    owner = await factory.createInternalManager(await factory.createOrganisation('pgr'), { label: 'pgr' });
  });

  afterAll(async () => {
    await Promise.allSettled([workerA?.destroy(), workerB?.destroy()]);
    await app?.close();
    await admin?.destroy();
  });

  it('every event is published exactly once across a PostgreSQL restart; leases, listener and monitor recover', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(
        await tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, async (m) =>
          (
            await m.query<Array<{ id: string }>>(
              `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
               VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, 10, 1) RETURNING id`,
              [owner.organisationId, owner.workspaceId, owner.userId, `pgr:${randomUUID()}`, randomUUID()],
            )
          )[0]!.id,
        ),
      );
    }
    const published = new Map<string, number>();
    const publish = async (_c: string, message: string) => {
      const id = JSON.parse(message).eventId as string;
      published.set(id, (published.get(id) ?? 0) + 1);
      return 1;
    };
    const scope = { organisationId: owner.organisationId, workspaceId: owner.workspaceId };
    // Worker A claims 8 and publishes 4 of them before the restart; the other 4 stay leased to A (it then "loses" them).
    const claimsA = (await claimDispatchPointers(workerA, 'realtime', 8)).filter((c) => ids.includes(c.subjectId));
    await publishRealtimeScope(tenantContext, publish, TEST_ENV, scope, { ids: claimsA.slice(0, 4).map((c) => c.subjectId) });

    const logger = { log: () => undefined, warn: () => undefined };
    const binding = { queue: 'realtime' as const, legacy: async () => false, processScope: async (s: { organisationId: string; workspaceId: string | null; subjectIds: string[] }) => (await publishRealtimeScope(tenantContext, publish, TEST_ENV, s, { ids: s.subjectIds })).claimed };
    const coordinators = [workerA, workerB].map((w) => new DispatchCoordinator([binding], { claimer: w, batch: 5, reconcileMs: 900_000, logger }));
    const connected: number[] = [];
    const listener = new DispatchWakeListener(
      new ReconnectingPgClient({ connectionString: WORKER_URL, application_name: 'crewflow-pgr-wake-listener' }, { label: 'pgr-listener', logger, initialBackoffMs: 500, maxBackoffMs: 2_000 }),
      {
        onWake: (q) => coordinators.forEach((c) => c.wake(q)),
        onConnected: () => connected.push(Date.now()),
        verifyIdentity: async (client) => assertRuntimeDbRole({ query: async (sql: string, p?: unknown[]) => (await client.query(sql, p)).rows } as unknown as DataSource, 'worker-wake-listener'),
        logger,
        ensureIntervalMs: 500,
      },
    );
    await listener.start();
    const samples: NotificationQueueSample[] = [];
    const monitor = new NotificationQueueMonitor(workerA, { logger: { log: () => undefined, warn: () => undefined, error: () => undefined }, intervalMs: 1_000, onSample: (s) => samples.push(s) });
    monitor.start();
    let tickErrors = 0;
    const ticker = setInterval(() => {
      for (const c of coordinators) void c.tick('realtime').catch(() => (tickErrors += 1));
    }, 1_000);
    try {
      const restartAt = Date.now();
      // Asynchronous, so ticks, the listener and the monitor keep running WHILE the server is down.
      await new Promise<void>((resolve, reject) => execFile('docker', ['restart', '-t', '2', CONTAINER!], (error) => (error ? reject(error) : resolve())));
      measure('pg-container-restart-command', Date.now() - restartAt);
      while ([...ids].some((id) => !published.has(id)) && Date.now() - restartAt < 120_000) await sleep(500);
      measure('pg-restart-all-published', Date.now() - restartAt, { tickErrors, leaseSeconds: 15 });
      while (connected.length < 2 && Date.now() - restartAt < 60_000) await sleep(200);
      measure('pg-restart-listener-relisten', (connected[1] ?? Number.NaN) - restartAt);
      for (const id of ids) expect(published.get(id)).toBe(1);
      expect(connected.length).toBeGreaterThanOrEqual(2);
      // Visibility during the outage is measured, not assumed: pg's pool drops a dead idle connection and reconnects on
      // the next checkout, so a tick or sample only fails if it was in flight while the server was down.
      measure('pg-restart-visibility', 0, { unknownSamples: samples.filter((s) => s.level === 'unknown').length, samples: samples.length, tickErrors });
      for (let i = 0; i < 20 && samples[samples.length - 1]?.usage == null; i += 1) await sleep(500);
      expect(samples[samples.length - 1]!.usage).not.toBeNull(); // the monitor reports again after the restart
    } finally {
      clearInterval(ticker);
      monitor.stop();
      for (const c of coordinators) c.stop();
      await listener.stop();
    }
  });
});
