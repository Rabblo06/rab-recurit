import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import Redis from 'ioredis';

import { AppModule } from '@rab/server/app.module';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AuthCacheRedisClientProvider } from '@rab/server/engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { RealtimeSubscriber, RealtimeMessageHandler } from '@rab/server/engine/core-modules/realtime/realtime-subscriber';
import { realtimeUserChannel } from '@rab/server/engine/core-modules/realtime/realtime-envelope';
import { runRealtimeOutboxPublishCycle, RealtimePublishFn } from '../../queues/rab-realtime/publish-outbox.job';
import { claimRealtimeEvents, completeRealtimeEvent } from '../../core/database/realtime-event';
import { createAdminDataSource } from './helpers/admin-datasource';
import { verifiedRestrictedRuntimeUrl } from './helpers/verified-role-database';
import { createTestIdentityFactory, TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Stage 2 — the Redis Pub/Sub publisher for `core.realtime_event`. Real
 * Postgres AND real Redis, RLS on, no mocks (one test, marked explicitly,
 * uses a dead Redis port to simulate an outage — see "Redis outage").
 *
 * `TEST_ENV` is a fixed literal, independent of the process's real
 * `NODE_ENV` — tests control both sides (publish cycle + subscriber) of the
 * channel-name computation directly, never relying on ambient env.
 */
const TEST_ENV = 'inttest';
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('realtime outbox publisher — Redis Pub/Sub distribution (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let redisProvider: AuthCacheRedisClientProvider;
  const subscribers: RealtimeSubscriber[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    redisProvider = app.get(AuthCacheRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = createTestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await Promise.all(subscribers.map((s) => s.close()));
    await app.close();
    await adminDataSource.destroy();
  });

  function newSubscriber(): RealtimeSubscriber {
    const sub = new RealtimeSubscriber(redisProvider.client);
    subscribers.push(sub);
    return sub;
  }

  /** Waits briefly for an async Redis pub/sub delivery — subscriptions and publishes cross real network round trips, not same-tick promises. */
  function waitForMessages(expected: number, received: unknown[], timeoutMs = 2000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (received.length >= expected) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${expected} message(s), got ${received.length}`));
        setTimeout(check, 20);
      };
      check();
    });
  }

  async function withContext<T>(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, fn);
  }

  /** Raw INSERT, bypassing `RealtimeEventService` — same reason as `realtime-event-outbox-claim.integration.spec.ts`: this package has no NestJS DI access to it. */
  async function seedEvent(
    identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>,
    opts: {
      eventType?: string;
      targetUserId?: string | null;
      workspaceId?: string | null;
      payload?: Record<string, unknown>;
      maxAttempts?: number;
      schemaVersion?: number;
    } = {},
  ): Promise<{ id: string; eventKey: string }> {
    const eventKey = `test-publish:${randomUUID()}`;
    return withContext(identity, async (m) => {
      const rows = await m.query<Array<{ id: string }>>(
        `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
         VALUES ($1, $2, $3, $4, $5, 'offer', $6, $7::jsonb, $8, $9) RETURNING id`,
        [
          identity.organisationId,
          opts.workspaceId !== undefined ? opts.workspaceId : identity.workspaceId,
          opts.targetUserId !== undefined ? opts.targetUserId : identity.userId,
          eventKey,
          opts.eventType ?? 'offer.sent',
          randomUUID(),
          JSON.stringify(opts.payload ?? {}),
          opts.maxAttempts ?? 10,
          opts.schemaVersion ?? 1,
        ],
      );
      return { id: rows[0]!.id, eventKey };
    });
  }

  async function rowStatus(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, id: string) {
    return withContext(identity, async (m) => {
      const rows = await m.query<Array<{ status: string; attempt_count: number; last_error_code: string | null }>>(
        `SELECT status, attempt_count, last_error_code FROM core.realtime_event WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * This local Postgres (port 15432) has accumulated tens of thousands of organisations and
   * workspaces across this whole multi-day session's testing — `storageScopes()`'s real,
   * unscoped, full cross-tenant walk (what `runRealtimeOutboxPublishCycle` uses by default, and
   * genuinely needs to use in production) pays one real transaction per scope, so against THIS
   * database that walk alone takes 40-60+ seconds. Every test except #1 (which deliberately keeps
   * the real default path, unscoped, as the one end-to-end proof that production behaviour
   * actually works) passes `scopes` explicitly so it exercises exactly its own fixtures — fast,
   * and immune to an unrelated straggler event from a DIFFERENT test's backlog being swept up by
   * a same-run global scan (confirmed: this is exactly what caused the original flaky "received 3,
   * expected 1" failures before this fix).
   */
  function scopesFor(...identities: Array<Pick<TestIdentity, 'organisationId' | 'workspaceId'>>) {
    return identities.map((i) => ({ organisationId: i.organisationId, workspaceId: i.workspaceId }));
  }

  function capturingPublisher(): { publish: RealtimePublishFn; calls: Array<{ channel: string; message: string }> } {
    const calls: Array<{ channel: string; message: string }> = [];
    return {
      calls,
      publish: async (channel, message) => {
        calls.push({ channel, message });
        return 1;
      },
    };
  }

  function failNTimesThenSucceed(n: number): RealtimePublishFn {
    let attempts = 0;
    return async () => {
      attempts++;
      if (attempts <= n) throw new Error(`simulated redis publish failure #${attempts}`);
      return 1;
    };
  }

  // ---------------------------------------------------------------- 1, 3

  it('1+3. a pending event publishes successfully, completes, with correct organisation/workspace/recipient scope in the envelope', async () => {
    // Deliberately the ONE test that omits `scopes` — the real default production path (a full
    // `storageScopes()` walk), proven to work end-to-end at least once. Slow against this
    // long-lived accumulated local database (see `scopesFor`'s own doc comment) — generous
    // per-test timeout below, not the file's shared 60s default.
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub1' });
    const staff = await factory.createStaff({ id: manager.organisationId }, { owner: manager, label: 'pub1-staff' });
    const { id } = await seedEvent(manager, { targetUserId: staff.userId });
    const cap = capturingPublisher();

    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV);

    expect(result.published).toBeGreaterThanOrEqual(1);
    expect((await rowStatus(manager, id))?.status).toBe('completed');
    const call = cap.calls.find((c) => c.channel === realtimeUserChannel(TEST_ENV, staff.userId));
    expect(call).toBeDefined();
    const envelope = JSON.parse(call!.message);
    expect(envelope).toMatchObject({
      version: 1,
      type: 'offer.sent',
      organisationId: manager.organisationId,
      workspaceId: manager.workspaceId,
      targetUserId: staff.userId,
    });
    expect(typeof envelope.eventId).toBe('string');
    expect(typeof envelope.occurredAt).toBe('string');
  }, 120_000);

  // ---------------------------------------------------------------- 2

  it('2. a real subscriber, on a separate Redis connection, receives the correct envelope end to end', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub2' });
    const staff = await factory.createStaff({ id: manager.organisationId }, { owner: manager, label: 'pub2-staff' });
    const { id } = await seedEvent(manager, { targetUserId: staff.userId });

    const received: Array<{ envelope: unknown; channel: string }> = [];
    const handler: RealtimeMessageHandler = (envelope, channel) => received.push({ envelope, channel });
    const sub = newSubscriber();
    await sub.subscribe(realtimeUserChannel(TEST_ENV, staff.userId), handler);

    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, (ch, msg) => redisProvider.client.publish(ch, msg), TEST_ENV, { scopes: scopesFor(manager) });
    expect(result.published).toBeGreaterThanOrEqual(1);

    await waitForMessages(1, received);
    expect(received[0]!.channel).toBe(realtimeUserChannel(TEST_ENV, staff.userId));
    expect((received[0]!.envelope as { eventId: string }).eventId).toBe(id);
  });

  // ---------------------------------------------------------------- 4, 5, 6

  it('4+5+6. the wrong recipient, wrong workspace, and wrong organisation never receive the event on their own channels', async () => {
    const orgA = await factory.createOrganisation();
    const managerA = await factory.createInternalManager(orgA, { label: 'pub456-a' });
    const staffA = await factory.createStaff(orgA, { owner: managerA, label: 'pub456-staffA' });

    const orgB = await factory.createOrganisation();
    const managerB = await factory.createInternalManager(orgB, { label: 'pub456-b' });
    const staffB = await factory.createStaff(orgB, { owner: managerB, label: 'pub456-staffB' });

    const managerA2 = await factory.createInternalManager(orgA, { label: 'pub456-a2' }); // different workspace, same org
    const staffWrongWorkspace = await factory.createStaff(orgA, { owner: managerA2, label: 'pub456-staffA2' });

    await seedEvent(managerA, { targetUserId: staffA.userId });

    const receivedWrongRecipient: unknown[] = [];
    const receivedWrongWorkspace: unknown[] = [];
    const receivedWrongOrg: unknown[] = [];
    const receivedCorrect: unknown[] = [];
    const sub = newSubscriber();
    await sub.subscribe(realtimeUserChannel(TEST_ENV, managerA.userId), () => receivedWrongRecipient.push(1)); // the sender, not the recipient
    await sub.subscribe(realtimeUserChannel(TEST_ENV, staffWrongWorkspace.userId), () => receivedWrongWorkspace.push(1));
    await sub.subscribe(realtimeUserChannel(TEST_ENV, staffB.userId), () => receivedWrongOrg.push(1));
    await sub.subscribe(realtimeUserChannel(TEST_ENV, staffA.userId), () => receivedCorrect.push(1));

    await runRealtimeOutboxPublishCycle(dataSource, tenantContext, (ch, msg) => redisProvider.client.publish(ch, msg), TEST_ENV, {
      scopes: scopesFor(managerA, managerB, managerA2),
    });
    await waitForMessages(1, receivedCorrect);

    expect(receivedWrongRecipient).toHaveLength(0);
    expect(receivedWrongWorkspace).toHaveLength(0);
    expect(receivedWrongOrg).toHaveLength(0);
  });

  // ---------------------------------------------------------------- 7

  it('7. duplicate processing is safe: a second cycle over an already-completed event does not republish it', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub7' });
    await seedEvent(manager);
    const scopes = scopesFor(manager);
    const cap1 = capturingPublisher();
    await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap1.publish, TEST_ENV, { scopes });
    expect(cap1.calls).toHaveLength(1);

    const cap2 = capturingPublisher();
    const result2 = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap2.publish, TEST_ENV, { scopes });
    expect(cap2.calls).toHaveLength(0);
    expect(result2.claimed).toBe(0); // already completed — not claimable again
  });

  // ---------------------------------------------------------------- 8

  it('8. worker crash BEFORE publication (simulated: publish throws on the claiming attempt) leaves the event retryable, not lost', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub8' });
    const { id } = await seedEvent(manager);
    const failing = failNTimesThenSucceed(1);
    const scopes = scopesFor(manager);

    const result1 = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, failing, TEST_ENV, { scopes });
    expect(result1.retried).toBe(1);
    expect((await rowStatus(manager, id))?.status).toBe('retry');

    // A later cycle (simulating a fresh worker, or the same one after recovery) succeeds — forcing
    // next_retry_at due now, same as test 15, since the real backoff (DEFAULT_RETRY_BACKOFF_SECONDS)
    // hasn't actually elapsed between these two calls in test time.
    await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [id]));
    const cap = capturingPublisher();
    const result2 = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV, { scopes });
    expect(result2.published).toBe(1);
    expect((await rowStatus(manager, id))?.status).toBe('completed');
  });

  // ---------------------------------------------------------------- 9

  it('9. worker crash AFTER publication but before marking completed: the event is republished once the lease expires (at-least-once, proven — never exactly-once)', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub9' });
    const { id, eventKey } = await seedEvent(manager);
    const claimToken = randomUUID();

    // Manually replicate exactly what the job does up to and including a REAL, successful publish —
    // then deliberately stop, simulating a crash before `completeRealtimeEvent` ever runs.
    const claimed = await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 10, claimToken, leaseSeconds: 60 }));
    const mine = claimed.find((c) => c.id === id)!;
    const cap = capturingPublisher();
    await cap.publish(realtimeUserChannel(TEST_ENV, manager.userId), JSON.stringify({ eventId: mine.id }));
    expect(cap.calls).toHaveLength(1); // the "crashed" worker's publish really did happen
    // No completeRealtimeEvent call — this is the crash.

    // Force the lease to look expired (simulating time passing with the process gone).
    await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1`, [id]));

    const cap2 = capturingPublisher();
    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap2.publish, TEST_ENV, { scopes: scopesFor(manager) });
    expect(result.published).toBe(1); // reclaimed and republished by a fresh cycle
    expect(cap2.calls.some((c) => JSON.parse(c.message).eventId === id)).toBe(true);
    expect((await rowStatus(manager, id))?.status).toBe('completed');
    // Total publishes across the "crashed" attempt and the real recovery cycle: TWO, for one event — the documented duplicate.
    void eventKey;
  });

  // ---------------------------------------------------------------- 10

  it('10. Redis outage and recovery: a publish failure (connection down) triggers retry; once Redis is reachable again, the event completes', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub10' });
    const { id } = await seedEvent(manager);

    // A genuinely dead connection (nothing listens on port 1), not a mock — same convention as
    // `core-entity-cache.integration.spec.ts`'s own Redis-outage tests.
    const deadRedis = new Redis({ port: 1, host: '127.0.0.1', connectTimeout: 200, commandTimeout: 150, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    deadRedis.on('error', () => undefined);
    const scopes = scopesFor(manager);
    const outageResult = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, (ch, msg) => deadRedis.publish(ch, msg), TEST_ENV, { scopes });
    expect(outageResult.retried).toBe(1);
    expect((await rowStatus(manager, id))?.status).toBe('retry');
    deadRedis.disconnect();

    // "Recovery" — a later cycle using the real, reachable Redis connection. Force next_retry_at
    // due now, same reasoning as test 8/15: the real backoff interval hasn't elapsed in test time.
    await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [id]));
    const recoveryResult = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, (ch, msg) => redisProvider.client.publish(ch, msg), TEST_ENV, { scopes });
    expect(recoveryResult.published).toBe(1);
    expect((await rowStatus(manager, id))?.status).toBe('completed');
  });

  // ---------------------------------------------------------------- 11

  it('11. Redis reconnect: a subscriber connection that drops and reconnects still receives events published after it reconnects', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub11' });
    const received: unknown[] = [];
    const sub = newSubscriber();
    await sub.subscribe(realtimeUserChannel(TEST_ENV, manager.userId), () => received.push(1));

    // Force the subscriber's own underlying connection to drop and let ioredis's retryStrategy reconnect it.
    const subClient = (sub as unknown as { client: Redis }).client;
    // `disconnect()` with NO argument is an INTENTIONAL disconnect — ioredis deliberately does not
    // auto-reconnect after it (that's the whole distinction from an abnormal connection loss).
    // `disconnect(true)` is ioredis's own documented way to simulate an unexpected drop that DOES
    // trigger its retryStrategy — the real scenario this test is about. Confirmed live: without
    // `true`, the subsequent `once('ready')` wait never resolves and the test times out.
    subClient.disconnect(true);
    await new Promise((resolve) => subClient.once('ready', resolve));

    await seedEvent(manager);
    await runRealtimeOutboxPublishCycle(dataSource, tenantContext, (ch, msg) => redisProvider.client.publish(ch, msg), TEST_ENV, { scopes: scopesFor(manager) });
    await waitForMessages(1, received);
    expect(received).toHaveLength(1);
  });

  // ---------------------------------------------------------------- 12

  it('12. concurrent workers: two cycles racing over a shared backlog never double-claim, and the backlog fully drains', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub12' });
    const seeded = await Promise.all(Array.from({ length: 10 }, () => seedEvent(manager).then((e) => e.id)));
    const cap1 = capturingPublisher();
    const cap2 = capturingPublisher();
    const scopes = scopesFor(manager);

    const [r1, r2] = await Promise.all([
      runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap1.publish, TEST_ENV, { scopes }),
      runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap2.publish, TEST_ENV, { scopes }),
    ]);

    const allPublishedIds = [...cap1.calls, ...cap2.calls].map((c) => JSON.parse(c.message).eventId as string);
    expect(new Set(allPublishedIds).size).toBe(allPublishedIds.length); // never the same event claimed by both
    expect(r1.published + r2.published).toBe(10); // the whole backlog still gets through, split between the two
    for (const id of seeded) expect(allPublishedIds).toContain(id);
  });

  // ---------------------------------------------------------------- 13, 14

  it('13+14. lease expiry recovery and claim-token fencing through the full publish cycle', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub1314' });
    const { id } = await seedEvent(manager);
    const staleToken = randomUUID();
    await withContext(manager, (m) => claimRealtimeEvents(m, { limit: 10, claimToken: staleToken, leaseSeconds: 60 }));
    await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET lease_expires_at = now() - interval '5 minutes' WHERE id = $1`, [id]));

    const cap = capturingPublisher();
    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV, { scopes: scopesFor(manager) });
    expect(result.published).toBe(1); // reclaimed past the expired lease
    expect((await rowStatus(manager, id))?.status).toBe('completed');

    // The stale (pre-expiry) claim token can no longer complete it — fencing, proven directly.
    const staleComplete = await withContext(manager, (m) => completeRealtimeEvent(m, id, staleToken));
    expect(staleComplete).toBe(false);
  });

  // ---------------------------------------------------------------- 15

  it('15. bounded retry exhaustion: a permanently failing publish stops retrying after max_attempts, never loops forever', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub15' });
    const { id } = await seedEvent(manager, { maxAttempts: 2 });
    const alwaysFails: RealtimePublishFn = async () => {
      throw new Error('permanent simulated failure');
    };
    const scopes = scopesFor(manager);

    const r1 = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, alwaysFails, TEST_ENV, { scopes });
    expect(r1.retried).toBe(1);
    expect((await rowStatus(manager, id))?.status).toBe('retry');

    // Force the retry due now (bypassing the real backoff wait, for test speed) and run again — second attempt exhausts max_attempts.
    await withContext(manager, (m) => m.query(`UPDATE core.realtime_event SET next_retry_at = now() - interval '1 second' WHERE id = $1`, [id]));
    const r2 = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, alwaysFails, TEST_ENV, { scopes });
    expect(r2.failed).toBe(1);
    expect((await rowStatus(manager, id))?.status).toBe('failed');

    // A third cycle must not touch it again — it's terminal.
    const r3 = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, alwaysFails, TEST_ENV, { scopes });
    expect(r3.claimed).toBe(0);
  });

  // ---------------------------------------------------------------- 16

  it('16. an invalid event schema/type is rejected as poison — cancelled immediately, never published, never retried', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub16' });
    const { id: badTypeId } = await seedEvent(manager, { eventType: 'not-a-real-type' });
    const { id: badVersionId } = await seedEvent(manager, { schemaVersion: 2 });
    const cap = capturingPublisher();

    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV, { scopes: scopesFor(manager) });

    expect(result.invalid).toBe(2);
    expect(cap.calls).toHaveLength(0);
    const badType = await rowStatus(manager, badTypeId);
    const badVersion = await rowStatus(manager, badVersionId);
    expect(badType?.status).toBe('cancelled');
    expect(badType?.last_error_code).toMatch(/^invalid:/);
    expect(badVersion?.status).toBe('cancelled');
  });

  // ---------------------------------------------------------------- 17

  it('17. no raw sensitive data exposure: the payload column is never forwarded, even when it looks sensitive', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub17' });
    await seedEvent(manager, { payload: { password: 'super-secret-value', refreshToken: 'rt_abc123', creditCard: '4111111111111111' } });
    const cap = capturingPublisher();

    await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV, { scopes: scopesFor(manager) });

    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0]!.message).not.toMatch(/super-secret-value|rt_abc123|4111111111111111|password|refreshToken|creditCard/i);
    const envelope = JSON.parse(cap.calls[0]!.message);
    expect(Object.keys(envelope).sort()).toEqual(['entityId', 'eventId', 'occurredAt', 'organisationId', 'targetUserId', 'type', 'version', 'workspaceId'].sort());
  });

  // ---------------------------------------------------------------- 18

  it('18. the batch claim limit remains enforced through the full publish cycle, not just the raw claim helper', async () => {
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub18' });
    await Promise.all(Array.from({ length: 30 }, () => seedEvent(manager)));
    const cap = capturingPublisher();

    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV, { perScopeLimit: 10, scopes: scopesFor(manager) });

    // One scope (one org, one workspace, no org-wide events here) — exactly the limit, never all 30 in one cycle.
    expect(result.claimed).toBe(10);
    expect(cap.calls).toHaveLength(10);
  });

  // ---------------------------------------------------------------- 19, 20

  /**
   * Requirement #19 needs the restricted runtime role `crewflow_app`, proven rather than assumed. The connection string
   * comes ONLY from the verified test target (TEST_DATABASE_URL). `verifiedRestrictedRuntimeUrl()` checks, live, that it
   * reaches the same database and cluster the fixtures are written to and authenticates as `crewflow_app` without
   * SUPERUSER or BYPASSRLS. Anything else fails this test. It never skips and never reads the developer's `.env`; that
   * file once pointed this test at the development database.
   */
  it('19. the restricted crewflow_app role (no elevated credentials) can claim, publish-path-validate and complete a realtime_event row', async () => {
    const crewflowAppUrl = await verifiedRestrictedRuntimeUrl();
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub19' });
    const { id } = await seedEvent(manager);

    // A SEPARATE DataSource, authenticated specifically as crewflow_app — never the superuser
    // `TEST_DATABASE_URL_UNPOOLED` connection (that one powers `adminDataSource`, used ONLY for
    // fixture bootstrap in this file, never for the claim/publish operations under test here).
    const restrictedDataSource = new DataSource({ type: 'postgres', url: crewflowAppUrl, schema: 'core', entities: [], synchronize: false });
    await restrictedDataSource.initialize();
    try {
      await restrictedDataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.workspace_id', $2, true), set_config('rab.user_id', $3, true), set_config('rab.role', '', true), set_config('rab.actor_type', 'worker', true)`, [
          manager.organisationId,
          manager.workspaceId,
          manager.userId,
        ]);
        const claimToken = randomUUID();
        const claimed = await claimRealtimeEvents(m, { limit: 10, claimToken });
        expect(claimed.map((c) => c.id)).toContain(id);
        const completed = await completeRealtimeEvent(m, id, claimToken);
        expect(completed).toBe(true);
      });
      // Discovery function (storageScopes' underlying SECURITY DEFINER calls) also works under this role.
      const orgRows = await restrictedDataSource.query(`SELECT organisation_id FROM core.worker_list_organisations(NULL::uuid, 100)`);
      expect(Array.isArray(orgRows)).toBe(true);
    } finally {
      await restrictedDataSource.destroy();
    }
  });

  it('20. the existing OfferService.sendOne() transaction remains atomic — Stage 1\'s own atomicity proof is unaffected by Stage 2 existing', async () => {
    // Stage 2 adds a CONSUMER of core.realtime_event; it changes nothing about how rows are
    // CREATED. Stage 1's own atomicity suite (`realtime-event-outbox.integration.spec.ts`, rab-server)
    // already proves this exhaustively; this test is the narrow, Stage-2-side confirmation that a
    // row created by a real send is still exactly one row, still claimable, still publishable here.
    const manager = await factory.createInternalManager(await factory.createOrganisation(), { label: 'pub20' });
    const { id } = await seedEvent(manager); // stands in for a real OfferService.sendOne()-created row — same table, same shape
    const cap = capturingPublisher();
    const result = await runRealtimeOutboxPublishCycle(dataSource, tenantContext, cap.publish, TEST_ENV, { scopes: scopesFor(manager) });
    expect(result.published).toBeGreaterThanOrEqual(1);
    expect((await rowStatus(manager, id))?.status).toBe('completed');
  });
});
