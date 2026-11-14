import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { claimRealtimeEvents, completeRealtimeEvent, markRealtimeEventRetry, renewRealtimeEventLeases } from '../../core/database/realtime-event';
import { publishRealtimeScope } from '../../queues/rab-realtime/publish-outbox.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

/**
 * D-Q5a (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.2; audit §13 #6, realtime half).
 *
 * `claimRealtimeEvents` treats a `processing` row whose lease has expired as claimable again — the next claim IS the
 * reclaim. Before D-Q5a a reclaim did not count, so a row whose publisher died (or hung past the lease) every time was
 * re-claimed forever. Now, inside the same MATERIALIZED-CTE statement, a reclaim counts as an attempt, and a reclaim that
 * would reach `max_attempts` ends the row `failed` / `LEASE_RECLAIM_EXHAUSTED` (claim cleared) and is not returned —
 * the same cap and the same arithmetic `markRealtimeEventRetry` already applies to a failed publish.
 *
 * Real PostgreSQL, RLS on (crewflow_app runtime login, tenant context bound), no mocks. The lease is expired by moving
 * `lease_expires_at` into the past. Copied from the test-prep branch (phase-d/dq45-test-prep) and extended.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
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

async function newIdentity(label: string): Promise<TestIdentity> {
  return factory.createInternalManager(await factory.createOrganisation(label), { label });
}

async function seedEvent(identity: TestIdentity, maxAttempts = 10): Promise<string> {
  return withContext(identity, async (m) => {
    const rows = await m.query<Array<{ id: string }>>(
      `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
       VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, $6, 1) RETURNING id`,
      [identity.organisationId, identity.workspaceId, identity.userId, `dq5-reclaim:${randomUUID()}`, randomUUID(), maxAttempts],
    );
    return rows[0]!.id;
  });
}

async function expireLease(identity: TestIdentity, id: string): Promise<void> {
  await withContext(identity, (m) => m.query(`UPDATE core.realtime_event SET lease_expires_at = now() - interval '1 minute' WHERE id = $1 AND status = 'processing'`, [id]));
}

interface Row {
  status: string;
  attempt_count: number;
  last_error_code: string | null;
  claim_token: string | null;
  lease_expires_at: Date | null;
  next_retry_at: Date | null;
  last_error_at: Date | null;
}
async function row(identity: TestIdentity, id: string): Promise<Row> {
  return withContext(identity, async (m) => (await m.query(`SELECT status, attempt_count, last_error_code, claim_token, lease_expires_at, next_retry_at, last_error_at FROM core.realtime_event WHERE id = $1`, [id]))[0]);
}

/** Claims (per_scope SQL, or the global-mode `ids` SQL), returns whether `id` came back. */
async function claimed(identity: TestIdentity, id: string, mode: 'per_scope' | 'global' = 'per_scope'): Promise<boolean> {
  const rows = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID(), leaseSeconds: 60, ...(mode === 'global' ? { ids: [id] } : {}) }));
  return rows.some((r) => r.id === id);
}

async function pointerExists(id: string): Promise<boolean> {
  const rows = await adminDataSource.query(`SELECT 1 FROM core.worker_dispatch_pointer WHERE queue = 'realtime' AND subject_id = $1`, [id]);
  return rows.length > 0;
}

