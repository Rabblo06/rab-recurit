import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { claimDispatchPointers, DISPATCH_QUEUES, releaseDispatchClaim } from '../../core/database/dispatch-claims';
import { DispatchCoordinator } from '../../core/wake/dispatch-coordinator';
import { dispatchEmailScope } from '../../queues/rab-email/email-dispatch.job';
import { publishRealtimeScope, RealtimePublishFn } from '../../queues/rab-realtime/publish-outbox.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * Phase D (D1) — the Worker's global claim against the REAL pointer table, triggers and SECURITY DEFINER functions.
 *
 * OPT-IN: these tests need migrations 1786721300000–1786721320000 (owner-approved 2026-11-01; applied on disposable test
 * databases only) and an operator-created `crewflow_worker` login. They are skipped unless BOTH PHASE_D_SQL_APPROVED=true
 * and TEST_DATABASE_WORKER_URL (a crewflow_worker URL for the test database) are set. Never on a real database.
 *
 * What runs here (realtime is the queue whose producer can be seeded without the API's services):
 *  1. A committed realtime_event gets a pointer (trigger); crewflow_worker claims it with routing ids only; the existing
 *     scoped claim restricted to the id publishes it once; the completion deletes the pointer (nothing claimable after).
 *  2. A claimed id processed under ANOTHER organisation's scope (forged / altered routing) finds nothing and publishes
 *     nothing; the subject stays claimable for its real scope.
 *  3. Release: a stale token is refused (false); the current token re-times the pointer (true).
 *  4. Two coordinators (two Worker processes, two crewflow_worker sessions) over 30 events in 3 organisations: every
 *     event published exactly once.
 *  5. The runtime login (crewflow_app — the API identity) cannot execute any claim/release function (42501): global mode
 *     needs the Worker to run as crewflow_worker, which the boot gate enforces (Agent C).
 *  6. Wave 5 (F-W4-1): a 50-row email backlog in ONE organisation (server cap: 10 per organisation per claim) drains in ONE
 *     coordinator run — before the fix a run stopped at the first short batch and drained 10 rows per tick / NOTIFY.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL) && integrationTestDatabaseReady();
const describeIfApproved = RUN ? describe : describe.skip;
const TEST_ENV = 'inttest';
jest.setTimeout(120_000);

