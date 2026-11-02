import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { createPgDataSource, resolvePgEnvironment } from '@rab/server/database/postgres/index';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { SmtpDriver } from '@rab/server/engine/core-modules/email/drivers/smtp.driver';
import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EmailQueueService } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PushSendError } from '@rab/server/engine/core-modules/push/drivers/interfaces/push-driver.interface';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushQueueJobData } from '@rab/server/engine/core-modules/push/push-queue.constants';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { SchemaResolverService } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '@rab/server/engine/utils/assert-runtime-db-role';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { claimDispatchPointers, DispatchClaim, DispatchQueue, releaseDispatchClaim } from '../../core/database/dispatch-claims';
import { claimRealtimeEvents, completeRealtimeEvent, markRealtimeEventRetry } from '../../core/database/realtime-event';
import { ReconnectingPgClient } from '../../core/database/reconnecting-pg-client';
import { DispatchCoordinator } from '../../core/wake/dispatch-coordinator';
import { DispatchWakeListener } from '../../core/wake/dispatch-listener';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { dispatchEmailScope, runEmailDispatchCycle } from '../../queues/rab-email/email-dispatch.job';
import { createPushSendProcessor } from '../../queues/rab-push/push-send.processor';
import { dispatchPushScope } from '../../queues/rab-push/push-dispatch.job';
import { publishRealtimeScope } from '../../queues/rab-realtime/publish-outbox.job';
import { dispatchStatementScope, processShiftStatementJob } from '../../queues/rab-reports/shift-statement.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase D wave 4 — two-Worker concurrency and failure tests (owner §10), against the REAL Phase D SQL on rab_c1e and the
 * suite's own Redis (16402).
 *
 * HARNESS: two Worker RUNTIMES in ONE test process — Worker A and Worker B each own a separate `crewflow_worker` pool
 * (separate PostgreSQL sessions, separate claim tokens), and a "crash" is a pool destroyed mid-batch with nothing released
 * (the PostgreSQL view of a killed process: its sessions vanish, its leases stay). Scoped processing uses the app's
 * TenantContextService (crewflow_app; crewflow_worker inherits exactly those rights). Not two OS processes.
 *
 * DELIVERY SEMANTICS (never claimed exactly-once): pointer claims and row claims are exclusive (one valid owner at a time)
 * and business effects are fenced by tokens / CAS, so no claim race produces a duplicate business effect. Provider
 * delivery is AT-LEAST-ONCE where a retry after an ambiguous provider outcome is allowed (SMTP: a timeout after DATA is
 * retried → possibly a second copy; realtime: a PUBLISH whose ack is lost is retried) and AT-MOST-ONCE where it is not
 * (push: an interrupted provider call becomes DELIVERY_UNCERTAIN, never resent). BullMQ jobIds dedupe re-publishes.
 *
 * GATED: PHASE_D_SQL_APPROVED=true + TEST_DATABASE_WORKER_URL; the admin connection must be the cluster superuser (asserted).
 * The Redis-outage case stops/starts the container named in PHASE_D_REDIS_CONTAINER (only `crewflow-c1-redis-c1e`).
 * Measured times are printed as `[w4-measure]` lines.
 */
