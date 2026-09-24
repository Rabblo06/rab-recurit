import './helpers/use-dead-s3-env'; // FIRST import: env is frozen when AppModule is imported
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { ShiftReport } from '../../modules/attendance/entities/shift-report.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * Object storage must never sit on the attendance hot path. With the S3 driver
 * selected and the store unreachable:
 *   - the application still BOOTS (the client connects lazily),
 *   - clock-in and clock-out still work, quickly,
 *   - a report download fails FAST and CLEANLY (503, no provider detail, no hang).
 * Needs PostgreSQL only — no MinIO — so it runs in ordinary CI.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('attendance stays up while object storage is down', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let qr: AttendanceQrService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    qr = moduleRef.get(AttendanceQrService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('clock-in and clock-out succeed with S3 unreachable, and are not slowed by it; a report download fails fast with a clean 503', async () => {
    const org = await factory.createOrganisation('outage');
    const im = await factory.createInternalManager(org);
    const staff = await factory.createStaff(org, { owner: im });
    const imCtx = { organisationId: org.id, workspaceId: im.workspaceId, userId: im.userId, role: '' };

    const seeded = await tenantContext.runInTenantContext(imCtx, async (m) => {
      const venue = await m.save(Venue, { organisationId: org.id, name: 'Outage Venue', createdBy: im.userId, workspaceId: im.workspaceId!, lat: 51.5, lng: -0.12, geofenceRadiusM: 100, enforceGeofence: true });
      const jobRole = await m.save(JobRole, { organisationId: org.id, name: 'Role', defaultRatePence: 1500, createdBy: im.userId, workspaceId: im.workspaceId! });
      const startsAt = new Date(Date.now() + 5 * 60_000);
      const endsAt = new Date(startsAt.getTime() + 8 * 3600_000);
      const shift = await m.save(Shift, { organisationId: org.id, venueId: venue.id, jobRoleId: jobRole.id, startsAt, endsAt, breakMinutes: 30, requiredCount: 1, payRatePence: 1500, status: 'confirmed', createdBy: im.userId, workspaceId: im.workspaceId! }); // CONFIRMED, not OPEN: clock-in below drives Shift OPEN would reject (SHIFT_TRANSITIONS has no OPEN->IN_PROGRESS edge)
      await m.save(ShiftAssignment, { organisationId: org.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: 'confirmed', payRateSnapshotPence: 1500, assignedBy: im.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: im.workspaceId! });
      const report = await m.save(ShiftReport, { organisationId: org.id, workspaceId: im.workspaceId!, shiftId: shift.id, status: 'ready' });
      return { shift, report };
    });
    const staffToken = await factory.login(staff);
    const imToken = await factory.login(im);
    const qrToken = qr.sign(seeded.shift);
    const location = { lat: 51.5, lng: -0.12, accuracyM: 6 };

    // ---- the attendance hot path: never touches storage
    const inStarted = Date.now();
    const clockIn = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-in').set('Authorization', `Bearer ${staffToken}`).send({ shiftId: seeded.shift.id, qrToken, ...location });
    expect(clockIn.status).toBe(201);
    expect(Date.now() - inStarted).toBeLessThan(3000); // a dead dependency must not add connect/retry latency here

    const outStarted = Date.now();
    const clockOut = await request(app.getHttpServer()).post('/rest/v1/attendance/clock-out').set('Authorization', `Bearer ${staffToken}`).send({ qrToken, ...location });
    expect(clockOut.status).toBe(201);
    expect(Date.now() - outStarted).toBeLessThan(3000);

    // ---- the API is healthy without S3 (readiness is DB + Redis, not object storage)
    expect((await request(app.getHttpServer()).get('/healthz')).status).toBe(200);

    // ---- a report file whose bytes are unreachable: fast, clean 503 — not a hang, not a raw provider error
    const fileId = randomUUID();
    await adminDataSource.transaction(async (m) => {
      await m.query(`ALTER TABLE core.stored_file DISABLE ROW LEVEL SECURITY`);
      try {
        await m.query(
          `INSERT INTO core.stored_file (id, organisation_id, workspace_id, kind, resource_type, resource_id, storage_driver, bucket, object_key, original_filename, mime_type, size_bytes, sha256, status)
           VALUES ($1, $2, $3, 'SHIFT_ROSTER_PDF', 'shift_report', $4, 'S3', 'rab-dev', $5, 'r.pdf', 'application/pdf', 100, $6, 'AVAILABLE')`,
          [fileId, org.id, im.workspaceId, seeded.report.id, `test/outage/${fileId}.pdf`, createHash('sha256').update('x').digest('hex')],
        );
      } finally {
        await m.query(`ALTER TABLE core.stored_file ENABLE ROW LEVEL SECURITY`);
      }
    });
    const dlStarted = Date.now();
    const download = await request(app.getHttpServer()).get(`/rest/v1/files/${fileId}/download`).set('Authorization', `Bearer ${imToken}`).redirects(0);
    expect(download.status).toBe(503);
    expect(download.body.code).toBe('STORAGE_TEMPORARILY_UNAVAILABLE');
    expect(JSON.stringify(download.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|amazonaws|rab-dev/);
    expect(Date.now() - dlStarted).toBeLessThan(15_000); // bounded retries
  });
});