describeIfDb('D-Q5a §13 #6: a realtime lease reclaim counts as an attempt and is capped', () => {
  beforeAll(boot, 60_000);

  it('a first claim of a pending row is not an attempt (unchanged)', async () => {
    const identity = await newIdentity('dq5a1');
    const id = await seedEvent(identity, 10);
    expect(await claimed(identity, id)).toBe(true);
    expect(await row(identity, id)).toMatchObject({ status: 'processing', attempt_count: 0, last_error_code: null });
  });

  it('one reclaim → attempt_count 1, still returned, fresh claim token and lease', async () => {
    const identity = await newIdentity('dq5a2');
    const id = await seedEvent(identity, 10);
    await claimed(identity, id);
    const before = await row(identity, id);
    await expireLease(identity, id);
    expect(await claimed(identity, id)).toBe(true);
    const after = await row(identity, id);
    expect(after).toMatchObject({ status: 'processing', attempt_count: 1, last_error_code: null });
    expect(after.claim_token).not.toBe(before.claim_token);
    expect(after.lease_expires_at!.getTime()).toBeGreaterThan(Date.now());
  });

  it.each(['per_scope', 'global'] as const)('%s: with max_attempts 3 the row is returned exactly 3 times in total, then ends failed LEASE_RECLAIM_EXHAUSTED with its claim cleared', async (mode) => {
    const identity = await newIdentity(`dq5a3${mode}`);
    const id = await seedEvent(identity, 3);
    let returned = 0;
    if (await claimed(identity, id, mode)) returned += 1;
    for (let i = 0; i < 6; i += 1) {
      await expireLease(identity, id);
      if (await claimed(identity, id, mode)) returned += 1;
    }
    expect(returned).toBe(3);
    const final = await row(identity, id);
    expect(final).toMatchObject({ status: 'failed', attempt_count: 3, last_error_code: 'LEASE_RECLAIM_EXHAUSTED', claim_token: null, lease_expires_at: null, next_retry_at: null });
    expect(final.last_error_at).not.toBeNull();
  });

  it('with the default max_attempts (10): 1 claim + 9 reclaims are returned, the 10th reclaim fails the row', async () => {
    const identity = await newIdentity('dq5a4');
    const id = await seedEvent(identity, 10);
    let returned = (await claimed(identity, id)) ? 1 : 0;
    for (let i = 0; i < 12; i += 1) {
      await expireLease(identity, id);
      if (await claimed(identity, id)) returned += 1;
    }
    expect(returned).toBe(10);
    expect(await row(identity, id)).toMatchObject({ status: 'failed', attempt_count: 10, last_error_code: 'LEASE_RECLAIM_EXHAUSTED' });
  });

  it('a publish failure and reclaims share ONE cap (the existing max_attempts, the same arithmetic as markRealtimeEventRetry)', async () => {
    const identity = await newIdentity('dq5a5');
    const id = await seedEvent(identity, 3);
    const [first] = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID() }));
    expect(await withContext(identity, (m) => markRealtimeEventRetry(m, id, first!.claimToken, 'PUBLISH_FAILED', 0))).toBe('retry');
    expect(await claimed(identity, id)).toBe(true); // claim of a RETRY row: not a reclaim, not counted
    expect((await row(identity, id)).attempt_count).toBe(1);
    await expireLease(identity, id);
    expect(await claimed(identity, id)).toBe(true); // reclaim: 1 → 2
    await expireLease(identity, id);
    expect(await claimed(identity, id)).toBe(false); // reclaim: 2 → 3 = max → failed
    expect(await row(identity, id)).toMatchObject({ status: 'failed', attempt_count: 3, last_error_code: 'LEASE_RECLAIM_EXHAUSTED' });
  });

  it('a failed (exhausted) row is never claimable again, in either mode', async () => {
    const identity = await newIdentity('dq5a6');
    const id = await seedEvent(identity, 1);
    await claimed(identity, id);
    await expireLease(identity, id);
    expect(await claimed(identity, id)).toBe(false);
    expect((await row(identity, id)).status).toBe('failed');
    expect(await claimed(identity, id)).toBe(false);
    expect(await claimed(identity, id, 'global')).toBe(false);
  });

  it('a row whose lease has NOT expired is neither counted nor returned (unchanged)', async () => {
    const identity = await newIdentity('dq5a7');
    const id = await seedEvent(identity, 2);
    await claimed(identity, id);
    expect(await claimed(identity, id)).toBe(false);
    expect(await row(identity, id)).toMatchObject({ status: 'processing', attempt_count: 0 });
  });

  it('the fenced completion of the reclaimed attempt still works; the stale token is still refused (unchanged)', async () => {
    const identity = await newIdentity('dq5a8');
    const id = await seedEvent(identity, 10);
    const [a] = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID() }));
    await expireLease(identity, id);
    const [b] = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID() }));
    expect(b!.attemptCount).toBe(1);
    expect(await withContext(identity, (m) => completeRealtimeEvent(m, id, a!.claimToken))).toBe(false);
    expect(await withContext(identity, (m) => completeRealtimeEvent(m, id, b!.claimToken))).toBe(true);
    expect((await row(identity, id)).status).toBe('completed');
  });

  it('two replicas reclaiming the same expired row at once: exactly one gets it, and it is counted ONCE', async () => {
    const identity = await newIdentity('dq5a9');
    const id = await seedEvent(identity, 10);
    await claimed(identity, id);
    await expireLease(identity, id);
    const results = await Promise.all([claimed(identity, id), claimed(identity, id), claimed(identity, id, 'global')]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await row(identity, id)).attempt_count).toBe(1);
  });

  it('publish path (per_scope): an exhausted row is not published and is reported as failed; a due row in the same batch is published', async () => {
    const identity = await newIdentity('dq5a10');
    const doomed = await seedEvent(identity, 1);
    await claimed(identity, doomed);
    await expireLease(identity, doomed);
    const fresh = await seedEvent(identity, 10);
    const published: string[] = [];
    const result = await publishRealtimeScope(tenantContext, async (_channel, message) => {
      published.push(String((JSON.parse(message) as { eventId?: string }).eventId));
      return 1;
    }, 'test', { organisationId: identity.organisationId, workspaceId: identity.workspaceId });
    expect(result).toMatchObject({ claimed: 1, published: 1, failed: 1 });
    expect(published).toEqual([fresh]);
    expect((await row(identity, doomed)).status).toBe('failed');
  });

  it('global mode: the pointer of an exhausted row is removed by the existing trigger (failed is terminal for realtime)', async () => {
    const identity = await newIdentity('dq5a11');
    const id = await seedEvent(identity, 1);
    expect(await pointerExists(id)).toBe(true);
    await claimed(identity, id, 'global');
    await expireLease(identity, id);
    expect(await pointerExists(id)).toBe(true); // processing, lease expired: still an open subject
    expect(await claimed(identity, id, 'global')).toBe(false);
    expect(await pointerExists(id)).toBe(false);
  });

  it('ABUSE (isolation): a reclaim under another organisation\'s context never sees the row and counts nothing (RLS)', async () => {
    const a = await newIdentity('dq5aA');
    const b = await newIdentity('dq5aB');
    const id = await seedEvent(a, 1);
    expect(await claimed(a, id)).toBe(true);
    await expireLease(a, id);
    expect(await claimed(b, id)).toBe(false);
    expect(await claimed(b, id, 'global')).toBe(false);
    expect(await row(a, id)).toMatchObject({ status: 'processing', attempt_count: 0 });
  });

  it('ABUSE (fail closed): a claim with NO tenant context bound returns zero rows and counts nothing', async () => {
    const identity = await newIdentity('dq5aNoCtx');
    const id = await seedEvent(identity, 1);
    await claimed(identity, id);
    await expireLease(identity, id);
    const none = await dataSource.transaction((m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID() }));
    expect(none).toEqual([]);
    const noneGlobal = await dataSource.transaction((m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID(), ids: [id] }));
    expect(noneGlobal).toEqual([]);
    expect(await row(identity, id)).toMatchObject({ status: 'processing', attempt_count: 0 });
  });
  it("lease renewal (CodeRabbit on #47): only the live claimant's token renews, only under its own organisation", async () => {
    const a = await newIdentity('dq5aRenA');
    const b = await newIdentity('dq5aRenB');
    const id = await seedEvent(a, 10);
    const [c] = await withContext(a, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID(), leaseSeconds: 1 }));
    expect(await withContext(a, (m) => renewRealtimeEventLeases(m, [id], randomUUID(), 300))).toEqual([]); // wrong token
    expect(await withContext(b, (m) => renewRealtimeEventLeases(m, [id], c!.claimToken, 300))).toEqual([]); // other organisation (RLS)
    expect(await dataSource.transaction((m) => renewRealtimeEventLeases(m, [id], c!.claimToken, 300))).toEqual([]); // no tenant context
    expect(await withContext(a, (m) => renewRealtimeEventLeases(m, [id], c!.claimToken, 300))).toEqual([id]);
    const after = await row(a, id);
    expect(after.lease_expires_at!.getTime()).toBeGreaterThan(Date.now() + 250_000);
    expect(after).toMatchObject({ status: 'processing', attempt_count: 0, claim_token: c!.claimToken });
  });

  it('a slow but live publisher keeps its batch: a competing claim during the batch gets nothing and nothing is counted', async () => {
    const identity = await newIdentity('dq5aSlow');
    const ids = [await seedEvent(identity, 10), await seedEvent(identity, 10), await seedEvent(identity, 10)];
    const competitor: string[] = [];
    let n = 0;
    const result = await publishRealtimeScope(tenantContext, async () => {
      n += 1;
      await new Promise((r) => setTimeout(r, 1_200)); // lease 2 s: without renewal, row 3 is past its lease here
      if (n === 3) {
        const got = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID(), leaseSeconds: 60 }));
        competitor.push(...got.map((g) => g.id));
      }
      return 1;
    }, 'test', { organisationId: identity.organisationId, workspaceId: identity.workspaceId }, { leaseSeconds: 2 });
    expect(competitor).toEqual([]);
    expect(result).toMatchObject({ claimed: 3, published: 3, failed: 0, lostLease: 0 });
    for (const id of ids) expect(await row(identity, id)).toMatchObject({ status: 'completed', attempt_count: 0 });
  });

  it('a row reclaimed by another claimant before the renewal is NOT published by the original claimant; the rows it still holds are (CodeRabbit on #47)', async () => {
    const identity = await newIdentity('dq5aLost');
    const ids = [await seedEvent(identity, 10), await seedEvent(identity, 10), await seedEvent(identity, 10)];
    const published: string[] = [];
    let competitorToken = '';
    const result = await publishRealtimeScope(tenantContext, async (_channel, message) => {
      const eventId = String((JSON.parse(message) as { eventId?: string }).eventId);
      published.push(eventId);
      if (eventId === ids[0]) {
        await new Promise((r) => setTimeout(r, 2_300)); // past the 2 s lease, before any renewal check
        const [got] = await withContext(identity, (m) => claimRealtimeEvents(m, { limit: 25, claimToken: randomUUID(), leaseSeconds: 60, ids: [ids[2]!] }));
        competitorToken = got!.claimToken;
      }
      return 1;
    }, 'test', { organisationId: identity.organisationId, workspaceId: identity.workspaceId }, { leaseSeconds: 2 });
    expect(published).toEqual([ids[0], ids[1]]); // never ids[2]: another claimant holds it
    expect(result).toMatchObject({ claimed: 3, published: 2, failed: 0, lostLease: 1 });
    expect(await row(identity, ids[2]!)).toMatchObject({ status: 'processing', attempt_count: 1, claim_token: competitorToken });
  });
});
