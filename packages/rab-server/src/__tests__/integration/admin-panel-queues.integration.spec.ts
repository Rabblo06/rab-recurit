import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AdminQueuesService } from '../../engine/core-modules/platform-admin/admin-queues.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Crewflow Platform Admin Panel — queue jobs against REAL Redis/BullMQ (D7, plan §6):
 *  - job lists carry ids, timestamps, attempts and a safe error CLASS only — never `data`, the failure message or tokens;
 *  - retry: failed jobs on rab-email/rab-push and the scan queues; a job that is not failed is a no-op; scheduler
 *    (repeat) ids are refused; step-up + reason required; audited;
 *  - delete: completed/failed on scan queues only; rab-email/rab-push delete refused; nothing at all on
 *    rab-shift-statements (payroll); an unknown queue is 404.
 * The queues run under an ISOLATED per-run prefix (the service's real D7 definitions, only the prefix swapped) so this
 * suite never touches the jobs other suites publish to the shared test Redis.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
jest.setTimeout(180_000);

describeIfDb('admin panel queues (integration, real BullMQ)', () => {
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let admin: TestIdentity;
  let adminToken: string;
  let connection: Redis;
  const consumerPrefix = `crewflow-test-adminq-${randomUUID().slice(0, 8)}`;
  const scanPrefix = `${consumerPrefix}-scan`;
  const queues: Queue[] = [];
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const outboxId = randomUUID();
  const orgId = randomUUID();
  let failedEmailJob: Job;
  let waitingEmailJob: Job;

  const queueOf = (name: string, prefix: string) => {
    const q = new Queue(name, { connection, prefix });
    queues.push(q);
    return q;
  };

  /** Runs `count` jobs on a throwaway worker that always throws (free text with secrets), then closes it. */
  async function failJobs(queue: Queue, prefix: string, jobs: Array<{ data: Record<string, unknown>; id?: string }>): Promise<Job[]> {
    const added = [];
    for (const j of jobs) added.push(await queue.add('send', j.data, { jobId: j.id, attempts: 1, removeOnFail: false, removeOnComplete: false }));
    const worker = new Worker(
      queue.name,
      async () => {
        throw new Error('provider said secret-recipient@example.test rejected; token=tok_planted_secret');
      },
      { connection: connection.duplicate(), prefix, autorun: true },
    );
    for (let i = 0; i < 100; i++) {
      const states = await Promise.all(added.map((j) => queue.getJobState(j.id!)));
      if (states.every((s) => s === 'failed')) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await worker.close();
    return added;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const org = await factory.createOrganisation('apqueues');
    admin = await factory.createInternalManager(org, { permissions: 'all', label: 'apqadm', platformAdmin: true });
    connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

    // The service's real D7 definitions, prefixes swapped to this run's isolated ones (bullmq mode simulated).
    const service = moduleRef.get(AdminQueuesService) as unknown as {
      schedulerStatus: () => Promise<unknown>;
      definitions: () => Promise<{ mode: string; defs: Array<{ kind: string; prefix: string }>; scheduler: unknown }>;
    };
    jest.spyOn(service, 'schedulerStatus').mockResolvedValue({ mode: 'bullmq', prefix: scanPrefix, reconciledAt: Date.now(), schedulers: 7 });
    const realDefinitions = service.definitions.bind(service);
    jest.spyOn(service, 'definitions').mockImplementation(async () => {
      const real = await realDefinitions();
      return { ...real, defs: real.defs.map((d) => (d.kind === 'consumer' ? { ...d, prefix: consumerPrefix } : d)) };
    });

    const email = queueOf('rab-email', consumerPrefix);
    [failedEmailJob] = await failJobs(email, consumerPrefix, [{ data: { emailOutboxId: outboxId, organisationId: orgId, secretToken: 'tok_planted_secret', body: '<p>private body</p>' } }]);
    waitingEmailJob = await email.add('send', { emailOutboxId: randomUUID(), organisationId: orgId }, { delay: 3_600_000 });
    adminToken = await factory.login(admin, { applicationTarget: 'manager_web' });
  });

  afterAll(async () => {
    for (const q of queues) {
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
    connection?.disconnect();
    await owner?.destroy();
    await app?.close();
  });

  it('overview: registry queues (scan queues only in bullmq mode), counts, metrics collected (one week of points)', async () => {
    const res = await http().get('/rest/v1/admin/queues').set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('bullmq');
    const names = res.body.queues.map((q: { name: string }) => q.name);
    expect(names).toEqual(expect.arrayContaining(['rab-email', 'rab-push', 'rab-shift-statements', 'crewflow-scan-offers', 'crewflow-scan-maintenance']));
    expect(res.body.metrics).toEqual({ collected: true, retentionMinutes: 10_080 });
    const emailQ = res.body.queues.find((q: { name: string }) => q.name === 'rab-email');
    expect(emailQ.counts.failed).toBe(1);
    expect(emailQ.actions).toEqual({ retry: ['failed'], delete: [], lockedReason: null });
    expect(res.body.queues.find((q: { name: string }) => q.name === 'rab-shift-statements').actions).toMatchObject({ retry: [], delete: [] });
  });

  it('job list: ids + safe error class + allowlisted ids only — never data, the failure message or a token', async () => {
    const res = await http().get('/rest/v1/admin/queues/rab-email/jobs?state=failed').set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toEqual({
      id: failedEmailJob.id,
      name: 'send',
      state: 'failed',
      createdAt: expect.any(String),
      processedAt: expect.any(String),
      finishedAt: expect.any(String),
      attemptsMade: 1,
      maxAttempts: 1,
      errorClass: 'SEE_WORKER_LOG',
      organisationId: orgId,
      entityId: outboxId,
      scheduler: false,
    });
    const raw = JSON.stringify(res.body);
    for (const leak of ['tok_planted_secret', 'secret-recipient', 'private body', 'token=']) expect(raw).not.toContain(leak);
    expect((await http().get('/rest/v1/admin/queues/rab-email/jobs?state=paused').set(bearer(adminToken))).status).toBe(400);
    expect((await http().get('/rest/v1/admin/queues/no-such-queue/jobs?state=failed').set(bearer(adminToken))).status).toBe(404);
  });

  it('ABUSE retry: a stale session is refused 403 STEP_UP_REQUIRED and the job stays failed', async () => {
    const stale = await factory.login(admin, { applicationTarget: 'manager_web' });
    const sid = (JSON.parse(Buffer.from(stale.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
    await app.get(AuthCacheRedisClientProvider).client.del(`crewflow:test:step-up:${sha256(sid)}`);
    const res = await http().post('/rest/v1/admin/queues/rab-email/jobs/retry').set(bearer(stale)).send({ jobIds: [failedEmailJob.id], reason: 'stale' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    expect(await failedEmailJob.getState()).toBe('failed');
  });

  it('ABUSE D7: nothing on rab-shift-statements; no delete on rab-email / rab-push', async () => {
    const statements = await http().post('/rest/v1/admin/queues/rab-shift-statements/jobs/retry').set(bearer(adminToken)).send({ jobIds: ['1'], reason: 'payroll' });
    expect(statements.status).toBe(409);
    expect(statements.body.code).toBe('QUEUE_ACTION_NOT_ALLOWED');
    expect((await http().post('/rest/v1/admin/queues/rab-shift-statements/jobs/delete').set(bearer(adminToken)).send({ jobIds: ['1'], reason: 'payroll' })).status).toBe(409);
    for (const q of ['rab-email', 'rab-push']) {
      const res = await http().post(`/rest/v1/admin/queues/${q}/jobs/delete`).set(bearer(adminToken)).send({ jobIds: [failedEmailJob.id], reason: 'delete attempt' });
      expect({ q, status: res.status, code: res.body.code }).toEqual({ q, status: 409, code: 'QUEUE_ACTION_NOT_ALLOWED' });
    }
    expect(await failedEmailJob.getState()).toBe('failed');
  });

  it('retry: the failed job is re-queued once; a not-failed job is a no-op; scheduler ids refused; audited with queue + reason', async () => {
    const res = await http()
      .post('/rest/v1/admin/queues/rab-email/jobs/retry')
      .set(bearer(adminToken))
      .send({ jobIds: [failedEmailJob.id, waitingEmailJob.id, 'repeat:crewflow-scan:1', 'missing-job'], reason: 'Provider rate limit cleared' });
    expect(res.status).toBe(200);
    expect(res.body.done).toEqual([failedEmailJob.id]);
    expect(res.body.skipped).toEqual(
      expect.arrayContaining([
        { id: waitingEmailJob.id, reason: 'wrong_state' },
        { id: 'repeat:crewflow-scan:1', reason: 'scheduler' },
        { id: 'missing-job', reason: 'not_found' },
      ]),
    );
    expect(['waiting', 'prioritized', 'active']).toContain(await failedEmailJob.getState());
    expect(await waitingEmailJob.getState()).toBe('delayed');
    const again = await http().post('/rest/v1/admin/queues/rab-email/jobs/retry').set(bearer(adminToken)).send({ jobIds: [failedEmailJob.id], reason: 'double click' });
    expect(again.body.done).toEqual([]);
    const [audit] = await owner.query(
      `SELECT metadata FROM core.audit_log WHERE actor_user_id = $1 AND action = 'admin.queue_jobs_retried' ORDER BY created_at DESC LIMIT 1 OFFSET 1`,
      [admin.userId],
    );
    expect(audit.metadata).toMatchObject({ queue: 'rab-email', count: 1, jobIds: [failedEmailJob.id], reason: 'Provider rate limit cleared' });
  });

  it('interval mode (no live bullmq scheduler status): scan queues are not listed and their jobs are 404', async () => {
    const service = app.get(AdminQueuesService) as unknown as { schedulerStatus: jest.Mock };
    service.schedulerStatus.mockResolvedValueOnce(null);
    const overview = await http().get('/rest/v1/admin/queues').set(bearer(adminToken));
    expect(overview.body.mode).toBe('interval');
    expect(overview.body.queues.map((q: { name: string }) => q.name)).toEqual(['rab-email', 'rab-push', 'rab-shift-statements']);
    service.schedulerStatus.mockResolvedValueOnce(null);
    expect((await http().get('/rest/v1/admin/queues/crewflow-scan-offers/jobs?state=failed').set(bearer(adminToken))).status).toBe(404);
  });

  it('delete on a scan queue: completed/failed only — a waiting job is never deleted', async () => {
    const scan = queueOf('crewflow-scan-offers', scanPrefix);
    const [failedScan] = await failJobs(scan, scanPrefix, [{ data: { v: 1 } }]);
    const waiting = await scan.add('scan', { v: 1 }, { delay: 3_600_000 });
    const res = await http().post('/rest/v1/admin/queues/crewflow-scan-offers/jobs/delete').set(bearer(adminToken)).send({ jobIds: [failedScan!.id, waiting.id], reason: 'Clear old scan failures' });
    expect(res.status).toBe(200);
    expect(res.body.done).toEqual([failedScan!.id]);
    expect(res.body.skipped).toEqual([{ id: waiting.id, reason: 'wrong_state' }]);
    expect(await scan.getJob(failedScan!.id!)).toBeUndefined();
    expect(await waiting.getState()).toBe('delayed');
  });
});
