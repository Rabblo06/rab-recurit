import { LOCAL_ROOT, REPORT_SMTP_PORT } from './helpers/report-storage-env'; // FIRST: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '../../engine/core-modules/email/email-outbox.service';
import { EmailService } from '../../engine/core-modules/email/email.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { FileService } from '../../engine/core-modules/storage/file.service';
import { StorageDriverFactory } from '../../engine/core-modules/storage/storage-driver.factory';
import { StorageError, StorageErrorCode } from '../../engine/core-modules/storage/storage.errors';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { QrImageService } from '../../modules/attendance/services/qr-image.service';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { StorageReconcileCommand } from '../../command/storage-reconcile.command';
import { createEmailSendProcessor } from '../../queue-worker/jobs/email-send.processor';
import { runFinalTimesheetCycle } from '../../queue-worker/reports/final-timesheet.job';
import { runShiftReportSchedulerCycle } from '../../queue-worker/reports/shift-report-scheduler.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { S3_TEST } from './helpers/s3-env';
import { SmtpSink } from './helpers/smtp-sink';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * MULTI-WORKER OBJECT STORAGE + FAILURE INJECTION (real MinIO, real PostgreSQL,
 * real Playwright PDFs, real SMTP wire). Gated on RAB_TEST_S3=1.
 *
 * "Worker A" and "Worker B" are two INDEPENDENT application instances — each has
 * its own S3 client, its own connection pools and its own services — sharing
 * only PostgreSQL, Redis-less job state and the private bucket. The local
 * storage directory is an empty temp dir that must still be empty at the end:
 * no worker is allowed to depend on a local file.
 */
const describeIf = S3_TEST.enabled ? describe : describe.skip;
jest.setTimeout(180_000);

interface Worker {
  app: INestApplication;
  tenantContext: TenantContextService;
  files: FileService;
  emailOutbox: EmailOutboxService;
  attendanceQr: AttendanceQrService;
  qrImage: QrImageService;
  audit: AuditService;
  emailService: EmailService;
  drivers: StorageDriverFactory;
  env: EnvironmentService;
  dataSource: DataSource;
  factory?: TestIdentityFactory;
}

