import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Client, Notification } from 'pg';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { createPgDataSource, resolvePgEnvironment } from '@rab/server/database/postgres/index';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { SchemaResolverService } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { DispatchCoordinator } from '../../core/wake/dispatch-coordinator';
import { WORKER_WAKE_CHANNEL } from '../../core/wake/dispatch-listener';
import { resolveDispatchConfig } from '../../core/wake/dispatch-wiring';
import { dispatchEmailScope, runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { runRealtimeOutboxPublishCycle } from '../../queues/rab-realtime/publish-outbox.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase D wave 3 — recovery tests the owner asked for.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GATED. Needs migrations 1786721300000–1786721320000 applied and the `crewflow_worker` login. Skipped unless     │
 * │ PHASE_D_SQL_APPROVED=true and TEST_DATABASE_WORKER_URL are set. The admin connection (TEST_DATABASE_URL_UNPOOLED)  │
 * │ must be the test cluster's SUPERUSER (asserted): only it can delete a pointer (rab_secure_owner, FORCE RLS).    │
 * └──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * (a) MISSING POINTER: a pending email_outbox row whose pointer the superuser deleted is recovered by the legacy per-scope
 *     reconciliation sweep within ONE WORKER_DISPATCH_RECONCILE_SECONDS interval. The interval is the shortest the Worker
 *     accepts (60 s, resolved through resolveDispatchConfig exactly as main.ts does) and the coordinator runs on the REAL
 *     clock: ticks every 2 s (the email-dispatch default) do the global claim only until the interval has elapsed.
 * (b) pre-trigger rows, workspace-schema statements included → phase-d-first-cutover-reconciliation.integration.spec.ts.
 * (c) POLL MODE EMITS ZERO NOTIFY, end to end: API-role and Worker-role sessions built by the real connection factory with
 *     WORKER_DISPATCH_MODE=poll write and process outbox rows (the pointer triggers DO fire — pointers are asserted), while
 *     a separate LISTEN session on `crewflow_worker_wake` receives nothing. Positive control: one event-mode session's
 *     write IS received, so the silence is not a deaf listener.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL && APP_URL && process.env.DATABASE_URL);
