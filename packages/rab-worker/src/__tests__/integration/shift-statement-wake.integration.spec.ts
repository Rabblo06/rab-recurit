import './helpers/statement-wake-env'; // env is frozen when AppModule is imported (bullmq scheduler, own prefix and Redis DB)
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Job, Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { STATEMENT_WAKE_JOB_NAME, STATEMENT_WAKE_QUEUE, ShiftStatementWakeService } from '@rab/server/engine/core-modules/statement-wake/shift-statement-wake.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ScanLock } from '../../core/locking/scan-lock';
import { WorkerRuntime } from '../../core/runtime/worker-runtime';
import { createScanJobProcessor } from '../../core/scheduler/bullmq-scheduler';
import { bullmqWorkerOptionsOf } from '../../core/scheduler/queue-registry';
import { SCAN_JOBS } from '../../core/scheduler/scan-jobs';
import { processShiftStatementJob, runShiftStatementDispatchCycle } from '../../queues/rab-reports/shift-statement.job';
import { renderReportPdf, ReportDocument } from '../../queues/rab-reports/render-pdf.util';
import { createAdminDataSource } from './helpers/admin-datasource';
import { bookBeforeDeadline } from './helpers/book-before-deadline';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';
import { businessTableOf, siblingTable } from './helpers/hws-fixtures';

/**
 * Phase X J1b: the pay-statement dispatcher WAKE, end to end. Real HTTP approval, real PostgreSQL (RLS on), real Redis and
 * BullMQ, the real scan-queue processor, WorkerRuntime and cross-replica scan lock, the real dispatcher and consumer:
 *  - the wake is added only AFTER the approval commits (never on rollback), with a BullMQ-minted id and `{ v: 1 }`, and it
 *    writes nothing (the row stays `pending`, generation 0);
 *  - the dispatcher a wake runs keeps every guard: one compare-and-set claim (generation 1), one statement job, a later
 *    wake claims nothing, a stale generation is refused, exactly one file;
 *  - Redis down: the approval still succeeds and commits `pending`; the sweep delivers the statement.
 * The wake's dispatcher is scoped to this suite's organisation (as the existing statement suite does), so it never claims
 * another suite's rows in the shared test database; production's sweep is the same function without the scope.
 */
const RUN = integrationTestDatabaseReady() && Boolean(process.env.REDIS_URL);
const describeIf = RUN ? describe : describe.skip;

jest.setTimeout(240_000);

const quiet = { log: () => undefined, warn: () => undefined };
/** WorkerRuntime's stats writes go nowhere: this suite asserts outcomes, not the Admin panel counters. */
function nullStatsRedis(): Redis {
  const multi = () => {
    const chain = { hset: () => chain, hincrby: () => chain, expire: () => chain, exec: () => Promise.resolve([]) };
    return chain;
  };
  return { hset: () => Promise.resolve(0), multi } as unknown as Redis;
}

