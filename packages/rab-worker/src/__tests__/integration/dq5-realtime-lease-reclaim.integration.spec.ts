import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { claimRealtimeEvents, markRealtimeEventRetry } from '../../core/database/realtime-event';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * D-Q5 test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q5.2; audit §13 #6, realtime half).
 *
 * `claimRealtimeEvents` (core/database/realtime-event.ts) treats a `processing` row whose lease has expired as claimable
 * again — the next claim IS the reclaim. A publish that throws goes through `markRealtimeEventRetry`, which counts the
 * attempt and ends `failed` at `max_attempts`. A reclaim does NOT count: a row whose publisher dies (or hangs past the
 * lease) every time is re-claimed forever and never reaches `failed`.
 *
 * Real PostgreSQL, RLS on (crewflow_app runtime login, tenant context bound), no mocks. Rows are seeded directly, as in
 * realtime-event-outbox-claim.integration.spec.ts. The lease is expired by moving `lease_expires_at` into the past.
 *
 * CHARACTERISATION tests pass today and pin the defect. The FAILING-FIRST block (DQ45_PENDING_SPECS=1) encodes the
 * PROPOSED fix: a reclaim counts as an attempt, and a reclaim that would reach `max_attempts` ends the row `failed`
 * with `last_error_code = 'LEASE_RECLAIM_EXHAUSTED'` instead of returning it. No business rule: realtime events are
 * ids-only hints (class A delivery), and `max_attempts` already exists.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const describePending = RUN && process.env.DQ45_PENDING_SPECS === '1' ? describe : describe.skip;
jest.setTimeout(90_000);

let app: import('@nestjs/common').INestApplication;
let dataSource: DataSource;
let adminDataSource: DataSource;
let tenantContext: TenantContextService;
let factory: TestIdentityFactory;

async function boot(): Promise<void> {
  if (app) return;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  dataSource = app.get(DataSource);
  tenantContext = app.get(TenantContextService);
  adminDataSource = createAdminDataSource();
  await adminDataSource.initialize();
  factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
}

afterAll(async () => {
  if (app) await app.close();
  if (adminDataSource?.isInitialized) await adminDataSource.destroy();
});

function withContext<T>(identity: TestIdentity, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
  return tenantContext.runInTenantContext({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, fn);
}

async function seedEvent(identity: TestIdentity, maxAttempts = 10): Promise<string> {
  return withContext(identity, async (m) => {
    const rows = await m.query<Array<{ id: string }>>(
      `INSERT INTO core.realtime_event (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, max_attempts)
       VALUES ($1, $2, $3, 'offer.sent', 'offer', $4, $5) RETURNING id`,
      [identity.organisationId, identity.workspaceId, `dq5-reclaim:${randomUUID()}`, randomUUID(), maxAttempts],
    );
    return rows[0]!.id;
  });
}

async function expireLease(identity: TestIdentity, id: string): Promise<void> {
  await withContext(identity, (m) => m.query(`UPDATE core.realtime_event SET lease_expires_at = now() - interval '1 minute' WHERE id = $1 AND status = 'processing'`, [id]));
}

async function row(identity: TestIdentity, id: string): Promise<{ status: string; attempt_count: number; last_error_code: string | null }> {
  return withContext(identity, async (m) => (await m.query(`SELECT status, attempt_count, last_error_code FROM core.realtime_event WHERE id = $1`, [id]))[0]);
}

/** Claims (per_scope SQL, or the global-mode `ids` SQL), returns whether `id` came back. */
async function claimed(identity: TestIdentity, id: string, mode: 'per_scope' | 'global' = 'per_scope'): Promise<boolean> {
  const rows = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID(), leaseSeconds: 60, ...(mode === 'global' ? { ids: [id] } : {}) }));
  return rows.some((r) => r.id === id);
}

