import request from 'supertest';
import { ShiftReportService } from '@rab/server/modules/attendance/services/shift-report.service';
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { ShiftReport } from '@rab/server/modules/attendance/entities/shift-report.entity';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { discoverInWorkspaces } from '../../core/database/workspace-discovery';
import { runFinalTimesheetCycle } from '../../queues/rab-reports/final-timesheet.job';
import { runShiftReportSchedulerCycle } from '../../queues/rab-reports/shift-report-scheduler.job';
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
  let storage: FileService;
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
    storage = moduleRef.get(FileService);
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

  const protectedTables = ['shift_report', 'shift', 'shift_assignment', 'attendance'];
  async function assertRls() {
    const rows = await dataSource.query(`SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class WHERE relnamespace='core'::regnamespace AND relname=ANY($1) ORDER BY relname`, [protectedTables]);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  }
  let querySpies: jest.SpyInstance[] = [];
  beforeEach(async () => {
    await assertRls();
    querySpies = [jest.spyOn(dataSource.logger, 'logQuery'), jest.spyOn(adminDataSource.logger, 'logQuery')];
  });
  afterEach(async () => {
    const sql = querySpies.flatMap(spy => spy.mock.calls.map(call => String(call[0])));
    for (const spy of querySpies) spy.mockRestore();
    expect(sql.filter(query => /ALTER\s+TABLE[\s\S]*(DISABLE|ENABLE)\s+ROW\s+LEVEL\s+SECURITY/i.test(query))).toEqual([]);
    await assertRls();
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

  /** Reads a stored file through the verified path (throws on a missing object or checksum mismatch). */
  const readStoredFile = async (f: { organisation: { id: string }; workspaceId: string; owner: { userId: string } }, fileId: string): Promise<Buffer> => {
    const file = await tenantContext.runInTenantContext({ organisationId: f.organisation.id, workspaceId: f.workspaceId, userId: f.owner.userId, role: '' }, (m) => storage.findAvailable(m, fileId));
    expect(file).not.toBeNull();
    return storage.readVerified(file!);
  };

  const outboxRows = (organisationId: string, workspaceId: string, ownerUserId: string) =>
    tenantContext.runInTenantContext({ organisationId, workspaceId, userId: ownerUserId, role: '' }, (m) =>
      m.query(`SELECT recipient_email, attachment_file_id, attachment_filename FROM core.email_outbox WHERE organisation_id = $1 AND attachment_file_id IS NOT NULL ORDER BY created_at`, [organisationId]),
    );

  const runScheduler = (organisationId: string) =>
    runShiftReportSchedulerCycle(adminDataSource, tenantContext, attendanceQr, qrImage, emailOutbox, storage, reportAvailableBefore, { organisationId });
  const runFinal = async (organisationId: string) => {
    const offset = querySpies[1].mock.calls.length;
    const result = await runFinalTimesheetCycle(adminDataSource, tenantContext, emailOutbox, storage, { organisationId });
    const ownerCalls = querySpies[1].mock.calls.slice(offset).filter(call => call[2]?.connection === adminDataSource);
    expect(ownerCalls.length).toBeGreaterThan(0);
    const ownerSql = ownerCalls.map(call => String(call[0]));
    expect(ownerSql.filter(sql => /^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql))).toEqual([]);
    return result;
  };

  it('PRE-SHIFT: two workers discovering the same shift at once produce ONE PDF delivery, ONE email, ONE final report state', async () => {
    const f = await seedFixture();
    const [a, b] = await Promise.all([runScheduler(f.organisation.id), runScheduler(f.organisation.id)]);

    expect(a.failed + b.failed).toBe(0);
    expect(a.generated + b.generated).toBe(1);

    const rows = await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_email).toBe(f.venueManagerEmail);
    expect(rows[0].attachment_filename).toBe('shift-roster.pdf');

    // The attachment is a stored_file id; its bytes are a real PDF and pass the SHA-256 check.
    const pdf = await readStoredFile(f, rows[0].attachment_file_id);
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');

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
    await tenantContext.runInTenantContext({ organisationId: f.organisation.id, workspaceId: f.workspaceId, userId: f.owner.userId, role: '' }, async (m) => {
      await m.query(`UPDATE core.shift SET starts_at = now() - interval '10 hours', ends_at = now() - interval '2 hours' WHERE id = $1`, [f.shiftIds[0]]);
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

  it('original unsigned timesheet is generated after clock-out, then real VM finalisation keeps both immutable files and private access', async()=>{
    const f=await seedFixture(); const shiftId=f.shiftIds[0]!;
    const ctx={organisationId:f.organisation.id,workspaceId:f.workspaceId,userId:f.owner.userId,role:'manager'};
    const reports=app.get(ShiftReportService);
    expect((await reports.getReport(ctx,shiftId)).ready).toBe(false);
    await expect(reports.finalise(ctx,shiftId)).rejects.toThrow(/clock out/);
    await tenantContext.runInTenantContext(ctx,async m=>{
      const [sa]=await m.query('SELECT * FROM core.shift_assignment WHERE shift_id=$1',[shiftId]);
      await m.query(`INSERT INTO core.attendance (organisation_id,workspace_id,shift_id,shift_assignment_id,staff_profile_id,status,clock_in_at,clock_out_at,break_minutes,worked_minutes,earned_pence,clock_out_method)
        VALUES ($1,$2,$3,$4,$5,'clocked_out',now()-interval '2 hours',now(),15,105,2625,'auto_geofence')`,[f.organisation.id,f.workspaceId,shiftId,sa.id,sa.staff_profile_id]);
    });
    const ready=await reports.getReport(ctx,shiftId);expect(ready.ready).toBe(true);expect(ready.staff[0]).toMatchObject({workedMinutes:105,breakMinutes:15,clockOutMethod:'auto_geofence',avatarFileId:null});
    expect((await runFinal(f.organisation.id)).failed).toBe(0);
    const unsigned=await reports.getReport(ctx,shiftId);expect(unsigned.originalFileId).toBeTruthy();expect(unsigned.signedFileId).toBeNull();
    const original=await readStoredFile(f,unsigned.originalFileId!);expect(original.subarray(0,5).toString()).toBe('%PDF-');
    const [vm]=await tenantContext.runInTenantContext(ctx,m=>m.query('SELECT u.id FROM core."user" u WHERE u.email=$1',[f.venueManagerEmail]));
    await reports.finalise({...ctx,userId:vm.id,role:'venue_manager'},shiftId);
    await reports.finalise({...ctx,userId:vm.id,role:'venue_manager'},shiftId);
    expect((await runFinal(f.organisation.id)).sent).toBe(1);
    const signed=await reports.getReport(ctx,shiftId);expect(signed.originalFileId).toBe(unsigned.originalFileId);expect(signed.signedFileId).toBeTruthy();expect(signed.signedFileId).not.toBe(signed.originalFileId);expect(signed.finalisedBy).toBe(vm.id);expect(signed.finalisedByName).toBeTruthy();
    expect((await readStoredFile(f,signed.originalFileId!)).equals(original)).toBe(true);
    const token=await factory.login(f.owner);
    for(const fileId of [signed.originalFileId,signed.signedFileId])await request(app.getHttpServer()).get(`/rest/v1/files/${fileId}`).set('Authorization',`Bearer ${token}`).expect(200);
    const other=await factory.createInternalManager(f.organisation);
    // Force same-workspace adversarial fixture: RLS equality must not substitute for report ownership.
    await adminDataSource.query('UPDATE core.manager_profile SET workspace_id=$1 WHERE user_id=$2',[f.workspaceId,other.userId]);
    const otherToken=await factory.login(other);
    for(const fileId of [signed.originalFileId,signed.signedFileId,randomUUID()])await request(app.getHttpServer()).get(`/rest/v1/files/${fileId}`).set('Authorization',`Bearer ${otherToken}`).expect(404);
    expect((await runFinal(f.organisation.id)).sent).toBe(0);
    expect(await outboxRows(f.organisation.id,f.workspaceId,f.owner.userId)).toHaveLength(1);
  },120_000);

  it('FINAL: two workers discovering the same finalised report at once produce ONE final PDF delivery and ONE email', async () => {
    const f = await seedFixture();
    await finalise(f, f.shiftIds[0]!);
    const [a, b] = await Promise.all([runFinal(f.organisation.id), runFinal(f.organisation.id)]);

    expect(a.failed + b.failed).toBe(0);
    expect(a.sent + b.sent).toBe(1);

    const rows = await outboxRows(f.organisation.id, f.workspaceId, f.owner.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_email).toBe(f.venueManagerEmail);
    const finalPdf = await readStoredFile(f, rows[0].attachment_file_id);
    expect(finalPdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');

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
    const original = storage.putObject.bind(storage);
    const spy = jest.spyOn(storage, 'putObject').mockImplementation(async (params) => {
      if (params.resourceId === f.shiftIds[0]!) throw new Error('simulated storage outage');
      return original(params);
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
  it('PRE-01: discovery spans tenants but scans are read-only rab_app and no scoped or unscoped business access leaks', async () => {
    const a = await seedFixture(); const b = await seedFixture();
    for (const f of [a,b]) await tenantContext.runInTenantContext({organisationId:f.organisation.id,workspaceId:f.workspaceId,userId:f.owner.userId,role:''},async manager=>{
      const [assignment]=await manager.query('SELECT id,staff_profile_id FROM core.shift_assignment WHERE shift_id=$1',[f.shiftIds[0]]);
      await manager.query(`INSERT INTO core.attendance (organisation_id,workspace_id,shift_id,shift_assignment_id,staff_profile_id,status,clock_in_at,clock_out_at,break_minutes,worked_minutes,earned_pence)
        VALUES ($1,$2,$3,$4,$5,'clocked_out',now()-interval '2 hours',now(),15,105,2625)`,
        [f.organisation.id,f.workspaceId,f.shiftIds[0],assignment.id,assignment.staff_profile_id]);
    });
    await finalise(a, a.shiftIds[0]); await finalise(b, b.shiftIds[0]);
    const ids = [...a.shiftIds, ...b.shiftIds];
    const candidates = await discoverInWorkspaces(adminDataSource, tenantContext, async manager => {
      const [role] = await manager.query('SELECT current_user AS name');
      expect(role.name).toBe('rab_app');
      return manager.query('SELECT id, organisation_id, workspace_id FROM core.shift WHERE id=ANY($1::uuid[])', [ids]);
    });
    expect(candidates.map((r: any) => r.id).sort()).toEqual(ids.sort());
    await expect(discoverInWorkspaces(adminDataSource, tenantContext, async manager => {
      await manager.query('UPDATE core.shift SET updated_at=updated_at WHERE false'); return [];
    }, a.organisation.id)).rejects.toThrow(/read-only/);
    await Promise.all([runFinal(a.organisation.id), runFinal(b.organisation.id)]);
    for (const f of [a,b]) {
      const other = f === a ? b : a;
      await tenantContext.runInTenantContext({ organisationId:f.organisation.id, workspaceId:f.workspaceId,userId:f.owner.userId,role:'' },async manager=>{
        for (const table of [...protectedTables,'stored_file']) {
          expect((await manager.query(`SELECT id FROM core.${table} WHERE organisation_id=$1`,[f.organisation.id])).length).toBeGreaterThan(0);
          expect(await manager.query(`SELECT id FROM core.${table} WHERE organisation_id=$1`,[other.organisation.id])).toEqual([]);
          const [rows] = await manager.query(`UPDATE core.${table} SET id=id WHERE organisation_id=$1 RETURNING id`,[other.organisation.id]);
          expect(rows).toEqual([]);
        }
        const files = await manager.query(`SELECT id FROM core.stored_file WHERE resource_type='shift_report'`);
        expect(files).toHaveLength(2);
        const events = await manager.query(`SELECT status FROM core.worker_event WHERE entity_type='shift_report'`);
        expect(events).toHaveLength(2); expect(events.every((r:any)=>r.status==='completed')).toBe(true);
      });
    }
    for (const table of [...protectedTables,'stored_file']) expect(await dataSource.query(`SELECT id FROM core.${table}`)).toEqual([]);
  },180_000);

  it('PRE-01: readiness lost while rendering discards the original and leaves no file/event publication', async () => {
    const f=await seedFixture(); const shiftId=f.shiftIds[0];
    const ctx={organisationId:f.organisation.id,workspaceId:f.workspaceId,userId:f.owner.userId,role:''};
    await tenantContext.runInTenantContext(ctx,async manager=>{
      await manager.query(`UPDATE core.shift_assignment SET status='no_show' WHERE shift_id=$1`,[shiftId]);
    });
    const original=storage.putObject.bind(storage);
    const spy=jest.spyOn(storage,'putObject').mockImplementation(async params=>{
      const uploaded=await original(params);
      await tenantContext.runInTenantContext(ctx,manager=>manager.query(`UPDATE core.shift SET status='cancelled' WHERE id=$1`,[shiftId]));
      return uploaded;
    });
    try { expect((await runFinal(f.organisation.id)).failed).toBe(0); } finally { spy.mockRestore(); }
    await tenantContext.runInTenantContext(ctx,async manager=>{
      const [report]=await manager.query('SELECT original_file_id FROM core.shift_report WHERE shift_id=$1',[shiftId]);
      expect(report.original_file_id).toBeNull();
      expect(await manager.query('SELECT id FROM core.stored_file')).toEqual([]);
      expect(await manager.query('SELECT id FROM core.worker_event')).toEqual([]);
    });
  },120_000);

});