describeIf('J1b pay-statement dispatcher wake (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let files: FileService;
  let notifications: NotificationService;
  let audit: AuditService;
  let attendanceQr: AttendanceQrService;
  let wake: ShiftStatementWakeService;
  let redis: Redis;
  let reports: Queue;
  let scanLock: ScanLock | undefined;
  let scanWorker: Worker | undefined;
  let runtime: WorkerRuntime | undefined;
  let workerConnection: Redis | undefined;
  const prefix = process.env.BULLMQ_PREFIX!;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let orgId: string;
  let a: TestIdentity;
  let staff: TestIdentity[];
  let tokens: { a: string; staff: string[] };
  let venueId: string;
  let jobRoleId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    files = moduleRef.get(FileService);
    notifications = moduleRef.get(NotificationService);
    audit = moduleRef.get(AuditService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    wake = moduleRef.get(ShiftStatementWakeService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    reports = new Queue(STATEMENT_WAKE_QUEUE, { connection: redis, prefix });

    const seeded = await factory.createOrganisationWithManagers(1, { workspace: true, permissions: 'production', label: 'stmtwake' });
    orgId = seeded.organisation.id;
    [a] = seeded.managers as [TestIdentity];
    staff = [];
    for (let i = 0; i < 3; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `stmtwake-s${i}` }));
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    const tokenA = await factory.login(a);
    const venue = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Wake Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    venueId = venue.body.id;
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1337 });
    jobRoleId = role.body.id;
    const staffTokens: string[] = [];
    for (const s of staff) staffTokens.push(await factory.login(s));
    tokens = { a: tokenA, staff: staffTokens };
  });

  afterAll(async () => {
    await scanWorker?.close().catch(() => undefined);
    await workerConnection?.quit().catch(() => undefined);
    runtime?.beginShutdown();
    await scanLock?.close().catch(() => undefined);
    // Only this suite's own random prefix (never bull:*, throttler or rab:* keys).
    if (redis) {
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
        cursor = next;
        if (batch.length) await redis.del(...batch);
      } while (cursor !== '0');
    }
    await reports?.close();
    await redis?.quit();
    await app?.close();
    await adminDataSource?.destroy();
  });

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** The full flow to a `pending_approval` payroll record for staff[i] (same fixture as shift-statement.integration). */
  async function pendingRecordFor(i: number): Promise<string> {
    const s = staff[i]!;
    const shift = await http().post('/rest/v1/shifts').set(auth(tokens.a)).send({
      venueId, jobRoleId, startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600_000).toISOString(), requiredCount: 1,
    });
    const shiftId = shift.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokens.a))).status).toBe(201);
    await bookBeforeDeadline(adminDataSource, shiftId, async () => {
      const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokens.a)).send({ staffProfileId: s.profileId });
      expect(offer.status).toBe(201);
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(tokens.staff[i]!))).status).toBe(201);
      expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokens.a))).status).toBe(201);
    });
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(tokens.staff[i]!)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(tokens.staff[i]!)).send({ shiftId, qrToken: await signQr(shiftId) })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(tokens.staff[i]!)).send({ qrToken: await signQr(shiftId) });
    const clockOutAt = new Date(out.body.clockOutAt).getTime();
    expect((await http().post(`/rest/v1/attendance/${out.body.id}/correct`).set(auth(tokens.a))
      .send({ field: 'clockInAt', newValue: new Date(clockOutAt - 247 * 60_000).toISOString(), reason: 'Statement wake test worked time' })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${s.profileId}/attendance-review`).set(auth(tokens.a))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokens.a))).status).toBe(200);
    const [rec] = await adminDataSource.query(`SELECT id FROM ${siblingTable(await businessTableOf(adminDataSource, 'attendance', out.body.id), 'payroll_record')} WHERE attendance_id = $1`, [out.body.id]);
    return rec.id as string;
  }

  const recordRow = async (id: string) => (await adminDataSource.query(`SELECT * FROM ${await businessTableOf(adminDataSource, 'payroll_record', id)} WHERE id = $1`, [id]))[0];
  const wakeJobs = async () =>
    (await reports.getJobs(['wait', 'delayed', 'prioritized', 'paused', 'active', 'completed', 'failed'])).filter((j): j is Job => Boolean(j) && j!.name === STATEMENT_WAKE_JOB_NAME);
  async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8_000): Promise<T> {
    const until = Date.now() + ms;
    let v = await read();
    while (!ok(v) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      v = await read();
    }
    return v;
  }
  const settleMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const published: ShiftStatementJobData[] = [];
  const outcomes: string[] = [];
  const deps = () => ({ tenantContext, files, notifications, audit, render: (doc: ReportDocument) => renderReportPdf(doc) });

  let wakeRecord: string;

  it('the approval commits the durable request; ONE wake is added only after commit (BullMQ id, { v: 1 }); the wake writes nothing', async () => {
    expect(wake.enabled).toBe(true);
    wakeRecord = await pendingRecordFor(0);
    expect(await wakeJobs()).toHaveLength(0);
    const approved = await http().post(`/rest/v1/payroll/records/${wakeRecord}/approve`).set(auth(tokens.a));
    expect(approved.status).toBe(200);
    const jobs = await eventually(wakeJobs, (j) => j.length >= 1);
    expect(jobs).toHaveLength(1);
    const [job] = jobs as [Job];
    expect(job.data).toEqual({ v: 1 });
    expect(String(job.id)).toMatch(/^\d+$/); // minted by BullMQ: no fixed id to be swallowed by the 1 h retention
    expect(job.repeatJobKey).toBeUndefined();
    expect(job.opts.attempts).toBe(1);
    // The wake is only a hint: the dispatch state is exactly what the approval committed.
    expect(await recordRow(wakeRecord)).toMatchObject({ status: 'approved', statement_status: 'pending', statement_dispatch_generation: 0, statement_queued_at: null, statement_file_id: null });
  });

  it('rollback: an approval that fails after its UPDATE publishes NO wake and leaves the record untouched', async () => {
    const rec = await pendingRecordFor(1);
    const before = (await wakeJobs()).length;
    const spy = jest.spyOn(audit, 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    const res = await http().post(`/rest/v1/payroll/records/${rec}/approve`).set(auth(tokens.a));
    spy.mockRestore();
    expect(res.status).toBeGreaterThanOrEqual(500);
    await settleMs(1_500);
    expect(await wakeJobs()).toHaveLength(before);
    expect(await recordRow(rec)).toMatchObject({ status: 'pending_approval', statement_status: 'none', statement_dispatch_generation: 0 });
    // Clean approval afterwards (the next test needs it approved): one more wake, after commit.
    expect((await http().post(`/rest/v1/payroll/records/${rec}/approve`).set(auth(tokens.a))).status).toBe(200);
    expect(await eventually(wakeJobs, (j) => j.length === before + 1)).toHaveLength(before + 1);
  });

  it('the wake runs the unchanged dispatcher (real scan processor, runtime and scan lock): one CAS claim per record, a later wake claims nothing, one file', async () => {
    const def = SCAN_JOBS.find((d) => d.jobName === STATEMENT_WAKE_JOB_NAME)!;
    runtime = new WorkerRuntime(nullStatsRedis(), { metricsLogMs: 0 });
    scanLock = await ScanLock.open({ connectionString: process.env.DATABASE_URL! }, quiet);
    const processor = createScanJobProcessor({
      defs: new Map([[def.jobName, def]]),
      isEnabled: () => true,
      registry: {
        scan: () => async () => {
          const r = await runShiftStatementDispatchCycle(adminDataSource, tenantContext, async (d) => { published.push(d); }, { organisationId: orgId });
          return Boolean(r.claimed);
        },
      },
      intervalOf: () => 30_000,
      runtime,
      lock: (id, work) => scanLock!.run(id, work),
      recordOutcome: (_d, o) => void outcomes.push(o),
    });
    workerConnection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    scanWorker = new Worker(STATEMENT_WAKE_QUEUE, processor, { connection: workerConnection, prefix, ...bullmqWorkerOptionsOf(STATEMENT_WAKE_QUEUE) });
    // The two waiting wakes (tests 1 and 2) are consumed.
    await eventually(async () => (await reports.getJobCounts('wait', 'active')), (c) => c.wait === 0 && c.active === 0, 30_000);
    await eventually(async () => published.length, (n) => n >= 2, 15_000);
    // One claim per approved record, each at generation 1 (the dispatcher's CAS in the Worker's session).
    const byRecord = new Map(published.map((p) => [p.payrollRecordId, p]));
    expect(published).toHaveLength(2);
    expect(byRecord.size).toBe(2);
    for (const p of published) expect(p).toMatchObject({ organisationId: orgId, workspaceId: a.workspaceId, generation: 1 });
    expect(await recordRow(wakeRecord)).toMatchObject({ statement_status: 'queued', statement_dispatch_generation: 1 });

    // Two more wakes at once (from committed transactions): both run or skip, but nothing is claimed again inside the lease.
    for (let i = 0; i < 2; i++) {
      await tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) => {
        expect(wake.afterCommit(m)).toBe(true);
      });
    }
    await eventually(async () => outcomes.length, (n) => n >= 4, 15_000);
    await eventually(async () => (await reports.getJobCounts('wait', 'active')), (c) => c.wait === 0 && c.active === 0, 15_000);
    expect(published).toHaveLength(2);
    expect(outcomes.every((o) => ['succeeded', 'idle', 'skipped-running', 'skipped-locked'].includes(o))).toBe(true);

    // The consumer: a stale generation is refused, the current one generates exactly once.
    const job = byRecord.get(wakeRecord)!;
    expect(await processShiftStatementJob({ ...job, generation: 0 }, deps())).toBe('stale');
    const results = await Promise.all([processShiftStatementJob(job, deps()), processShiftStatementJob(job, deps())]);
    expect(results.filter((r) => r === 'generated')).toHaveLength(1);
    const n = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.stored_file WHERE resource_type = 'payroll_record' AND resource_id = $1 AND status = 'AVAILABLE'`, [wakeRecord]);
    expect(n[0].n).toBe(1);
    expect(await recordRow(wakeRecord)).toMatchObject({ statement_status: 'generated' });
  });

  it('Redis down at publish: the approval still succeeds and commits pending; no wake; the sweep then delivers', async () => {
    const rec = await pendingRecordFor(2);
    const before = (await wakeJobs()).length;
    // The API's wake producer loses Redis (its own fail-fast connection; the test's Redis client stays up to observe).
    (wake as unknown as { connection: Redis }).connection.disconnect();
    const res = await http().post(`/rest/v1/payroll/records/${rec}/approve`).set(auth(tokens.a));
    expect(res.status).toBe(200);
    await settleMs(1_500);
    expect(await wakeJobs()).toHaveLength(before);
    expect(await recordRow(rec)).toMatchObject({ status: 'approved', statement_status: 'pending', statement_dispatch_generation: 0 });
    // The scheduled sweep (the same dispatcher, no wake) picks it up.
    const sweep = await runShiftStatementDispatchCycle(adminDataSource, tenantContext, async (d) => { published.push(d); }, { organisationId: orgId });
    expect(sweep.claimed).toBe(1);
    const job = published.at(-1)!;
    expect(job).toMatchObject({ payrollRecordId: rec, generation: 1 });
    expect(await processShiftStatementJob(job, deps())).toBe('generated');
    expect(await recordRow(rec)).toMatchObject({ statement_status: 'generated' });
  });
});
