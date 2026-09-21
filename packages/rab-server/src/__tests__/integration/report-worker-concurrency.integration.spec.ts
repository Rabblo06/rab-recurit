import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { EmailOutboxService } from '../../engine/core-modules/email/email-outbox.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { StorageService } from '../../engine/core-modules/storage/storage.service';
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
import { runFinalTimesheetCycle } from '../../queue-worker/reports/final-timesheet.job';
import { runShiftReportSchedulerCycle } from '../../queue-worker/reports/shift-report-scheduler.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * MULTI-WORKER SAFETY of the two report jobs. Two worker instances discover
 * the same logical report at the same moment (both call the real job entry
 * point concurrently, against the real database, with the real Playwright
 * renderer). Required outcome for each report: exactly ONE claim, ONE
 * rendered PDF delivery, ONE set of emails, ONE final state — and one
 * report's failure never blocks another's.
 *
 * Each cycle is scoped to this test's own organisation (the optional
 * `organisationId` narrowing) so the assertion is deterministic even though
 * the shared dev database holds thousands of unrelated test shifts.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('report worker multi-instance concurrency (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let storage: StorageService;
  let emailOutbox: EmailOutboxService;
  let attendanceQr: AttendanceQrService;
  let qrImage: QrImageService;
  let reportAvailableBefore: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    storage = moduleRef.get(StorageService);
    emailOutbox = moduleRef.get(EmailOutboxService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    qrImage = moduleRef.get(QrImageService);
    reportAvailableBefore = moduleRef.get(EnvironmentService).get('REPORT_AVAILABLE_BEFORE_MINUTES');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  interface Fixture {
    organisation: Organisation;
    owner: TestIdentity;
    venueManagerEmail: string;
    workspaceId: string;
    shiftId: string;
  }

  /** One org: Internal Manager (owner), a venue with an assigned Venue Manager (the report recipient), one staff member CONFIRMED on a shift starting in an hour. */
  async function seedShift(organisation: Organisation, owner: TestIdentity, venueManager: TestIdentity, venue: Venue): Promise<string> {
    const staff = await factory.createStaff(organisation, { owner });
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    return tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, async (m) => {
      const jobRole = await m.save(JobRole, {
        organisationId: organisation.id,
        name: `Role ${randomUUID().slice(0, 6)}`,
        defaultRatePence: 1500,
        createdBy: owner.userId,
        workspaceId: owner.workspaceId!,
      });
      const shift = await m.save(Shift, {
        organisationId: organisation.id,
        venueId: venue.id,
        jobRoleId: jobRole.id,
        startsAt,
        endsAt,
        breakMinutes: 30,
        requiredCount: 1,
        payRatePence: 1500,
        status: 'open',
        createdBy: owner.userId,
        workspaceId: owner.workspaceId!,
      });
      await m.save(ShiftAssignment, {
        organisationId: organisation.id,
        shiftId: shift.id,
        staffProfileId: staff.profileId!,
        status: 'confirmed',
        payRateSnapshotPence: 1500,
        assignedBy: owner.userId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId: owner.workspaceId!,
      });
      void venueManager;
      return shift.id;
    });
  }

  async function seedFixture(shifts = 1): Promise<Omit<Fixture, 'shiftId'> & { shiftIds: string[] }> {
    const organisation = await factory.createOrganisation('rpt');
    const owner = await factory.createInternalManager(organisation);
    const venue = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: owner.workspaceId, userId: owner.userId, role: '' }, (m) =>
      m.save(Venue, { organisationId: organisation.id, name: 'Report Venue', createdBy: owner.userId, workspaceId: owner.workspaceId! }),
    );
    const venueManager = await factory.createVenueManager(organisation, { owner, venueIds: [venue.id] });
    const shiftIds: string[] = [];
    for (let i = 0; i < shifts; i++) shiftIds.push(await seedShift(organisation, owner, venueManager, venue));
    return { organisation, owner, venueManagerEmail: venueManager.email, workspaceId: owner.workspaceId!, shiftIds };
  }

  const outboxRows = (organisationId: string, workspaceId: string, ownerUserId: string) =>
    tenantContext.runInTenantContext({ organisationId, workspaceId, userId: ownerUserId, role: '' }, (m) =>
      m.query(`SELECT recipient_email, attachment_key, attachment_filename FROM core.email_outbox WHERE organisation_id = $1 AND attachment_key IS NOT NULL ORDER BY created_at`, [organisationId]),
    );

  const runScheduler = (organisationId: string) =>
    runShiftReportSchedulerCycle(adminDataSource, tenantContext, attendanceQr, qrImage, emailOutbox, storage, reportAvailableBefore, { organisationId });
  const runFinal = (organisationId: string) => runFinalTimesheetCycle(adminDataSource, tenantContext, emailOutbox, storage, { organisationId });

  it('PRE-SHIFT: two workers discovering the same shift at once produce ONE PDF delivery, ONE email, ONE final report state', async () => {
    const f = await seedFixture();
    const [a, b] = await Promise.all([runScheduler(f.organisation.id), runScheduler(f.organisation.id)]);

    expect(a.failed + b.failed).toBe(0);
    expect(a.generated + b.generated).toBe(1);

    const rows = await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_email).toBe(f.venueManagerEmail);
    expect(rows[0].attachment_key).toMatch(new RegExp(`^org/${f.organisation.id}/reports/${f.shiftIds[0]}/pre-shift-\\d+\\.pdf$`));
    expect(rows[0].attachment_filename).toBe('shift-roster.pdf');

    // The stored attachment is a real PDF.
    const pdf = await storage.read(rows[0].attachment_key);
    expect(pdf).not.toBeNull();
    expect(pdf!.buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');

    const report = await tenantContext.runInTenantContext({ organisationId: f.organisation.id, workspaceId: f.workspaceId, userId: f.owner.userId, role: '' }, (m) =>
      m.find(ShiftReport, { where: { shiftId: f.shiftIds[0] } }),
    );
    expect(report).toHaveLength(1);
    expect(report[0].status).toBe('ready');
    expect(report[0].preShiftPdfGeneratedAt).toBeTruthy();
  }, 120_000);

  it('PRE-SHIFT: a later tick after delivery does nothing — no second PDF, no second email (idempotent)', async () => {
    const f = await seedFixture();
    await runScheduler(f.organisation.id);
    const again = await runScheduler(f.organisation.id);
    expect(again.generated).toBe(0);
    expect(await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId)).toHaveLength(1);
  }, 120_000);

  it('PRE-SHIFT: a shift that has already ENDED is never given a "pre-shift" report', async () => {
    const f = await seedFixture();
    // Owner-only fixture edit: `shift` is FORCE-RLS, so bracket it the same way the worker's own discovery scan does.
    await adminDataSource.transaction(async (m) => {
      await m.query(`ALTER TABLE core.shift DISABLE ROW LEVEL SECURITY`);
      await m.query(`UPDATE core.shift SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [f.shiftIds[0]]);
      await m.query(`ALTER TABLE core.shift ENABLE ROW LEVEL SECURITY`);
    });
    const result = await runScheduler(f.organisation.id);
    expect(result.generated).toBe(0);
    expect(await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId)).toHaveLength(0);
  }, 60_000);

  async function finalise(f: { organisation: Organisation; owner: TestIdentity; workspaceId: string }, shiftId: string) {
    await tenantContext.runInTenantContext({ organisationId: f.organisation.id, workspaceId: f.workspaceId, userId: f.owner.userId, role: '' }, (m) =>
      m.save(ShiftReport, {
        organisationId: f.organisation.id,
        workspaceId: f.workspaceId,
        shiftId,
        status: 'finalised',
        finalisedAt: new Date(),
        finalisedBy: f.owner.userId,
      }),
    );
  }

  it('FINAL: two workers discovering the same finalised report at once produce ONE final PDF delivery and ONE email', async () => {
    const f = await seedFixture();
    await finalise(f, f.shiftIds[0]!);
    const [a, b] = await Promise.all([runFinal(f.organisation.id), runFinal(f.organisation.id)]);

    expect(a.failed + b.failed).toBe(0);
    expect(a.sent + b.sent).toBe(1);

    const rows = await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_email).toBe(f.venueManagerEmail);
    expect(rows[0].attachment_key).toBe(`org/${f.organisation.id}/reports/${f.shiftIds[0]}/final-timesheet.pdf`);
    const finalPdf = await storage.read(rows[0].attachment_key);
    expect(finalPdf).not.toBeNull();
    expect(finalPdf!.buffer.subarray(0, 5).toString('utf8')).toBe('%PDF-');

    const report = await tenantContext.runInTenantContext({ organisationId: f.organisation.id, workspaceId: f.workspaceId, userId: f.owner.userId, role: '' }, (m) =>
      m.findOneByOrFail(ShiftReport, { shiftId: f.shiftIds[0] }),
    );
    expect(report.status).toBe('finalised');
    expect(report.finalPdfSentAt).toBeTruthy();
  }, 120_000);

  it('FINAL: a later tick after delivery sends nothing more (duplicate email prevented)', async () => {
    const f = await seedFixture();
    await finalise(f, f.shiftIds[0]!);
    await runFinal(f.organisation.id);
    const again = await runFinal(f.organisation.id);
    expect(again.sent).toBe(0);
    expect(await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId)).toHaveLength(1);
  }, 120_000);

  it('FINAL: one report failing (storage down for it) does not block the next report, and the failed one is retried and delivered on the next tick', async () => {
    const f = await seedFixture(2);
    await finalise(f, f.shiftIds[0]!);
    await finalise(f, f.shiftIds[1]!);
    const original = storage.storePdf.bind(storage);
    const spy = jest.spyOn(storage, 'storePdf').mockImplementation(async (key: string, buf: Buffer) => {
      if (key.includes(f.shiftIds[0]!)) throw new Error('simulated storage outage');
      return original(key, buf);
    });
    try {
      const first = await runFinal(f.organisation.id);
      expect(first.failed).toBe(1);
      expect(first.sent).toBe(1);
      expect(await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    const retry = await runFinal(f.organisation.id);
    expect(retry.sent).toBe(1);
    expect(retry.failed).toBe(0);
    expect(await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId)).toHaveLength(2);
  }, 180_000);

  it('the per-report lock is crash-safe: it is released the moment its holder\'s connection dies', async () => {
    const holder = adminDataSource.createQueryRunner();
    await holder.connect();
    const name = `final_timesheet:${randomUUID()}`;
    await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [name]);
    const contender = adminDataSource.createQueryRunner();
    await contender.connect();
    const [{ locked: whileHeld }] = await contender.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`, [name]);
    expect(whileHeld).toBe(false);
    // Simulate a killed worker: terminate the holder's backend.
    const [{ pid }] = await holder.query(`SELECT pg_backend_pid() AS pid`);
    await contender.query(`SELECT pg_terminate_backend($1)`, [pid]);
    await holder.release().catch(() => undefined);
    // pg_terminate_backend is asynchronous: Postgres releases the dead session's locks a moment later.
    let afterCrash = false;
    const deadline = Date.now() + 10_000;
    while (!afterCrash && Date.now() < deadline) {
      [{ locked: afterCrash }] = await contender.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`, [name]);
      if (!afterCrash) await new Promise((r) => setTimeout(r, 100));
    }
    expect(afterCrash).toBe(true);
    await contender.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [name]);
    await contender.release();
  }, 30_000);
});