const describeIfApproved = RUN ? describe : describe.skip;
const TEST_ENV = 'inttest';
jest.setTimeout(240_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeIfApproved('Phase D dispatch recovery (integration — gated)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  let worker: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let owner: TestIdentity;

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
    worker = new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 4, application_name: 'crewflow-worker-it' } });
    await worker.initialize();
    const [{ current_user: who }] = await worker.query<[{ current_user: string }]>('SELECT current_user');
    // BC-08 (Phase D under one login): the Worker runs on crewflow_owner; crewflow_worker is a schema role.
    expect(who).toBe('crewflow_owner');
    owner = await factory.createInternalManager(await factory.createOrganisation('recovery'), { label: 'recovery' });
  });

  afterAll(async () => {
    await worker?.destroy();
    await app?.close();
    await admin?.destroy();
  });

  const pointerCount = async (id: string) =>
    (await admin.query<[{ n: number }]>('SELECT count(*)::int AS n FROM core.worker_dispatch_pointer WHERE subject_id = $1', [id]))[0].n;

  async function seedEmail(): Promise<string> {
    const id = randomUUID();
    await tenantContext.runInTenantContext({ organisationId: owner.organisationId, workspaceId: null, userId: owner.userId, role: '' }, (m) =>
      m.query(
        `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, rendered_text)
         VALUES ($1, $2, 'NOTIFICATION', 'PENDING', 'recovery@example.test', 'Subject', '<p>body</p>', 'body')`,
        [id, owner.organisationId],
      ),
    );
    return id;
  }

  it('(a) a missing pointer is recovered by the reconciliation sweep within one WORKER_DISPATCH_RECONCILE_SECONDS interval', async () => {
    const config = resolveDispatchConfig({ get: (k: string) => ({ WORKER_CLAIM_MODE: 'global', WORKER_DISPATCH_RECONCILE_SECONDS: 60 } as Record<string, unknown>)[k] });
    expect(config.reconcileSeconds).toBe(60);
    const published: Array<{ id: string; at: number }> = [];
    const publish = async (id: string) => {
      published.push({ id, at: Date.now() });
    };
    const noRepublish = async () => undefined;
    const sweeps: number[] = [];
    const coordinator = new DispatchCoordinator(
      [
        {
          queue: 'email',
          legacy: async () => {
            sweeps.push(Date.now());
            return (await runEmailDispatchCycle(worker, tenantContext, publish, noRepublish, true)).claimed > 0;
          },
          processScope: async (scope) => (await dispatchEmailScope(tenantContext, scope.organisationId, scope.subjectIds, publish, noRepublish, true)).claimed,
        },
      ],
      { claimer: worker, batch: 100, reconcileMs: config.reconcileSeconds * 1000, logger: { log: () => undefined, warn: () => undefined } },
    );

    await coordinator.tick('email'); // Worker start: the first tick sweeps (and stamps the next sweep one interval later)
    const intervalStartedAt = sweeps[0]!;

    const id = await seedEmail();
    expect(await pointerCount(id)).toBe(1); // the trigger wrote it...
    await admin.query('DELETE FROM core.worker_dispatch_pointer WHERE subject_id = $1', [id]); // ...and it went missing
    expect(await pointerCount(id)).toBe(0);

    const deadline = intervalStartedAt + config.reconcileSeconds * 1000 + 10_000;
    while (Date.now() < deadline && !published.some((p) => p.id === id)) {
      await coordinator.tick('email');
      await sleep(2_000);
    }
    const hit = published.find((p) => p.id === id);
    expect(hit).toBeDefined();
    // Recovered by the SECOND sweep (the global claim could not see it: no pointer), at most one interval after the first
    // sweep plus one 2 s tick of slack.
    expect(sweeps.length).toBeGreaterThanOrEqual(2);
    expect(hit!.at).toBeGreaterThanOrEqual(sweeps[1]!);
    expect(hit!.at - intervalStartedAt).toBeLessThanOrEqual(config.reconcileSeconds * 1000 + 2_000 + 5_000);
    expect(published.filter((p) => p.id === id)).toHaveLength(1);
    const [{ status }] = await admin.query<[{ status: string }]>('SELECT status FROM core.email_outbox WHERE id = $1', [id]);
    expect(status).toBe('QUEUED');
  });

  it('(c) poll mode emits ZERO NOTIFY end to end (API-style writes + a per_scope/poll Worker), while an event-mode write is heard', async () => {
    expect(resolveDispatchConfig({ get: () => undefined })).toMatchObject({ claimMode: 'per_scope', dispatchMode: 'poll' });
    const factoryEnv = (mode: 'poll' | 'event') => ({ NODE_ENV: 'test', PG_DATABASE_URL: APP_URL, WORKER_DISPATCH_MODE: mode });
    const apiPoll = createPgDataSource(resolvePgEnvironment(factoryEnv('poll'), { processRole: 'api', enforceProcessPolicy: false }), { purpose: 'runtime', max: 2 }, { name: `poll-api-${Date.now()}`, entities: [] });
    const workerPoll = createPgDataSource(resolvePgEnvironment(factoryEnv('poll'), { processRole: 'worker', enforceProcessPolicy: false }), { purpose: 'runtime', max: 2 }, { name: `poll-worker-${Date.now()}`, entities: [] });
    const apiEvent = createPgDataSource(resolvePgEnvironment(factoryEnv('event'), { processRole: 'api', enforceProcessPolicy: false }), { purpose: 'runtime', max: 1 }, { name: `event-api-${Date.now()}`, entities: [] });
    const listener = new Client({ connectionString: APP_URL, application_name: 'crewflow-it-listener' });
    const heard: Notification[] = [];
    await Promise.all([apiPoll.initialize(), workerPoll.initialize(), apiEvent.initialize(), listener.connect()]);
    try {
      const SHOW = `SELECT pg_catalog.current_setting('crewflow.dispatch_notify', true) AS v`;
      expect((await apiPoll.query(SHOW))[0].v ?? null).toBeNull();
      expect((await workerPoll.query(SHOW))[0].v ?? null).toBeNull();
      expect((await apiEvent.query(SHOW))[0].v).toBe('on');
      listener.on('notification', (n) => {
        if (n.channel === WORKER_WAKE_CHANNEL) heard.push(n);
      });
      await listener.query(`LISTEN ${WORKER_WAKE_CHANNEL}`);

      const env = app.get(EnvironmentService);
      const resolver = app.get(SchemaResolverService);
      const apiTenant = new TenantContextService(apiPoll, resolver, env);
      const workerTenant = new TenantContextService(workerPoll, resolver, env);
      const eventTenant = new TenantContextService(apiEvent, resolver, env);
      const scope = { organisationId: owner.organisationId, workspaceId: owner.workspaceId, userId: owner.userId, role: '' };
      const insertEvent = (t: TenantContextService) =>
        t.runInTenantContext(scope, async (m) =>
          (
            await m.query<Array<{ id: string }>>(
              `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
               VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, 10, 1) RETURNING id`,
              [owner.organisationId, owner.workspaceId, owner.userId, `poll-it:${randomUUID()}`, randomUUID()],
            )
          )[0]!.id,
        );

      // API-style writes in poll mode: due-now realtime events and pending emails (each would NOTIFY in event mode).
      const pollIds: string[] = [];
      for (let i = 0; i < 3; i += 1) pollIds.push(await insertEvent(apiTenant));
      for (let i = 0; i < 3; i += 1) {
        const id = randomUUID();
        await apiTenant.runInTenantContext({ ...scope, workspaceId: null }, (m) =>
          m.query(
            `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, recipient_email, rendered_subject, rendered_html, rendered_text)
             VALUES ($1, $2, 'NOTIFICATION', 'PENDING', 'poll@example.test', 'Subject', '<p>body</p>', 'body')`,
            [id, owner.organisationId],
          ),
        );
        pollIds.push(id);
      }
      // The triggers fired (pointers exist) — they just did not NOTIFY.
      for (const id of pollIds) expect(await pointerCount(id)).toBe(1);

      // A per_scope + poll Worker processes them (its state changes fire the triggers again, still without NOTIFY).
      await runRealtimeOutboxPublishCycle(workerPoll, workerTenant, async () => 1, TEST_ENV, { scopes: [{ organisationId: owner.organisationId, workspaceId: owner.workspaceId! }] });
      await runEmailDispatchCycle(workerPoll, workerTenant, async () => undefined, async () => undefined, true);
      await sleep(1_500);
      expect(heard).toEqual([]); // ZERO NOTIFY in poll mode

      // Positive control: one event-mode write is heard (payload = the queue label only).
      await insertEvent(eventTenant);
      for (let i = 0; i < 20 && heard.length === 0; i += 1) await sleep(100);
      expect(heard.map((n) => n.payload)).toEqual(['realtime']);
    } finally {
      await listener.end().catch(() => undefined);
      await Promise.allSettled([apiPoll.destroy(), workerPoll.destroy(), apiEvent.destroy()]);
    }
  });
});