describeIf('report storage — multi-worker and failure injection (S3)', () => {
  let seed: Worker; // long-lived instance used ONLY to create fixtures and read state; never one of the workers under test
  let a: Worker;
  let b: Worker;
  let adminDataSource: DataSource;
  let sink: SmtpSink;

  async function spawnWorker(): Promise<Worker> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    return {
      app,
      tenantContext: moduleRef.get(TenantContextService),
      files: moduleRef.get(FileService),
      emailOutbox: moduleRef.get(EmailOutboxService),
      attendanceQr: moduleRef.get(AttendanceQrService),
      qrImage: moduleRef.get(QrImageService),
      audit: moduleRef.get(AuditService),
      emailService: moduleRef.get(EmailService),
      drivers: moduleRef.get(StorageDriverFactory),
      env: moduleRef.get(EnvironmentService),
      dataSource: moduleRef.get(DataSource),
    };
  }

  const runScheduler = (w: Worker, organisationId: string) =>
    runShiftReportSchedulerCycle(adminDataSource, w.tenantContext, w.attendanceQr, w.qrImage, w.emailOutbox, w.files, w.env.get('REPORT_AVAILABLE_BEFORE_MINUTES'), { organisationId, audit: w.audit });
  const runFinal = (w: Worker, organisationId: string) => runFinalTimesheetCycle(adminDataSource, w.tenantContext, w.emailOutbox, w.files, { organisationId, audit: w.audit });
  const processEmail = (w: Worker, outboxId: string, organisationId: string, attemptsMade = 0) =>
    createEmailSendProcessor({ tenantContext: w.tenantContext, emailService: w.emailService, auditService: w.audit, fileService: w.files })({
      data: { emailOutboxId: outboxId, organisationId },
      attemptsMade,
      opts: { attempts: 5 },
    } as never);

  beforeAll(async () => {
    sink = new SmtpSink();
    await sink.start(REPORT_SMTP_PORT);
    seed = await spawnWorker();
    a = await spawnWorker();
    b = await spawnWorker();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    seed.factory = new TestIdentityFactory({ app: seed.app, dataSource: seed.dataSource, adminDataSource, tenantContext: seed.tenantContext, passwordHashing: seed.app.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await seed?.app.close().catch(() => undefined);
    await a?.app.close().catch(() => undefined);
    await b?.app.close().catch(() => undefined);
    await adminDataSource?.destroy();
    await sink?.stop();
  });

  // ------------------------------------------------------------------------------------------------ fixtures
  interface Fixture {
    org: Organisation;
    owner: TestIdentity;
    vmEmail: string;
    workspaceId: string;
    shiftId: string;
    ctx: { organisationId: string; workspaceId: string; userId: string; role: string };
  }

  async function seedFixture(): Promise<Fixture> {
    const factory = seed.factory!;
    const org = await factory.createOrganisation('mw');
    const owner = await factory.createInternalManager(org);
    const ctx = { organisationId: org.id, workspaceId: owner.workspaceId!, userId: owner.userId, role: '' };
    const venue = await seed.tenantContext.runInTenantContext(ctx, (m) => m.save(Venue, { organisationId: org.id, name: 'MW Venue', createdBy: owner.userId, workspaceId: owner.workspaceId! }));
    const vm = await factory.createVenueManager(org, { owner, venueIds: [venue.id] });
    const staff = await factory.createStaff(org, { owner });
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    const shiftId = await seed.tenantContext.runInTenantContext(ctx, async (m) => {
      const jobRole = await m.save(JobRole, { organisationId: org.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const shift = await m.save(Shift, { organisationId: org.id, venueId: venue.id, jobRoleId: jobRole.id, startsAt, endsAt, breakMinutes: 30, requiredCount: 1, payRatePence: 1500, status: 'open', createdBy: owner.userId, workspaceId: owner.workspaceId! });
      await m.save(ShiftAssignment, { organisationId: org.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: 'confirmed', payRateSnapshotPence: 1500, assignedBy: owner.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: owner.workspaceId! });
      return shift.id;
    });
    return { org, owner, vmEmail: vm.email, workspaceId: owner.workspaceId!, shiftId, ctx };
  }

  const finalise = (f: Fixture) =>
    seed.tenantContext.runInTenantContext(f.ctx, (m) =>
      m.save(ShiftReport, { organisationId: f.org.id, workspaceId: f.workspaceId, shiftId: f.shiftId, status: 'finalised', finalisedAt: new Date(), finalisedBy: f.owner.userId }),
    );

  const outbox = (f: Fixture) => seed.tenantContext.runInTenantContext(f.ctx, (m) => m.query(`SELECT id, status, attachment_file_id, attachment_filename, last_error_code FROM core.email_outbox WHERE organisation_id = $1 AND attachment_file_id IS NOT NULL ORDER BY created_at`, [f.org.id]));
  const storedFiles = (f: Fixture) => seed.tenantContext.runInTenantContext(f.ctx, (m) => m.query(`SELECT id, kind, status, sha256, size_bytes, object_key FROM core.stored_file WHERE organisation_id = $1 ORDER BY created_at`, [f.org.id]));
  const reportRow = (f: Fixture) => seed.tenantContext.runInTenantContext(f.ctx, (m) => m.query(`SELECT status, pre_shift_file_id, final_file_id, final_pdf_sent_at FROM core.shift_report WHERE shift_id = $1`, [f.shiftId]));
  const auditCount = (f: Fixture, action: string) => seed.tenantContext.runInTenantContext(f.ctx, async (m) => (await m.query(`SELECT 1 FROM core.audit_log WHERE organisation_id = $1 AND action = $2`, [f.org.id, action])).length);
  const objectsUnder = async (w: Worker, f: Fixture): Promise<string[]> => {
    const keys: string[] = [];
    for await (const o of w.drivers.getDriver().list(`test/organisations/${f.org.id}/`)) keys.push(o.key);
    return keys;
  };
  const stub = <T extends object, K extends keyof T>(target: T, method: K, impl: (...args: never[]) => unknown) => jest.spyOn(target, method as never).mockImplementation(impl as never);
  const isPdf = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

  // ------------------------------------------------------------------------------------------------ the core proof
  it('Worker A generates + stores the PDF, Worker A DIES, Worker B emails the SAME bytes — no shared disk, checksum-verified end to end', async () => {
    const f = await seedFixture();
    const result = await runScheduler(a, f.org.id);
    expect(result).toMatchObject({ generated: 1, failed: 0 });

    const rows = await outbox(f);
    expect(rows).toHaveLength(1);
    const files = await storedFiles(f);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: 'SHIFT_ROSTER_PDF', status: 'AVAILABLE' });
    expect(files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await reportRow(f))[0].pre_shift_file_id).toBe(files[0].id);

    // The bytes live ONLY in the shared bucket.
    expect(await objectsUnder(a, f)).toEqual([files[0].object_key]);
    expect(readdirSync(LOCAL_ROOT)).toEqual([]);

    // Worker A dies. Its S3 client, pools and process are gone.
    await a.app.close();

    // Worker B — never saw a byte of this report — sends it.
    await processEmail(b, rows[0].id, f.org.id);
    const mail = sink.mailsTo(f.vmEmail).find((m) => m.subject.includes('Shift roster'));
    expect({ mail: Boolean(mail), outbox: await outbox(f), sink: sink.mails.map((m) => m.subject) }).toMatchObject({ mail: true });
    expect(mail!.attachments).toHaveLength(1);
    expect(mail!.attachments[0]!.contentType).toBe('application/pdf');
    expect(isPdf(mail!.attachments[0]!.content)).toBe(true);
    // generated == stored == emailed
    expect(createHash('sha256').update(mail!.attachments[0]!.content).digest('hex')).toBe(files[0].sha256);
    expect((await outbox(f))[0].status).toBe('SENT');
    expect(readdirSync(LOCAL_ROOT)).toEqual([]); // still no local file anywhere

    // Bring a fresh Worker A back for the remaining tests (a real deploy would restart it).
    a = await spawnWorker();
  });

  // ------------------------------------------------------------------------------------------------ idempotency across workers
  it('PRE-SHIFT: two workers racing the same shift produce ONE object, ONE file record, ONE email — the loser leaves no orphan', async () => {
    const f = await seedFixture();
    const [ra, rb] = await Promise.all([runScheduler(a, f.org.id), runScheduler(b, f.org.id)]);
    expect(ra.failed + rb.failed).toBe(0);
    expect(ra.generated + rb.generated).toBe(1);
    expect(await storedFiles(f)).toHaveLength(1);
    expect(await outbox(f)).toHaveLength(1);
    expect(await objectsUnder(a, f)).toHaveLength(1);
  });

  it('FINAL: two workers racing one finalised report -> ONE final file, ONE email, ONE object; later ticks change nothing (immutable evidence)', async () => {
    const f = await seedFixture();
    await finalise(f);
    const [ra, rb] = await Promise.all([runFinal(a, f.org.id), runFinal(b, f.org.id)]);
    expect(ra.failed + rb.failed).toBe(0);
    expect(ra.sent + rb.sent).toBe(1);

    const [report] = await reportRow(f);
    expect(report.final_file_id).toBeTruthy();
    const files = await storedFiles(f);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ id: report.final_file_id, kind: 'FINAL_TIMESHEET_PDF' });
    expect(await outbox(f)).toHaveLength(1);
    expect(await objectsUnder(a, f)).toEqual([files[0].object_key]);

    const before = { fileId: report.final_file_id, sha: files[0].sha256, key: files[0].object_key };
    await runFinal(a, f.org.id);
    await runFinal(b, f.org.id);
    const after = (await storedFiles(f))[0];
    expect(after).toMatchObject({ id: before.fileId, sha256: before.sha, object_key: before.key }); // never re-rendered, never overwritten
    expect(await objectsUnder(a, f)).toHaveLength(1);
    expect((await auditCount(f, 'report.stored'))).toBe(1);
  });

  // ------------------------------------------------------------------------------------------------ failure injection: upload side
  describe('failure injection — generation and upload', () => {
    it('CASE A — S3 unavailable before upload: nothing is claimed AVAILABLE, no email, and the next tick succeeds', async () => {
      const f = await seedFixture();
      const driver = a.drivers.getDriver();
      const spy = stub(driver, 'put', async () => {
        throw new StorageError(StorageErrorCode.TEMPORARILY_UNAVAILABLE, 'down', true);
      });
      const failed = await runScheduler(a, f.org.id);
      expect(failed.failed).toBe(1);
      expect(await storedFiles(f)).toHaveLength(0);
      expect(await outbox(f)).toHaveLength(0);
      expect((await reportRow(f))[0]?.pre_shift_file_id ?? null).toBeNull();
      spy.mockRestore();

      const retried = await runScheduler(a, f.org.id);
      expect(retried).toMatchObject({ generated: 1, failed: 0 });
      expect(await storedFiles(f)).toHaveLength(1);
    });

    it('upload AccessDenied (bad credentials): a controlled failure, nothing stored, no partial state, no email', async () => {
      const f = await seedFixture();
      const driver = a.drivers.getDriver();
      const spy = stub(driver, 'put', async () => {
        throw new StorageError(StorageErrorCode.PERMISSION_ERROR, 'denied', false);
      });
      expect((await runScheduler(a, f.org.id)).failed).toBe(1);
      expect(await storedFiles(f)).toHaveLength(0);
      expect(await outbox(f)).toHaveLength(0);
      spy.mockRestore();
    });

    it('CASE B — upload succeeds, metadata write FAILS: the just-written object is discarded (no orphan) and the report retries cleanly', async () => {
      const f = await seedFixture();
      const spy = stub(a.files, 'registerAvailable', async () => {
        throw new Error('simulated database failure after upload');
      });
      expect((await runScheduler(a, f.org.id)).failed).toBe(1);
      spy.mockRestore();
      expect(await storedFiles(f)).toHaveLength(0);
      expect(await objectsUnder(a, f)).toEqual([]); // discarded, not orphaned
      expect(await outbox(f)).toHaveLength(0);

      expect((await runScheduler(a, f.org.id)).generated).toBe(1);
      expect(await objectsUnder(a, f)).toHaveLength(1);
    });

    it('CASE B′ — the worker CRASHES after upload (discard never runs): the orphan is REPORTED by storage:reconcile and NEVER auto-deleted', async () => {
      const f = await seedFixture();
      const driver = a.drivers.getDriver();
      const regSpy = stub(a.files, 'registerAvailable', async () => {
        throw new Error('crash before metadata');
      });
      const delSpy = stub(driver, 'delete', async () => {
        throw new Error('process died before cleanup');
      });
      await runScheduler(a, f.org.id);
      regSpy.mockRestore();
      delSpy.mockRestore();
      const orphans = await objectsUnder(a, f);
      expect(orphans).toHaveLength(1);
      expect(await storedFiles(f)).toHaveLength(0);

      const reportFile = join(mkdtempSync(join(tmpdir(), 'rab-reconcile-')), 'report.json');
      const command = new StorageReconcileCommand(adminDataSource, a.drivers, a.env);
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await command.run([], { reportFile });
      log.mockRestore();
      const report = JSON.parse(readFileSync(reportFile, 'utf8'));
      expect(report.mode).toBe('REPORT-ONLY');
      expect(report.orphan_objects.map((o: { key: string }) => o.key)).toContain(orphans[0]);
      expect(await objectsUnder(a, f)).toEqual(orphans); // reconcile reports, it does not delete
    });
  });

  // ------------------------------------------------------------------------------------------------ failure injection: email side
  describe('failure injection — email worker', () => {
    async function generated(): Promise<{ f: Fixture; outboxId: string; file: { id: string; object_key: string; sha256: string } }> {
      const f = await seedFixture();
      expect((await runScheduler(a, f.org.id)).generated).toBe(1);
      const [row] = await outbox(f);
      const [file] = await storedFiles(f);
      return { f, outboxId: row.id, file };
    }

    it('CASE C — the object was deleted after generation: the email FAILS in a controlled way, is audited, and no mail is sent', async () => {
      const { f, outboxId, file } = await generated();
      await b.drivers.getDriver().delete(file.object_key);
      const before = sink.mails.length;
      await expect(processEmail(b, outboxId, f.org.id)).rejects.toThrow(/permanently failed/);
      expect(sink.mails.length).toBe(before);
      const [row] = await outbox(f);
      expect(row).toMatchObject({ status: 'FAILED', last_error_code: StorageErrorCode.OBJECT_NOT_FOUND });
      expect(await auditCount(f, 'report.integrity_failed')).toBeGreaterThan(0);
    });

    it('CASE D — the object was corrupted (same size, different bytes): STORAGE_INTEGRITY_FAILED, NEVER emailed, audited', async () => {
      const { f, outboxId, file } = await generated();
      const bytes = (await b.drivers.getDriver().get(file.object_key))!;
      const corrupted = Buffer.from(bytes);
      corrupted[12] = corrupted[12]! ^ 0xff;
      await b.drivers.getDriver().put(file.object_key, corrupted, { contentType: 'application/pdf' });
      const before = sink.mails.length;
      await expect(processEmail(b, outboxId, f.org.id)).rejects.toThrow(/permanently failed/);
      expect(sink.mails.length).toBe(before);
      expect((await outbox(f))[0]).toMatchObject({ status: 'FAILED', last_error_code: StorageErrorCode.INTEGRITY_FAILED });
      expect(await auditCount(f, 'report.integrity_failed')).toBeGreaterThan(0);
    });

    it('the email worker cannot reach S3 (retryable outage): the job is RETRIED, then delivers once storage is back — exactly one email', async () => {
      const { f, outboxId } = await generated();
      const spy = stub(b.drivers.getDriver(), 'get', async () => {
        throw new StorageError(StorageErrorCode.TEMPORARILY_UNAVAILABLE, 'down', true);
      });
      const before = sink.mails.length;
      await expect(processEmail(b, outboxId, f.org.id, 0)).rejects.toBeDefined();
      expect(sink.mails.length).toBe(before);
      expect((await outbox(f))[0].status).toBe('RETRY'); // not FAILED: an outage is not a verdict on the file
      spy.mockRestore();

      await processEmail(b, outboxId, f.org.id, 1);
      expect(sink.mails.length).toBe(before + 1);
      expect((await outbox(f))[0].status).toBe('SENT');
    });

    it('a queue payload naming ANOTHER organisation cannot make a worker mail this file (the worker trusts the DB row, not the payload)', async () => {
      const { f, outboxId } = await generated();
      const other = await seedFixture();
      const before = sink.mails.length;
      await processEmail(b, outboxId, other.org.id); // forged organisationId
      expect(sink.mails.length).toBe(before);
      expect((await outbox(f))[0].status).not.toBe('SENT');
    });

    it('a legacy outbox row that carries a raw object key instead of a file id is refused (never trust a key from a row/queue)', async () => {
      const f = await seedFixture();
      const row = await seed.tenantContext.runInTenantContext(f.ctx, async (m) => {
        const inserted = await m.query(
          `INSERT INTO core.email_outbox (organisation_id, job_type, status, recipient_email, target_user_id, rendered_subject, attachment_key, attachment_filename)
           VALUES ($1, 'NOTIFICATION', 'PENDING', $2, $3, 'legacy', 'org/other/secret.pdf', 'x.pdf') RETURNING id`,
          [f.org.id, f.vmEmail, f.owner.userId],
        );
        return inserted[0] as { id: string };
      });
      const before = sink.mails.length;
      await expect(processEmail(b, row.id, f.org.id)).rejects.toThrow();
      expect(sink.mails.length).toBe(before);
    });
  });

  it('after everything above, no worker ever wrote a local file', () => {
    expect(readdirSync(LOCAL_ROOT)).toEqual([]);
  });
});