describeIfApproved('Phase D global dispatch claim (integration — opt-in)', () => {
  let app: import('@nestjs/common').INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  let workerA: DataSource;
  let workerB: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  const workerDataSource = () =>
    new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 2, application_name: 'crewflow-worker-it' } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = createTestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    workerA = workerDataSource();
    workerB = workerDataSource();
    await workerA.initialize();
    await workerB.initialize();
    const [{ current_user: who }] = await workerA.query<[{ current_user: string }]>('SELECT current_user');
    // BC-08 (Phase D under one login): the Worker runs on crewflow_owner; crewflow_worker is a schema role.
    expect(who).toBe('crewflow_owner');
  });

  afterAll(async () => {
    await workerA?.destroy();
    await workerB?.destroy();
    await app?.close();
    await admin?.destroy();
  });

  async function withContext<T>(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, fn: (m: EntityManager) => Promise<T>): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, fn);
  }

  async function seedEvent(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, targetUserId: string): Promise<string> {
    return withContext(identity, async (m) => {
      const rows = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
         VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, 10, 1) RETURNING id`,
        [identity.organisationId, identity.workspaceId, targetUserId, `phase-d-it:${randomUUID()}`, randomUUID()],
      );
      return rows[0]!.id;
    });
  }

  async function status(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, id: string): Promise<string | null> {
    return withContext(identity, async (m) => (await m.query<Array<{ status: string }>>(`SELECT status FROM core.realtime_event WHERE id = $1`, [id]))[0]?.status ?? null);
  }

  /** Claims until our ids show up (other suites' pointers may be due too); returns only OUR claims. */
  async function claimOurs(worker: DataSource, ids: readonly string[]) {
    const wanted = new Set(ids);
    const ours = [];
    for (let i = 0; i < 20 && ours.length < wanted.size; i += 1) {
      const claims = await claimDispatchPointers(worker, 'realtime', 200);
      ours.push(...claims.filter((c) => wanted.has(c.subjectId)));
      if (claims.length < 200) break;
    }
    return ours;
  }

  function capture(): { publish: RealtimePublishFn; byEvent: Map<string, number> } {
    const byEvent = new Map<string, number>();
    return {
      byEvent,
      publish: async (_channel, message) => {
        const id = JSON.parse(message).eventId as string;
        byEvent.set(id, (byEvent.get(id) ?? 0) + 1);
        return 1;
      },
    };
  }

  it('1. trigger → pointer → crewflow_worker claim (routing ids only) → scoped claim restricted to the id → published once → pointer gone', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pd1' });
    const staff = await factory.createStaff({ id: manager.organisationId }, { owner: manager, label: 'pd1-staff' });
    const id = await seedEvent(manager, staff.userId);
    const [claim] = await claimOurs(workerA, [id]);
    expect(claim).toMatchObject({ subjectId: id, organisationId: manager.organisationId, workspaceId: manager.workspaceId });
    expect(Object.keys(claim!).sort()).toEqual(['claimCount', 'claimToken', 'organisationId', 'subjectId', 'workspaceId']);
    const cap = capture();
    const result = await publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, { organisationId: claim!.organisationId, workspaceId: claim!.workspaceId }, { ids: [id] });
    expect(result).toMatchObject({ claimed: 1, published: 1 });
    expect(cap.byEvent.get(id)).toBe(1);
    expect(await status(manager, id)).toBe('completed');
    expect(await claimOurs(workerB, [id])).toEqual([]); // terminal → the trigger deleted the pointer
  });

  it('2. a claimed id processed under another organisation\'s scope finds nothing (RLS) and publishes nothing', async () => {
    const victim = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pd2v' });
    const victimStaff = await factory.createStaff({ id: victim.organisationId }, { owner: victim, label: 'pd2v-staff' });
    const attacker = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pd2a' });
    const id = await seedEvent(victim, victimStaff.userId);
    await claimOurs(workerA, [id]);
    const cap = capture();
    const forged = await publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, { organisationId: attacker.organisationId, workspaceId: attacker.workspaceId }, { ids: [id] });
    expect(forged).toMatchObject({ claimed: 0, published: 0 });
    expect(cap.byEvent.size).toBe(0);
    expect(await status(victim, id)).toBe('pending');
  });

  it('3. release: a stale token is refused; the current token re-times the pointer', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pd3' });
    const staff = await factory.createStaff({ id: manager.organisationId }, { owner: manager, label: 'pd3-staff' });
    const id = await seedEvent(manager, staff.userId);
    const [claim] = await claimOurs(workerA, [id]);
    expect(await releaseDispatchClaim(workerB, 'realtime', id, randomUUID(), 1)).toBe(false);
    expect(await releaseDispatchClaim(workerA, 'realtime', id, claim!.claimToken, 1)).toBe(true);
    expect(await releaseDispatchClaim(workerA, 'realtime', id, claim!.claimToken, 1)).toBe(false); // the token was cleared
  });

  it('4. two Worker processes, 30 events in 3 organisations: every event published exactly once', async () => {
    const ids: string[] = [];
    const scopes: Array<Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>> = [];
    for (let o = 0; o < 3; o += 1) {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: `pd4-${o}` });
      const staff = await factory.createStaff({ id: manager.organisationId }, { owner: manager, label: `pd4-${o}-staff` });
      scopes.push(manager);
      for (let e = 0; e < 10; e += 1) ids.push(await seedEvent(manager, staff.userId));
    }
    const cap = capture();
    const binding = {
      queue: 'realtime' as const,
      legacy: async () => false,
      processScope: async (scope: { organisationId: string; workspaceId: string | null; subjectIds: string[] }) =>
        (await publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, scope, { ids: scope.subjectIds })).claimed,
    };
    const logger = { log: () => undefined, warn: () => undefined };
    const a = new DispatchCoordinator([binding], { claimer: workerA, batch: 7, reconcileMs: 900_000, logger });
    const b = new DispatchCoordinator([binding], { claimer: workerB, batch: 7, reconcileMs: 900_000, logger });
    await Promise.all([a.tick('realtime'), b.tick('realtime'), a.tick('realtime'), b.tick('realtime')]);
    for (const id of ids) expect(cap.byEvent.get(id)).toBe(1);
    for (const [i, id] of ids.entries()) expect(await status(scopes[Math.floor(i / 10)]!, id)).toBe('completed');
  });

  // P-class (owner-login architecture). The schema role crewflow_app (the old API login) still cannot execute any claim or
  // release function: 42501 through the fixture superuser's SET LOCAL ROLE, rolled back. The one runtime login (API and
  // Worker alike) CAN: OWNER-LOGIN DIFFERENCE BC-08 (DBA-01 lost, ACCEPTED (owner, 2026-11-05)), reproduced green inside a
  // transaction that is always rolled back, so no pointer is leased.
  it('5. the schema role crewflow_app cannot execute any claim or release function (42501); the runtime login can (BC-08, rolled back)', async () => {
    const asSchemaApp = (fn: (m: EntityManager) => Promise<unknown>) =>
      admin.transaction(async (m) => {
        await m.query(`SET LOCAL ROLE crewflow_app`);
        await fn(m);
      });
    for (const queue of DISPATCH_QUEUES) {
      await expect(asSchemaApp((m) => claimDispatchPointers(m, queue, 1))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(asSchemaApp((m) => releaseDispatchClaim(m, 'email', randomUUID(), randomUUID(), 1))).rejects.toMatchObject({ code: '42501' });
    const rollback = new Error('rollback');
    await expect(
      runtime.transaction(async (m) => {
        for (const queue of DISPATCH_QUEUES) await claimDispatchPointers(m, queue, 1);
        await releaseDispatchClaim(m, 'email', randomUUID(), randomUUID(), 1);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });

  it('6. F-W4-1: a 50-row single-organisation email backlog drains in ONE run (5 claims of 10 under the per-organisation cap)', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pd6' });
    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const id = randomUUID();
      await tenantContext.runInTenantContext({ organisationId: manager.organisationId, workspaceId: null, userId: manager.userId, role: '' }, (m) =>
        m.query(
          `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, target_user_id, recipient_email, rendered_subject, rendered_html, rendered_text)
           VALUES ($1, $2, 'NOTIFICATION', 'PENDING', $3, 'pd6@example.test', 'Subject', '<p>body</p>', 'body')`,
          [id, manager.organisationId, manager.userId],
        ),
      );
      ids.add(id);
    }
    const ourClaimsPerCall: number[] = [];
    const claimer = {
      query: async (sql: string, params?: unknown[]) => {
        const rows = (await workerA.query(sql, params)) as Array<{ subject_id?: string }>;
        if (sql.includes('worker_claim_')) ourClaimsPerCall.push(rows.filter((r) => ids.has(r.subject_id ?? '')).length);
        return rows;
      },
    };
    const published = new Map<string, number>();
    const publish = async (id: string) => void published.set(id, (published.get(id) ?? 0) + 1);
    const coordinator = new DispatchCoordinator(
      [{
        queue: 'email',
        legacy: async () => false, // no sweep: the global claim alone must drain the backlog
        processScope: async (scope) => (await dispatchEmailScope(tenantContext, scope.organisationId, scope.subjectIds, publish, async () => undefined, true)).claimed,
      }],
      { claimer, batch: 100, reconcileMs: 900_000, logger: { log: () => undefined, warn: () => undefined }, setTimeout: (() => 0) as unknown as typeof setTimeout },
    );
    await coordinator.tick('email'); // ONE run (follow-ups disabled by the inert timer)
    for (const id of ids) expect(published.get(id)).toBe(1);
    expect(ourClaimsPerCall.filter((n) => n > 0)).toEqual([10, 10, 10, 10, 10]); // the per-organisation cap, 5 times, in one run
  });
});
