import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { claimRealtimeEvents, completeRealtimeEvent, markRealtimeEventRetry, cancelRealtimeEvent } from '../../core/database/realtime-event';
import { createAdminDataSource } from './helpers/admin-datasource';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Worker-side claim/complete/retry/cancel for `core.realtime_event`
 * (`RealtimeEventOutbox1786698000000`, `rab-server`) — see
 * `core/database/realtime-event.ts`'s own doc comment for the claim/lease/
 * fencing design this proves. Real Postgres, RLS on, no mocks.
 *
 * Nothing in production calls these functions yet (Stage 1 is the outbox
 * foundation only — no Redis Pub/Sub distribution, no gateway); these
 * tests exist to prove the mechanism itself before any later stage builds
 * a consumer on top of it, same reasoning as `worker-event-idempotency.
 * integration.spec.ts` for `core.worker_event`'s own claim helpers.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('realtime event outbox — claim/complete/retry/cancel (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function withContext<T>(identity: TestIdentity, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, fn);
  }

  /** Raw INSERT, bypassing `RealtimeEventService` (a `rab-server`-only NestJS provider) — mirrors how `worker-event-idempotency.integration.spec.ts` seeds rows directly for the same reason. */
  async function seedEvent(identity: TestIdentity, opts: { maxAttempts?: number } = {}): Promise<{ id: string; eventKey: string }> {
    const eventKey = `test-realtime-event:${randomUUID()}`;
    return withContext(identity, async (m) => {
      const rows = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.realtime_event (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, max_attempts)
         VALUES ($1, $2, $3, 'offer.sent', 'offer', $4, $5) RETURNING id`,
        [identity.organisationId, identity.workspaceId, eventKey, randomUUID(), opts.maxAttempts ?? 10],
      );
      return { id: rows[0]!.id, eventKey };
    });
  }

  async function rowStatus(identity: TestIdentity, id: string): Promise<{ status: string; attempt_count: number; claim_token: string | null; next_retry_at: Date | null } | null> {
    return withContext(identity, async (m) => {
      const rows = await m.query(`SELECT status, attempt_count, claim_token, next_retry_at FROM core.realtime_event WHERE id = $1`, [id]);
      return rows[0] ?? null;
    });
  }

  describe('claimRealtimeEvents — atomic batch claim', () => {
    it('a single claim succeeds, marks the row processing, and mints a fresh claim token', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtclaim1' });
      const { id } = await seedEvent(manager);
      const token = randomUUID();

      const claimed = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: token }));
      expect(claimed.map((c) => c.id)).toContain(id);

      const after = await rowStatus(manager, id);
      expect(after?.status).toBe('processing');
      expect(after?.claim_token).toBe(token);
    });

    it('FIVE concurrent claimers racing for FIVE pending rows: every row is claimed exactly once, across all callers combined', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { label: 'rtclaim5' });
      const ids = await Promise.all(Array.from({ length: 5 }, () => seedEvent(manager).then((e) => e.id)));

      const attempts = Array.from({ length: 5 }, () => withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: randomUUID() })));
      const results = await Promise.all(attempts);
      const claimedIds = results.flat().map((c) => c.id);

      // Every id claimed at most once overall — SKIP LOCKED means no two concurrent claimers ever see the same row.
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      // And every seeded row was claimed by SOMEONE.
      for (const id of ids) expect(claimedIds).toContain(id);
    });

    it('a claimed row is never returned again by a second claim call while its lease is still live', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtclaimlive' });
      const { id } = await seedEvent(manager);
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: randomUUID(), leaseSeconds: 60 }));
      const second = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: randomUUID() }));
      expect(second.map((c) => c.id)).not.toContain(id);
    });

    // Regression test for a real bug found during Stage 1 benchmarking: a plain
    // `UPDATE t SET ... WHERE id IN (SELECT ... LIMIT $n FOR UPDATE SKIP LOCKED)`
    // against an RLS-protected table silently claims EVERY eligible row, ignoring
    // `limit` entirely — confirmed down to a two-line repro against this exact
    // table with the raw `pg` driver, no TypeORM involved. The fix wraps the
    // locked subquery in `WITH ... AS MATERIALIZED (...)` (see
    // `claimRealtimeEvents`'s own doc comment). Every OTHER test in this file
    // seeds exactly as many rows as the limit, which can never distinguish
    // "claimed exactly `limit`" from "claimed everything eligible" — this is
    // the one test that actually can, by seeding strictly MORE pending rows
    // than the limit.
    it('claiming with limit < the number of eligible pending rows claims EXACTLY limit, never more', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtclaimbound' });
      const seeded = await Promise.all(Array.from({ length: 40 }, () => seedEvent(manager).then((e) => e.id)));

      const claimed = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 10, claimToken: randomUUID() }));
      expect(claimed).toHaveLength(10);
      expect(new Set(claimed.map((c) => c.id)).size).toBe(10); // no duplicate within the single call either

      // The 30 un-claimed rows must still be pending, untouched.
      const stillPending = await withContext(manager, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.realtime_event WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [seeded]),
      );
      expect(Number(stillPending[0]!.count)).toBe(30);
    });
  });

  describe('crash recovery — an expired lease is reclaimable', () => {
    it('a row whose lease has expired is claimable again, by a different claim token', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtcrash' });
      const { id } = await seedEvent(manager);
      const tokenA = randomUUID();
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: tokenA, leaseSeconds: 60 }));

      // Simulate the claiming worker crashing: backdate the lease as if it expired minutes ago.
      await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1`, [id]));

      const tokenB = randomUUID();
      const reclaimed = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: tokenB }));
      expect(reclaimed.map((c) => c.id)).toContain(id);

      const after = await rowStatus(manager, id);
      expect(after?.claim_token).toBe(tokenB); // the new claimant's token, not the crashed worker's
    });

    it('fencing: the crashed worker\'s stale token can no longer complete the row once reclaimed', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtfence' });
      const { id } = await seedEvent(manager);
      const tokenA = randomUUID();
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: tokenA, leaseSeconds: 60 }));
      await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1`, [id]));
      const tokenB = randomUUID();
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: tokenB }));

      // The stale (reclaimed-away) token must silently fail, not overwrite the newer claimant's outcome.
      const staleComplete = await withContext(manager, (m) => completeRealtimeEvent(m, id, tokenA));
      expect(staleComplete).toBe(false);
      expect((await rowStatus(manager, id))?.status).toBe('processing'); // still processing under tokenB, untouched by the stale write

      const realComplete = await withContext(manager, (m) => completeRealtimeEvent(m, id, tokenB));
      expect(realComplete).toBe(true);
      expect((await rowStatus(manager, id))?.status).toBe('completed');
    });
  });

  describe('bounded retry — never an infinite retry loop', () => {
    it('attempt_count increments on markRealtimeEventRetry and schedules a future retry', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtretry1' });
      const { id } = await seedEvent(manager, { maxAttempts: 10 });
      const token = randomUUID();
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: token }));

      const outcome = await withContext(manager, (m) => markRealtimeEventRetry(m, id, token, 'redis_timeout', 30));
      expect(outcome).toBe('retry');
      const after = await rowStatus(manager, id);
      expect(after?.status).toBe('retry');
      expect(after?.attempt_count).toBe(1);
      expect(after?.next_retry_at).not.toBeNull();
    });

    it('once attempt_count reaches max_attempts, the NEXT retry attempt transitions to failed instead of scheduling another retry', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtretrybound' });
      const { id } = await seedEvent(manager, { maxAttempts: 2 });

      // Attempt 1: claim -> retry (attempt_count 0 -> 1, still < max_attempts 2).
      const token1 = randomUUID();
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: token1 }));
      const first = await withContext(manager, (m) => markRealtimeEventRetry(m, id, token1, 'redis_timeout', 0));
      expect(first).toBe('retry');
      expect((await rowStatus(manager, id))?.attempt_count).toBe(1);

      // Attempt 2: claim (due immediately, backoff was 0) -> retry again (attempt_count 1 -> 2, reaches max_attempts).
      const token2 = randomUUID();
      const reclaimed = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: token2 }));
      expect(reclaimed.map((c) => c.id)).toContain(id);
      const second = await withContext(manager, (m) => markRealtimeEventRetry(m, id, token2, 'redis_timeout', 0));
      expect(second).toBe('failed'); // bounded — never a third retry
      const final = await rowStatus(manager, id);
      expect(final?.status).toBe('failed');
      expect(final?.attempt_count).toBe(2);
      expect(final?.next_retry_at).toBeNull();

      // A failed row is never claimable again.
      const token3 = randomUUID();
      const thirdClaim = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: token3 }));
      expect(thirdClaim.map((c) => c.id)).not.toContain(id);
    });
  });

  describe('cancelRealtimeEvent — a permanent, non-retryable exit', () => {
    it('cancels a pending row, and a cancelled row is never claimable', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtcancel' });
      const { id } = await seedEvent(manager);
      await withContext(manager, (m) => cancelRealtimeEvent(m, id, 'source_entity_no_longer_valid'));
      expect((await rowStatus(manager, id))?.status).toBe('cancelled');

      const claimed = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: randomUUID() }));
      expect(claimed.map((c) => c.id)).not.toContain(id);
    });

    it('does not resurrect an already-completed row', async () => {
      const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtcancelterm' });
      const { id } = await seedEvent(manager);
      const token = randomUUID();
      await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 5, claimToken: token }));
      await withContext(manager, (m) => completeRealtimeEvent(m, id, token));
      await withContext(manager, (m) => cancelRealtimeEvent(m, id, 'irrelevant'));
      expect((await rowStatus(manager, id))?.status).toBe('completed'); // cancel never overwrites a terminal completed row
    });
  });

  describe('tenant isolation — Manager A cannot access Manager B\'s events', () => {
    it('org B\'s claim call never returns org A\'s pending row, even racing against it', async () => {
      const managerA = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtisoA' });
      const managerB = await factory.createInternalManager(await factory.createOrganisation(), { label: 'rtisoB' });
      const { id } = await seedEvent(managerA);

      const claimedByB = await withContext(managerB, (m) => claimRealtimeEvents(m, { limit: 10, claimToken: randomUUID() }));
      expect(claimedByB.map((c) => c.id)).not.toContain(id);

      // Org A can still claim its own row.
      const claimedByA = await withContext(managerA, (m) => claimRealtimeEvents(m, { limit: 10, claimToken: randomUUID() }));
      expect(claimedByA.map((c) => c.id)).toContain(id);
    });
  });
});