describeIfDb('D-Q5 characterisation §13 #6: realtime lease reclaims are uncounted and uncapped', () => {
  beforeAll(boot, 60_000);

  it('a row reclaimed 12 times (max_attempts 10) is still returned every time with attempt_count 0', async () => {
    const identity = await factory.createInternalManager(await factory.createOrganisation('dq5rt'), { label: 'dq5rt' });
    const id = await seedEvent(identity, 10);
    expect(await claimed(identity, id)).toBe(true);
    for (let i = 0; i < 12; i += 1) {
      await expireLease(identity, id);
      expect(await claimed(identity, id)).toBe(true);
    }
    expect(await row(identity, id)).toEqual({ status: 'processing', attempt_count: 0, last_error_code: null });
  });

  it('the global-mode claim (ids) reclaims the same way, also uncounted', async () => {
    const identity = await factory.createInternalManager(await factory.createOrganisation('dq5rtg'), { label: 'dq5rtg' });
    const id = await seedEvent(identity, 3);
    expect(await claimed(identity, id, 'global')).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      await expireLease(identity, id);
      expect(await claimed(identity, id, 'global')).toBe(true);
    }
    expect((await row(identity, id)).attempt_count).toBe(0);
  });

  it('by contrast, a publish failure IS counted and capped (markRealtimeEventRetry, unchanged)', async () => {
    const identity = await factory.createInternalManager(await factory.createOrganisation('dq5rtr'), { label: 'dq5rtr' });
    const id = await seedEvent(identity, 2);
    const [first] = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID() }));
    expect(first?.id).toBe(id);
    expect(await withContext(identity, (m) => markRealtimeEventRetry(m, id, first!.claimToken, 'PUBLISH_FAILED', 0))).toBe('retry');
    expect((await row(identity, id)).attempt_count).toBe(1);
    const [second] = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID() }));
    expect(second?.id).toBe(id);
    expect(await withContext(identity, (m) => markRealtimeEventRetry(m, id, second!.claimToken, 'PUBLISH_FAILED', 0))).toBe('failed');
    expect(await row(identity, id)).toEqual({ status: 'failed', attempt_count: 2, last_error_code: 'PUBLISH_FAILED' });
  });

  it('isolation: a reclaim under another organisation\'s context never sees the row (RLS)', async () => {
    const a = await factory.createInternalManager(await factory.createOrganisation('dq5rtA'), { label: 'dq5rtA' });
    const b = await factory.createInternalManager(await factory.createOrganisation('dq5rtB'), { label: 'dq5rtB' });
    const id = await seedEvent(a, 10);
    expect(await claimed(a, id)).toBe(true);
    await expireLease(a, id);
    expect(await claimed(b, id)).toBe(false);
    expect(await claimed(b, id, 'global')).toBe(false);
    expect((await row(a, id)).status).toBe('processing');
  });
});

describePending('PENDING D-Q5.2 (failing-first; PROPOSED): a lease reclaim counts as an attempt and is capped', () => {
  beforeAll(boot, 60_000);

  it('one reclaim → attempt_count 1', async () => {
    const identity = await factory.createInternalManager(await factory.createOrganisation('dq5p1'), { label: 'dq5p1' });
    const id = await seedEvent(identity, 10);
    await claimed(identity, id);
    await expireLease(identity, id);
    expect(await claimed(identity, id)).toBe(true);
    expect((await row(identity, id)).attempt_count).toBe(1);
  });

  it.each(['per_scope', 'global'] as const)('%s: with max_attempts 3 the row is returned at most 3 times in total, then ends failed LEASE_RECLAIM_EXHAUSTED', async (mode) => {
    const identity = await factory.createInternalManager(await factory.createOrganisation(`dq5p2${mode}`), { label: `dq5p2${mode}` });
    const id = await seedEvent(identity, 3);
    let returned = 0;
    if (await claimed(identity, id, mode)) returned += 1;
    for (let i = 0; i < 6; i += 1) {
      await expireLease(identity, id);
      if (await claimed(identity, id, mode)) returned += 1;
    }
    expect(returned).toBeLessThanOrEqual(3);
    expect(await row(identity, id)).toMatchObject({ status: 'failed', last_error_code: 'LEASE_RECLAIM_EXHAUSTED' });
  });

  it('a first claim of a pending row is not an attempt (unchanged)', async () => {
    const identity = await factory.createInternalManager(await factory.createOrganisation('dq5p3'), { label: 'dq5p3' });
    const id = await seedEvent(identity, 10);
    await claimed(identity, id);
    expect((await row(identity, id)).attempt_count).toBe(0);
  });
});