const WORKER_URL = process.env.TEST_DATABASE_WORKER_URL;
const APP_URL = process.env.TEST_DATABASE_URL;
const RUN = process.env.PHASE_D_SQL_APPROVED === 'true' && Boolean(WORKER_URL && APP_URL && process.env.DATABASE_URL);
const REDIS_CONTAINER = process.env.PHASE_D_REDIS_CONTAINER;
const describeIfApproved = RUN ? describe : describe.skip;
const TEST_ENV = 'inttest';
jest.setTimeout(420_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const measure = (name: string, ms: number, extra: Record<string, unknown> = {}) =>
  // eslint-disable-next-line no-console
  console.log(`[w4-measure] ${JSON.stringify({ name, ms, ...extra })}`);

describeIfApproved('Phase D two-Worker concurrency and failure (integration — gated)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let admin: DataSource;
  let workerA: DataSource;
  let workerB: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let orgs: TestIdentity[];

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const workerDs = (name: string) =>
    new DataSource({ type: 'postgres', url: WORKER_URL, entities: [], synchronize: false, extra: { max: 3, application_name: `crewflow-worker-it-${name}` } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    admin = createAdminDataSource();
    await admin.initialize();
    const [{ rolsuper }] = await admin.query<[{ rolsuper: boolean }]>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    expect(rolsuper).toBe(true);
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: admin, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    workerA = workerDs('a');
    workerB = workerDs('b');
    await Promise.all([workerA.initialize(), workerB.initialize()]);
    for (const w of [workerA, workerB]) expect((await w.query<[{ u: string }]>('SELECT current_user AS u'))[0].u).toBe('crewflow_worker');
    orgs = [];
    for (let i = 0; i < 3; i += 1) orgs.push(await factory.createInternalManager(await factory.createOrganisation(`w4-${i}`), { label: `w4-${i}` }));
  });

  afterAll(async () => {
    await Promise.allSettled([workerA?.destroy(), workerB?.destroy()]);
    await app?.close();
    await admin?.destroy();
  });

  // ── fixtures and oracles ─────────────────────────────────────────────────────────────────────────────────────────
  const ctxOf = (o: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>, workspace = true) => ({
    organisationId: o.organisationId,
    workspaceId: workspace ? o.workspaceId : null,
    userId: o.userId,
    role: '',
  });

  async function seedRealtime(o: TestIdentity, target = o.userId): Promise<string> {
    return tenantContext.runInTenantContext(ctxOf(o), async (m) =>
      (
        await m.query<Array<{ id: string }>>(
          `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
           VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, 10, 1) RETURNING id`,
          [o.organisationId, o.workspaceId, target, `w4:${randomUUID()}`, randomUUID()],
        )
      )[0]!.id,
    );
  }

  async function seedEmail(o: TestIdentity): Promise<string> {
    const id = randomUUID();
    // target_user_id set, as every real NOTIFICATION row has it (the send processor cancels a row without one — fail closed).
    await tenantContext.runInTenantContext(ctxOf(o, false), (m) =>
      m.query(
        `INSERT INTO core.email_outbox (id, organisation_id, job_type, status, target_user_id, recipient_email, rendered_subject, rendered_html, rendered_text)
         VALUES ($1, $2, 'NOTIFICATION', 'PENDING', $3, 'w4@example.test', 'Subject', '<p>body</p>', 'body')`,
        [id, o.organisationId, o.userId],
      ),
    );
    return id;
  }

  async function seedPush(o: TestIdentity): Promise<string> {
    const notificationId = randomUUID();
    const deviceId = randomUUID();
    const id = randomUUID();
    const token = app.get(SecretEncryptionService).encrypt(`w4-device-token-${randomUUID()}`);
    await admin.query(`INSERT INTO core.notification (id, organisation_id, user_id, type, title, message) VALUES ($1, $2, $3, 'TEST', 't', 'm')`, [notificationId, o.organisationId, o.userId]);
    await admin.query(`INSERT INTO core.push_device (id, organisation_id, user_id, device_id, platform, push_token_encrypted) VALUES ($1, $2, $3, $4, 'ios', $5)`, [
      deviceId, o.organisationId, o.userId, `w4-${deviceId}`, token,
    ]);
    await admin.query(`INSERT INTO core.push_delivery (id, organisation_id, notification_id, push_device_id, status) VALUES ($1, $2, $3, $4, 'PENDING')`, [id, o.organisationId, notificationId, deviceId]);
    return id;
  }

  const pointer = async (subject: string) =>
    (await admin.query<Array<{ claim_token: string | null; claim_count: number; due_at: Date }>>(
      'SELECT claim_token, claim_count, due_at FROM core.worker_dispatch_pointer WHERE subject_id = $1',
      [subject],
    ))[0] ?? null;
  const row = async (table: string, id: string) => (await admin.query(`SELECT * FROM core.${table} WHERE id = $1`, [id]))[0];

  /**
   * Claims (as `worker`) until every wanted subject was seen or a claim call returns nothing. A SHORT batch does not stop
   * it: the server's per-organisation cap (realtime 25, email/push/statement 10 per call) makes batches short while more
   * is due. Returns only OUR claims (other suites' due pointers that come back are simply left leased).
   */
  async function claimOurs(worker: DataSource, queue: DispatchQueue, wanted: readonly string[], batch = 200, rounds = 30): Promise<DispatchClaim[]> {
    const want = new Set(wanted);
    const got: DispatchClaim[] = [];
    for (let i = 0; i < rounds && got.length < want.size; i += 1) {
      const claims = await claimDispatchPointers(worker, queue, batch);
      got.push(...claims.filter((c) => want.has(c.subjectId)));
      if (claims.length === 0) break;
    }
    return got;
  }

  function realtimeCapture() {
    const byEvent = new Map<string, number>();
    const envelopes: Array<Record<string, unknown>> = [];
    return {
      byEvent,
      envelopes,
      publish: async (_channel: string, message: string) => {
        const envelope = JSON.parse(message) as Record<string, unknown> & { eventId: string };
        envelopes.push(envelope);
        byEvent.set(envelope.eventId, (byEvent.get(envelope.eventId) ?? 0) + 1);
        return 1;
      },
    };
  }

  // ── 1 + 13: simultaneous global claims; several organisations share the queue ─────────────────────────────────────
  it('1/13. simultaneous claims by two Workers never hand one pointer to both; every event of 3 organisations is published once', async () => {
    const ids: string[] = [];
    const orgOf = new Map<string, string>();
    for (const o of orgs) for (let i = 0; i < 30; i += 1) {
      const id = await seedRealtime(o);
      ids.push(id);
      orgOf.set(id, o.organisationId);
    }
    // One claim call returns at most 25 pointers per organisation (server per-org cap — fairness across tenants).
    const t0 = Date.now();
    const [a, b] = await Promise.all([claimOurs(workerA, 'realtime', ids, 50), claimOurs(workerB, 'realtime', ids, 50)]);
    measure('simultaneous-claim-90-pointers', Date.now() - t0, { a: a.length, b: b.length });
    const aSet = new Set(a.map((c) => c.subjectId));
    for (const c of b) expect(aSet.has(c.subjectId)).toBe(false); // disjoint: no simultaneous ownership
    expect(new Set([...a, ...b].map((c) => c.subjectId))).toEqual(new Set(ids));
    // The pointer's stored token is exactly its one owner's token.
    for (const c of [...a, ...b]) expect((await pointer(c.subjectId))!.claim_token).toBe(c.claimToken);
    // Every claim carries its own organisation (routing ids only) — never another tenant's.
    for (const c of [...a, ...b]) expect(c.organisationId).toBe(orgOf.get(c.subjectId));

    const cap = realtimeCapture();
    const processAll = async (claims: DispatchClaim[]) => {
      const byScope = new Map<string, DispatchClaim[]>();
      for (const c of claims) byScope.set(`${c.organisationId}|${c.workspaceId}`, [...(byScope.get(`${c.organisationId}|${c.workspaceId}`) ?? []), c]);
      for (const group of byScope.values()) {
        await publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, { organisationId: group[0]!.organisationId, workspaceId: group[0]!.workspaceId }, { ids: group.map((c) => c.subjectId) });
      }
    };
    await Promise.all([processAll(a), processAll(b), processAll([...a, ...b])]); // a third, racing processor on the same ids
    for (const id of ids) expect(cap.byEvent.get(id)).toBe(1);
    for (const e of cap.envelopes) if (orgOf.has(e.eventId as string)) expect(e.organisationId).toBe(orgOf.get(e.eventId as string));
    for (const id of ids) expect(await pointer(id)).toBeNull(); // completed → trigger deleted the pointer
  });

  // ── 2 + 11: competing claims across lease expiry; stale claim-token release and completion ─────────────────────────
  it('2/11. after the 15 s lease expires Worker B re-claims; Worker A\'s stale token can neither release B\'s claim nor complete the row twice', async () => {
    const id = await seedRealtime(orgs[0]!);
    const [ca] = await claimOurs(workerA, 'realtime', [id]);
    expect(ca).toBeDefined();
    expect(await claimOurs(workerB, 'realtime', [id])).toEqual([]); // leased to A
    const claimedAt = Date.now();
    let cb: DispatchClaim | undefined;
    while (!cb && Date.now() - claimedAt < 30_000) {
      await sleep(1_000);
      [cb] = await claimOurs(workerB, 'realtime', [id]);
    }
    expect(cb).toBeDefined();
    measure('realtime-lease-reclaim', Date.now() - claimedAt, { leaseSeconds: 15 });
    expect(Date.now() - claimedAt).toBeGreaterThanOrEqual(14_000);
    expect(cb!.claimToken).not.toBe(ca!.claimToken);
    expect(cb!.claimCount).toBe(2);
    // A's stale token: release refused, and B's claim is untouched.
    expect(await releaseDispatchClaim(workerA, 'realtime', id, ca!.claimToken, 1)).toBe(false);
    expect((await pointer(id))!.claim_token).toBe(cb!.claimToken);
    // Both Workers now process the same id at once (A is late): exactly one PUBLISH.
    const cap = realtimeCapture();
    const scope = { organisationId: orgs[0]!.organisationId, workspaceId: orgs[0]!.workspaceId };
    await Promise.all([
      publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, scope, { ids: [id] }),
      publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, scope, { ids: [id] }),
    ]);
    expect(cap.byEvent.get(id)).toBe(1);
    expect(await releaseDispatchClaim(workerB, 'realtime', id, cb!.claimToken, 1)).toBe(false); // terminal → pointer gone

    // Row-level fence: a row claim whose lease expired and was re-claimed cannot be completed or retried by the old token.
    const y = await seedRealtime(orgs[0]!);
    const t1 = randomUUID();
    const t2 = randomUUID();
    await tenantContext.runInTenantContext(ctxOf(orgs[0]!), (m) => claimRealtimeEvents(m, { limit: 1, claimToken: t1, leaseSeconds: 1, ids: [y] }));
    await sleep(1_500);
    const re = await tenantContext.runInTenantContext(ctxOf(orgs[0]!), (m) => claimRealtimeEvents(m, { limit: 1, claimToken: t2, leaseSeconds: 60, ids: [y] }));
    expect(re.map((e) => e.id)).toEqual([y]);
    await tenantContext.runInTenantContext(ctxOf(orgs[0]!), async (m) => {
      expect(await completeRealtimeEvent(m, y, t1)).toBe(false);
      expect(await markRealtimeEventRetry(m, y, t1, 'STALE', 15)).toBe('lost_lease');
      expect(await completeRealtimeEvent(m, y, t2)).toBe(true);
    });
  });

  // ── 3: crash mid-batch, then recovery by the other Worker (lease) and by a restarted Worker (first-tick sweep) ─────
  it('3. a Worker that crashes mid-batch loses nothing: the survivor re-claims after the 30 s lease; a restarted Worker sweeps at once', async () => {
    const o = orgs[1]!;
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(await seedEmail(o));
    const crashing = workerDs('crash');
    await crashing.initialize();
    const published = new Map<string, number>();
    const publish = async (id: string) => void published.set(id, (published.get(id) ?? 0) + 1);
    const noRepublish = async () => undefined;
    const claims = await claimOurs(crashing, 'email', ids);
    expect(claims).toHaveLength(10);
    const crashedAt = Date.now();
    await dispatchEmailScope(tenantContext, o.organisationId, claims.slice(0, 3).map((c) => c.subjectId), publish, noRepublish, true);
    await crashing.destroy(); // crash: nothing released
    const rest = claims.slice(3).map((c) => c.subjectId);
    // Survivor (global claim only): nothing until the 30 s lease passes, then all 7.
    let recovered: DispatchClaim[] = [];
    while (recovered.length < 7 && Date.now() - crashedAt < 60_000) {
      recovered = [...recovered, ...(await claimOurs(workerB, 'email', rest.filter((r) => !recovered.some((c) => c.subjectId === r))))];
      if (recovered.length < 7) await sleep(2_000);
    }
    const leaseRecoveryMs = Date.now() - crashedAt;
    measure('email-crash-lease-recovery', leaseRecoveryMs, { leaseSeconds: 30 });
    expect(leaseRecoveryMs).toBeGreaterThanOrEqual(28_000);
    expect(new Set(recovered.map((c) => c.subjectId))).toEqual(new Set(rest));
    expect(recovered.every((c) => c.claimCount === 2)).toBe(true);
    await dispatchEmailScope(tenantContext, o.organisationId, rest, publish, noRepublish, true);
    for (const id of ids) expect(published.get(id)).toBe(1); // no duplicate, nothing lost
    for (const id of ids) expect((await row('email_outbox', id)).status).toBe('QUEUED');

    // Restart path: crash again, then a fresh coordinator's FIRST tick (the legacy sweep) dispatches at once.
    const ids2: string[] = [];
    for (let i = 0; i < 5; i += 1) ids2.push(await seedEmail(o));
    const crashing2 = workerDs('crash2');
    await crashing2.initialize();
    expect(await claimOurs(crashing2, 'email', ids2)).toHaveLength(5);
    await crashing2.destroy();
    const restartedAt = Date.now();
    const restarted = new DispatchCoordinator(
      [{
        queue: 'email',
        legacy: async () => (await runEmailDispatchCycle(workerA, tenantContext, publish, noRepublish, true)).claimed > 0,
        processScope: async (s) => (await dispatchEmailScope(tenantContext, s.organisationId, s.subjectIds, publish, noRepublish, true)).claimed,
      }],
      { claimer: workerA, batch: 100, reconcileMs: 900_000, logger: { log: () => undefined, warn: () => undefined } },
    );
    await restarted.tick('email');
    measure('email-crash-restart-recovery', Date.now() - restartedAt);
    for (const id of ids2) expect(published.get(id)).toBe(1);
  });

  // ── 4: Redis outage after the PostgreSQL commit ──────────────────────────────────────────────────────────────────
  const redisIt = REDIS_CONTAINER === 'crewflow-c1-redis-c1e' ? it : it.skip;
  redisIt('4. Redis down after the claim commits: the row stays durably QUEUED, and is republished under a new jobId within the 2-min QUEUED recovery after Redis returns', async () => {
    const o = orgs[2]!;
    const emailQueue = app.get(EmailQueueService);
    const queue = (emailQueue as unknown as { queue: import('bullmq').Queue }).queue;
    const ids = [await seedEmail(o), await seedEmail(o)];
    const claims = await claimOurs(workerA, 'email', ids);
    expect(claims).toHaveLength(2);
    execFileSync('docker', ['stop', REDIS_CONTAINER!], { stdio: 'ignore' });
    const downAt = Date.now();
    try {
      const r = await dispatchEmailScope(tenantContext, o.organisationId, ids, (id, org) => emailQueue.publish(id, org), (id, org, g) => emailQueue.republish(id, org, g), true);
      expect(r).toMatchObject({ claimed: 2, published: 0 }); // committed QUEUED, publish failed fast (bounded producer)
      measure('publish-fail-fast-redis-down', Date.now() - downAt);
    } finally {
      execFileSync('docker', ['start', REDIS_CONTAINER!], { stdio: 'ignore' });
    }
    for (const id of ids) expect((await row('email_outbox', id)).status).toBe('QUEUED'); // durable
    const committedAt = Date.now();
    // Recovery = the QUEUED row's 2-min staleness, found through its pointer (no time shift).
    const done = new Set<string>();
    while (done.size < 2 && Date.now() - committedAt < 200_000) {
      await sleep(5_000);
      const got = await claimOurs(workerB, 'email', ids.filter((id) => !done.has(id)));
      if (got.length) {
        await dispatchEmailScope(tenantContext, o.organisationId, got.map((c) => c.subjectId), (id, org) => emailQueue.publish(id, org), (id, org, g) => emailQueue.republish(id, org, g), true);
      }
      for (const id of ids) if ((await queue.getJob(`email-outbox.${id}.attempt.1`)) !== undefined) done.add(id);
    }
    measure('redis-outage-recovery', Date.now() - committedAt, { documentedBoundMs: 120_000 + 30_000 });
    for (const id of ids) {
      expect(await queue.getJob(`email-outbox.${id}.attempt.0`)).toBeUndefined(); // never published while Redis was down
      expect(await queue.getJob(`email-outbox.${id}.attempt.1`)).toBeDefined(); // exactly one job, generation 1
      expect(Number((await row('email_outbox', id)).dispatch_generation)).toBe(1);
      await queue.remove(`email-outbox.${id}.attempt.1`);
    }
  });

  // ── 5: BullMQ jobId dedup ──────────────────────────────────────────────────────────────────────────────────────
  it('5. two Workers publishing the same outbox row at once create ONE BullMQ job (jobId dedupe)', async () => {
    const emailQueue = app.get(EmailQueueService);
    const queue = (emailQueue as unknown as { queue: import('bullmq').Queue }).queue;
    const id = randomUUID();
    const before = await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized');
    await Promise.all([1, 2, 3, 4].map(() => emailQueue.publish(id, orgs[0]!.organisationId)));
    const job = await queue.getJob(`email-outbox.${id}.attempt.0`);
    expect(job).toBeDefined();
    expect(await queue.getJobCountByTypes('waiting', 'delayed', 'prioritized')).toBe(before + 1);
    await queue.remove(`email-outbox.${id}.attempt.0`);
  });

  // ── 6 + 7: lost NOTIFY (backstop) and listener reconnect after pg_terminate_backend ────────────────────────────────
  it('6. a lost NOTIFY delays the work by at most one backstop tick (10 s here), never loses it', async () => {
    const env = resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: APP_URL, WORKER_DISPATCH_MODE: 'event' }, { processRole: 'api', enforceProcessPolicy: false });
    const apiEvent = createPgDataSource(env, { purpose: 'runtime', max: 1 }, { name: `w4-event-${Date.now()}`, entities: [] });
    await apiEvent.initialize();
    const cap = realtimeCapture();
    const coordinator = new DispatchCoordinator(
      [{
        queue: 'realtime',
        legacy: async () => false,
        processScope: async (s) => (await publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, s, { ids: s.subjectIds })).claimed,
      }],
      { claimer: workerA, batch: 100, reconcileMs: 900_000, logger: { log: () => undefined, warn: () => undefined } },
    );
    await coordinator.tick('realtime'); // started; its sweep is done
    const listener = new PgClient({ connectionString: APP_URL, application_name: 'w4-lost-notify' });
    await listener.connect();
    let heard = 0;
    listener.on('notification', () => (heard += 1)); // heard — and deliberately DROPPED (not forwarded to the coordinator)
    await listener.query('LISTEN crewflow_worker_wake');
    try {
      const eventTenant = new TenantContextService(apiEvent, app.get(SchemaResolverService), app.get(EnvironmentService));
      const id = await seedRealtimeVia(eventTenant, orgs[0]!);
      const writtenAt = Date.now();
      for (let i = 0; i < 20 && heard === 0; i += 1) await sleep(50);
      expect(heard).toBeGreaterThan(0); // the hint was sent ... and lost
      const backstop = setInterval(() => void coordinator.tick('realtime'), 10_000);
      try {
        while (!cap.byEvent.has(id) && Date.now() - writtenAt < 25_000) await sleep(250);
      } finally {
        clearInterval(backstop);
      }
      measure('lost-notify-backstop-recovery', Date.now() - writtenAt, { backstopSeconds: 10 });
      expect(cap.byEvent.get(id)).toBe(1);
      expect(Date.now() - writtenAt).toBeLessThanOrEqual(12_000);
    } finally {
      await coordinator.idle();
      await listener.end();
      await apiEvent.destroy();
    }
  });

  async function seedRealtimeVia(t: TenantContextService, o: TestIdentity): Promise<string> {
    return t.runInTenantContext(ctxOf(o), async (m) =>
      (
        await m.query<Array<{ id: string }>>(
          `INSERT INTO core.realtime_event (organisation_id, workspace_id, target_user_id, event_key, event_type, entity_type, entity_id, payload, max_attempts, schema_version)
           VALUES ($1, $2, $3, $4, 'offer.sent', 'offer', $5, '{}'::jsonb, 10, 1) RETURNING id`,
          [o.organisationId, o.workspaceId, o.userId, `w4:${randomUUID()}`, randomUUID()],
        )
      )[0]!.id,
    );
  }

  it('7. the wake listener survives pg_terminate_backend: it reconnects, re-verifies its identity, re-LISTENs, catches up and hears the next NOTIFY', async () => {
    const env = resolvePgEnvironment({ NODE_ENV: 'test', PG_DATABASE_URL: APP_URL, WORKER_DISPATCH_MODE: 'event' }, { processRole: 'api', enforceProcessPolicy: false });
    const apiEvent = createPgDataSource(env, { purpose: 'runtime', max: 1 }, { name: `w4-event2-${Date.now()}`, entities: [] });
    await apiEvent.initialize();
    const connection = new ReconnectingPgClient(
      { connectionString: WORKER_URL, application_name: 'crewflow-it-wake-listener', keepAlive: true },
      { label: 'wake-listener-it', logger: { log: () => undefined, warn: () => undefined }, initialBackoffMs: 500, maxBackoffMs: 2_000 },
    );
    const wakes: string[] = [];
    const connectedAt: number[] = [];
    const listener = new DispatchWakeListener(connection, {
      onWake: (q) => wakes.push(q),
      onConnected: () => connectedAt.push(Date.now()),
      verifyIdentity: async (client) => {
        const shim = { query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows } as unknown as DataSource;
        await assertRuntimeDbRole(shim, 'worker-wake-listener');
      },
      logger: { log: () => undefined, warn: () => undefined },
      ensureIntervalMs: 500,
    });
    await listener.start();
    try {
      expect(connectedAt).toHaveLength(1);
      const [{ pid }] = await admin.query<[{ pid: number }]>(`SELECT pid FROM pg_stat_activity WHERE application_name = 'crewflow-it-wake-listener' AND datname = current_database()`);
      const killedAt = Date.now();
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
      while (connectedAt.length < 2 && Date.now() - killedAt < 15_000) await sleep(100);
      expect(connectedAt).toHaveLength(2); // re-LISTEN + catch-up (onConnected → wakeAll in main.ts)
      measure('listener-reconnect', connectedAt[1]! - killedAt);
      const [{ pid: newPid }] = await admin.query<[{ pid: number }]>(`SELECT pid FROM pg_stat_activity WHERE application_name = 'crewflow-it-wake-listener' AND datname = current_database()`);
      expect(newPid).not.toBe(pid);
      const eventTenant = new TenantContextService(apiEvent, app.get(SchemaResolverService), app.get(EnvironmentService));
      await seedRealtimeVia(eventTenant, orgs[0]!);
      for (let i = 0; i < 40 && !wakes.includes('realtime'); i += 1) await sleep(50);
      expect(wakes).toContain('realtime');
    } finally {
      await listener.stop();
      await apiEvent.destroy();
    }
  });

  // ── 8: SMTP timeout (local stub server) ────────────────────────────────────────────────────────────────────────
  function fakeSmtp(mode: 'silent' | 'hang-after-data') {
    let dataCommands = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      if (mode === 'silent') return; // accepts the TCP connection, never greets
      socket.write('220 w4.test ESMTP\r\n');
      let inData = false;
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (inData) {
          if (buffer.includes('\r\n.\r\n')) dataCommands += 1; // message fully received — and never acknowledged
          return;
        }
        let nl: number;
        while ((nl = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, nl).toUpperCase();
          buffer = buffer.slice(nl + 2);
          if (line.startsWith('EHLO') || line.startsWith('HELO')) socket.write('250 w4.test\r\n');
          else if (line.startsWith('MAIL') || line.startsWith('RCPT')) socket.write('250 OK\r\n');
          else if (line.startsWith('DATA')) {
            inData = true;
            socket.write('354 go ahead\r\n');
            return;
          } else if (line.startsWith('QUIT')) socket.end('221 bye\r\n');
          else socket.write('250 OK\r\n');
        }
      });
    });
    return new Promise<{ port: number; received: () => number; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as net.AddressInfo).port;
        resolve({
          port,
          received: () => dataCommands,
          close: () => new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
        });
      });
    });
  }

  it('8a. SMTP timeouts are bounded (no greeting / no reply after DATA): the row goes RETRY, never stuck; after DATA this is AT-LEAST-ONCE (a retry may send a second copy)', async () => {
    const o = orgs[0]!;
    for (const mode of ['silent', 'hang-after-data'] as const) {
      const smtp = await fakeSmtp(mode);
      try {
        const driver = new SmtpDriver({ host: '127.0.0.1', port: smtp.port, ignoreTLS: true }, { connectionTimeoutMs: 500, greetingTimeoutMs: 500, socketTimeoutMs: 1_000, sendDeadlineMs: 2_000 });
        const emailService = { send: (opts: Parameters<EmailService['send']>[0]) => driver.send({ ...opts, from: 'noreply@w4.test' }), ambiguousDeliverySafeToRetry: false } as unknown as EmailService;
        const processor = createEmailSendProcessor({ tenantContext, emailService, auditService: app.get(AuditService) });
        const id = await seedEmail(o);
        await dispatchEmailScope(tenantContext, o.organisationId, [id], async () => undefined, async () => undefined, true); // → QUEUED
        const started = Date.now();
        await expect(processor({ data: { emailOutboxId: id, organisationId: o.organisationId }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<EmailQueueJobData>)).rejects.toBeDefined();
        const elapsed = Date.now() - started;
        measure(`smtp-timeout-${mode}`, elapsed, { serverReceivedMessages: smtp.received() });
        expect(elapsed).toBeLessThan(5_000);
        const r = await row('email_outbox', id);
        expect(r.status).toBe('RETRY'); // durable, retried later — not lost, not stuck PROCESSING
        if (mode === 'hang-after-data') expect(smtp.received()).toBe(1); // the server HAS the message: a retry can duplicate it
      } finally {
        await smtp.close();
      }
    }
  });

  // ── 8b: push provider timeout (stub driver) ────────────────────────────────────────────────────────────────────
  it('8b. push provider timeout → RETRY; a provider call that never returns → DELIVERY_UNCERTAIN on recovery, never resent (at-most-once); its late answer cannot overwrite', async () => {
    const o = orgs[1]!;
    const deps = (send: PushService['send']) => ({
      tenantContext,
      pushService: { send, ambiguousDeliverySafeToRetry: false } as unknown as PushService,
      secretEncryption: app.get(SecretEncryptionService),
      pushDeviceService: app.get(PushDeviceService),
    });
    const job = (id: string) => ({ data: { pushDeliveryId: id, organisationId: o.organisationId }, attemptsMade: 0, opts: { attempts: 5 } }) as unknown as Job<PushQueueJobData>;

    const timedOut = await seedPush(o);
    const timeoutStub = (async () => {
      await sleep(300);
      throw new PushSendError('provider request timed out', true);
    }) as unknown as PushService['send'];
    await expect(createPushSendProcessor(deps(timeoutStub))(job(timedOut))).rejects.toBeDefined();
    expect((await row('push_delivery', timedOut)).status).toBe('RETRY');

    const hanging = await seedPush(o);
    let answer!: (v: unknown) => void;
    const hangStub = (() => new Promise((resolve) => (answer = resolve))) as unknown as PushService['send'];
    const inFlight = createPushSendProcessor(deps(hangStub))(job(hanging));
    for (let i = 0; i < 50 && (await row('push_delivery', hanging)).provider_call_started_at === null; i += 1) await sleep(100);
    expect((await row('push_delivery', hanging)).status).toBe('PROCESSING');
    // The provider never answers: after the 10-min PROCESSING lease (time-shifted here) recovery must NOT resend.
    await admin.query(`UPDATE core.push_delivery SET processing_at = now() - interval '11 minutes' WHERE id = $1`, [hanging]);
    const republished: string[] = [];
    await dispatchPushScope(tenantContext, o.organisationId, [hanging], async (id) => void republished.push(id), async (id) => void republished.push(id), false);
    const recovered = await row('push_delivery', hanging);
    expect(recovered.status).toBe('FAILED');
    expect(recovered.last_error_code).toBe('DELIVERY_UNCERTAIN');
    expect(republished).toEqual([]);
    answer({ provider: 'stub', providerMessageId: 'late' }); // the late "accepted" is fenced by the old processing token
    await inFlight.catch(() => undefined);
    expect((await row('push_delivery', hanging)).status).toBe('FAILED');
  });

  // ── 9: realtime delivery retry ─────────────────────────────────────────────────────────────────────────────────
  it('9. a failed realtime PUBLISH is retried after its 15 s backoff through its re-timed pointer, and is then published once', async () => {
    const o = orgs[2]!;
    const id = await seedRealtime(o);
    const scope = { organisationId: o.organisationId, workspaceId: o.workspaceId };
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('connection is closed'), { name: 'ConnectionError' });
      return 1;
    };
    const [c1] = await claimOurs(workerA, 'realtime', [id]);
    expect(c1).toBeDefined();
    const failedAt = Date.now();
    expect(await publishRealtimeScope(tenantContext, flaky, TEST_ENV, scope, { ids: [id] })).toMatchObject({ retried: 1 });
    expect((await row('realtime_event', id)).status).toBe('retry');
    let c2: DispatchClaim | undefined;
    while (!c2 && Date.now() - failedAt < 30_000) {
      await sleep(1_000);
      [c2] = await claimOurs(workerB, 'realtime', [id]);
    }
    measure('realtime-retry-reclaim', Date.now() - failedAt, { backoffSeconds: 15 });
    expect(c2).toBeDefined();
    expect(await publishRealtimeScope(tenantContext, flaky, TEST_ENV, scope, { ids: [id] })).toMatchObject({ published: 1 });
    expect(attempts).toBe(2);
    expect((await row('realtime_event', id)).status).toBe('completed');
  });

  // ── 10: failed statement generation ────────────────────────────────────────────────────────────────────────────
  it('10. a failed statement generation is retried under a NEW generation; the old generation\'s job is ignored (no duplicate statement)', async () => {
    const seeded = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'w4-stmt' });
    const m = seeded.managers[0]!;
    const recordId = await approvedRecord(seeded.organisation, m);
    const jobs: ShiftStatementJobData[] = [];
    const [c1] = await claimOurs(workerA, 'statement', [recordId]);
    expect(c1).toMatchObject({ organisationId: m.organisationId, workspaceId: m.workspaceId });
    await dispatchStatementScope(tenantContext, m.organisationId, m.workspaceId!, [recordId], async (d) => void jobs.push(d));
    expect(jobs).toHaveLength(1);
    const deps = (render: (html: string) => Promise<Buffer>) => ({
      tenantContext, files: app.get(FileService), notifications: app.get(NotificationService), audit: app.get(AuditService), render,
    });
    expect(await processShiftStatementJob(jobs[0]!, deps(async () => { throw new Error('renderer crashed'); }))).toBe('failed');
    expect(await row('payroll_record', recordId)).toMatchObject({ statement_status: 'failed', statement_attempts: 1 });
    // The 1-min retry backoff (time-shifted) — the trigger re-times the pointer from the row, the Worker re-claims it.
    await admin.query(`UPDATE core.payroll_record SET updated_at = now() - interval '2 minutes' WHERE id = $1`, [recordId]);
    const [c2] = await claimOurs(workerB, 'statement', [recordId]);
    expect(c2).toBeDefined();
    await dispatchStatementScope(tenantContext, m.organisationId, m.workspaceId!, [recordId], async (d) => void jobs.push(d));
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.generation).toBeGreaterThan(jobs[0]!.generation);
    const pdf = async () => Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    expect(await processShiftStatementJob(jobs[0]!, deps(pdf))).toBe('stale'); // the old generation never generates
    expect(await processShiftStatementJob(jobs[1]!, deps(pdf))).toBe('generated');
    expect(await processShiftStatementJob(jobs[1]!, deps(pdf))).not.toBe('generated'); // a duplicate delivery is a no-op
    const final = await row('payroll_record', recordId);
    expect(final.statement_file_id).not.toBeNull();
    expect(await pointer(recordId)).toBeNull();
  });

  /** shift-statement.integration.spec.ts `approvedRecordFor`, compacted (the same as the first-cutover spec). */
  async function approvedRecord(org: { id: string }, manager: TestIdentity): Promise<string> {
    const staff = await factory.createStaff(org, { owner: manager, label: 'w4-staff' });
    await admin.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = $1`, [staff.profileId]);
    const tokenM = await factory.login(manager);
    const tokenS = await factory.login(staff);
    const venueId = (await http().post('/rest/v1/venues').set(auth(tokenM)).send({ name: `W4 Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' })).body.id as string;
    const jobRoleId = (await http().post('/rest/v1/job-roles').set(auth(tokenM)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1337 })).body.id as string;
    const shiftId = (
      await http().post('/rest/v1/shifts').set(auth(tokenM)).send({
        venueId, jobRoleId, startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600_000).toISOString(), requiredCount: 1,
      })
    ).body.id as string;
    const attendanceQr = app.get(AttendanceQrService);
    const signQr = async () =>
      tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, async (m) =>
        attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokenM))).status).toBe(201);
    const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokenM)).send({ staffProfileId: staff.profileId });
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(tokenS))).status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokenM))).status).toBe(201);
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(tokenS)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(tokenS)).send({ shiftId, qrToken: await signQr() })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(tokenS)).send({ qrToken: await signQr() });
    const clockOutAt = new Date(out.body.clockOutAt).getTime();
    expect((await http().post(`/rest/v1/attendance/${out.body.id}/correct`).set(auth(tokenM))
      .send({ field: 'clockInAt', newValue: new Date(clockOutAt - 247 * 60_000).toISOString(), reason: 'W4 test worked time' })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${staff.profileId}/attendance-review`).set(auth(tokenM))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokenM))).status).toBe(200);
    const [rec] = await admin.query<[{ id: string }]>(`SELECT id FROM core.payroll_record WHERE attendance_id = $1`, [out.body.id]);
    expect((await http().post(`/rest/v1/payroll/records/${rec.id}/approve`).set(auth(tokenM))).status).toBe(200);
    return rec.id;
  }

  // ── 12: access revoked before realtime delivery ────────────────────────────────────────────────────────────────
  it('12. a recipient suspended before delivery: their API access is already denied; the Worker publishes only the minimal envelope (routing ids, no business data)', async () => {
    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'w4-revoke' });
    const [admin1, target] = seeded.managers as [TestIdentity, TestIdentity];
    const orgAdmin = await factory.createOrgAdmin(seeded.organisation, { permissions: 'all' }); // createOrgAdmin's 'production' set is empty
    const adminToken = await factory.login(orgAdmin);
    const targetToken = await factory.login(target);
    expect((await http().get('/rest/v1/auth/me').set(auth(targetToken))).status).toBe(200);
    const id = await seedRealtime(admin1, target.userId);
    const [{ id: profileId }] = await admin.query<[{ id: string }]>('SELECT id FROM core.manager_profile WHERE user_id = $1', [target.userId]);
    expect((await http().post(`/rest/v1/managers/${profileId}/deactivate`).set(auth(adminToken))).status).toBe(201);
    expect((await http().get('/rest/v1/auth/me').set(auth(targetToken))).status).toBe(401); // revoked before delivery
    const cap = realtimeCapture();
    await claimOurs(workerA, 'realtime', [id]);
    await publishRealtimeScope(tenantContext, cap.publish, TEST_ENV, { organisationId: admin1.organisationId, workspaceId: admin1.workspaceId }, { ids: [id] });
    expect(cap.byEvent.get(id)).toBe(1);
    const envelope = cap.envelopes.find((e) => e.eventId === id)!;
    expect(envelope.organisationId).toBe(admin1.organisationId);
    // Whatever the envelope carries, it carries no business payload beyond the outbox row's own (empty) payload.
    expect(JSON.stringify(envelope)).not.toMatch(/@|password|token/i);
    // eslint-disable-next-line no-console
    console.log(`[w4-measure] ${JSON.stringify({ name: 'revoked-recipient-envelope-keys', keys: Object.keys(envelope).sort() })}`);
  });
});
