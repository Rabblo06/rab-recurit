import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { SHIFT_EARNINGS_APPROVED_LINE, STATEMENT_DISCLAIMER, TO_BE_CONFIRMED } from '@rab/server/modules/payroll/templates/approved-shift-statement.html';
import { SHIFT_STATEMENT_MAX_ATTEMPTS, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { processShiftStatementJob, runShiftStatementDispatchCycle } from '../../queues/rab-reports/shift-statement.job';
import { renderHtmlToPdf } from '../../queues/rab-reports/render-pdf.util';
import { runPayrollPeriodAttentionCycle } from '../../queues/rab-reports/payroll-period-attention.job';
import { OFFICIAL_CALENDAR_2026 } from '@rab/server/modules/payroll/constants/official-calendar-2026';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Approved Shift Statement on payroll approval (PayStatement1786719000000 + ApprovedShiftStatement1786719100000).
 * Real HTTP + real Postgres/RLS + the real dispatcher/consumer functions and the Playwright renderer. The BullMQ hop is
 * represented by the `publish` callback (the production one is `queue.add`), so "Redis down" is a publish that throws.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

jest.setTimeout(240_000);

describeIfDb('approved shift statement pipeline (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let files: FileService;
  let notifications: NotificationService;
  let audit: AuditService;
  let attendanceQr: AttendanceQrService;

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  let orgId: string;
  let a: TestIdentity;
  let b: TestIdentity;
  let staff: TestIdentity[];
  let tokens: { a: string; b: string; vm: string; staff: string[] };
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
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(2, { workspace: true, permissions: 'production', label: 'paystmt' });
    orgId = seeded.organisation.id;
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    // A is the organisation's Initial Manager (only they may import the agency calendar, owner decision 2026-10-21).
    await adminDataSource.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [a.userId]);
    staff = [];
    for (let i = 0; i < 6; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a, label: `paystmt-s${i}` }));
    await adminDataSource.query(`UPDATE core.staff_profile SET employment_status = 'active' WHERE id = ANY($1::uuid[])`, [staff.map((s) => s.profileId)]);
    const tokenA = await factory.login(a);
    const venue = await http().post('/rest/v1/venues').set(auth(tokenA)).send({ name: `Statement Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' });
    venueId = venue.body.id;
    const role = await http().post('/rest/v1/job-roles').set(auth(tokenA)).send({ name: `Role-${randomUUID()}`, defaultRatePence: 1337 });
    jobRoleId = role.body.id;
    const vm = await factory.createVenueManager(seeded.organisation, { owner: a, venueIds: [venueId], label: 'paystmt-vm' });
    const staffTokens: string[] = [];
    for (const s of staff) staffTokens.push(await factory.login(s));
    tokens = { a: tokenA, b: await factory.login(b), vm: await factory.login(vm), staff: staffTokens };
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  async function signQr(shiftId: string): Promise<string> {
    return tenantContext.runInTenantContext({ organisationId: orgId, workspaceId: a.workspaceId, userId: a.userId, role: '' }, async (m) =>
      attendanceQr.sign(await m.findOneByOrFail(Shift, { id: shiftId })));
  }

  /** Full flow to an approved payroll record for staff[i]; returns the record id (and its attendance id). */
  const attendanceOf: Record<string, string> = {};
  async function approvedRecordFor(i: number, approve = true): Promise<string> {
    const s = staff[i]!;
    const shift = await http().post('/rest/v1/shifts').set(auth(tokens.a)).send({
      venueId, jobRoleId, startsAt: new Date(Date.now() - 5 * 60_000).toISOString(), endsAt: new Date(Date.now() + 8 * 3600_000).toISOString(), requiredCount: 1,
    });
    const shiftId = shift.body.id as string;
    expect((await http().post(`/rest/v1/shifts/${shiftId}/publish`).set(auth(tokens.a))).status).toBe(201);
    const offer = await http().post(`/rest/v1/shifts/${shiftId}/offers`).set(auth(tokens.a)).send({ staffProfileId: s.profileId });
    expect(offer.status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/accept`).set(auth(tokens.staff[i]!))).status).toBe(201);
    expect((await http().post(`/rest/v1/offers/${offer.body.id}/confirm`).set(auth(tokens.a))).status).toBe(201);
    // Check In (arrival) is required before Clock In for bookings made after 1786719450000.
    expect((await http().post('/rest/v1/attendance/check-in').set(auth(tokens.staff[i]!)).send({ shiftId })).status).toBe(200);
    expect((await http().post('/rest/v1/attendance/clock-in').set(auth(tokens.staff[i]!)).send({ shiftId, qrToken: await signQr(shiftId) })).status).toBe(201);
    const out = await http().post('/rest/v1/attendance/clock-out').set(auth(tokens.staff[i]!)).send({ qrToken: await signQr(shiftId) });
    const clockOutAt = new Date(out.body.clockOutAt).getTime();
    expect((await http().post(`/rest/v1/attendance/${out.body.id}/correct`).set(auth(tokens.a))
      .send({ field: 'clockInAt', newValue: new Date(clockOutAt - 247 * 60_000).toISOString(), reason: 'Pay statement test worked time' })).status).toBe(201);
    expect((await http().post(`/rest/v1/attendance/report/shift/${shiftId}/staff/${s.profileId}/attendance-review`).set(auth(tokens.a))).status).toBe(200);
    expect((await http().patch(`/rest/v1/attendance/report/shift/${shiftId}/finalise`).set(auth(tokens.a))).status).toBe(200);
    const [rec] = await adminDataSource.query(`SELECT id FROM core.payroll_record WHERE attendance_id = $1`, [out.body.id]);
    attendanceOf[rec.id] = out.body.id;
    if (!approve) return rec.id as string;
    const approved = await http().post(`/rest/v1/payroll/records/${rec.id}/approve`).set(auth(tokens.a));
    expect(approved.status).toBe(200);
    expect(approved.body.statement.state).toBe('processing');
    return rec.id as string;
  }

  const recordRow = async (id: string) => (await adminDataSource.query(`SELECT * FROM core.payroll_record WHERE id = $1`, [id]))[0];

  let recordId: string;
  let fileId: string;
  let lastHtml = '';
  const jobs: ShiftStatementJobData[] = [];
  const publish = async (d: ShiftStatementJobData) => { jobs.push(d); };
  const redisDown = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'ConnectionError' }); };
  const dispatch = (pub: (d: ShiftStatementJobData) => Promise<void> = publish) =>
    runShiftStatementDispatchCycle(adminDataSource, tenantContext, pub, { organisationId: orgId });
  const deps = (render?: (html: string) => Promise<Buffer>) => ({ tenantContext, files, notifications, audit,
    render: render ?? (async (html: string) => { lastHtml = html; return renderHtmlToPdf(html); }) });
  const expireLease = (id: string) => adminDataSource.query(
    `UPDATE core.payroll_record SET statement_queued_at = now() - interval '11 minutes', statement_processing_at = NULL WHERE id = $1`, [id]);

  it('approval commits the durable request only: pending, no file, no notification; History shows it as approved already', async () => {
    recordId = await approvedRecordFor(0);
    expect(await recordRow(recordId)).toMatchObject({ statement_status: 'pending', statement_file_id: null, statement_notified_at: null, statement_attempts: 0, statement_dispatch_generation: 0 });
    expect(await adminDataSource.query(`SELECT 1 FROM core.notification WHERE related_entity_id = $1`, [recordId])).toEqual([]);
    const history = await http().get('/rest/v1/attendance/me/history').set(auth(tokens.staff[0]!));
    expect(history.body.find((h: { id: string }) => h.id === attendanceOf[recordId])).toMatchObject({ payrollStatus: 'approved' });
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(tokens.staff[0]!));
    expect(mine.body.data[0].statement).toEqual({ state: 'processing', fileId: null, filename: null, generatedAt: null, notifiedAt: null });
  });

  it('Redis/BullMQ down: the claim stays committed, nothing is lost, and the lease re-queues it with a new generation', async () => {
    const down = await dispatch(redisDown);
    expect(down).toMatchObject({ claimed: 1, published: 0, publishFailed: 1 });
    expect(await recordRow(recordId)).toMatchObject({ statement_status: 'queued', statement_dispatch_generation: 1 });
    expect((await dispatch()).claimed).toBe(0); // inside the lease: not re-claimed
    await expireLease(recordId);
    const recovered = await dispatch();
    expect(recovered).toMatchObject({ claimed: 1, published: 1, requeued: 1 });
    expect(jobs.at(-1)).toEqual({ payrollRecordId: recordId, organisationId: orgId, workspaceId: a.workspaceId, generation: 2 });
  });

  it('the consumer ignores a stale generation, generates exactly once for the current one, notifies and audits', async () => {
    expect(await processShiftStatementJob({ payrollRecordId: recordId, organisationId: orgId, workspaceId: a.workspaceId!, generation: 1 }, deps())).toBe('stale');
    expect(await processShiftStatementJob(jobs.at(-1)!, deps())).toBe('generated');
    const row = await recordRow(recordId);
    expect(row).toMatchObject({ statement_status: 'generated', statement_error: null });
    expect(row.statement_generated_at).not.toBeNull();
    expect(row.statement_notified_at).not.toBeNull();
    fileId = row.statement_file_id;
    const [file] = await adminDataSource.query(`SELECT kind, status, resource_type, resource_id, workspace_id, mime_type FROM core.stored_file WHERE id = $1`, [fileId]);
    expect(file).toEqual({ kind: 'APPROVED_SHIFT_STATEMENT_PDF', status: 'AVAILABLE', resource_type: 'payroll_record', resource_id: recordId, workspace_id: a.workspaceId, mime_type: 'application/pdf' });
    expect(await adminDataSource.query(`SELECT user_id, type, title FROM core.notification WHERE related_entity_id = $1`, [recordId]))
      .toEqual([{ user_id: staff[0]!.userId, type: 'shift_statement_ready', title: 'Approved Shift Statement available' }]);
    const audits = await adminDataSource.query(`SELECT metadata FROM core.audit_log WHERE action = 'payroll_record.shift_statement_generated' AND entity_id::text = $1`, [recordId]);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({ fileId, notified: true, generation: 2 });
    // Content: owner wording; payroll period and payday never computed.
    expect(lastHtml).toContain('Approved Shift Statement');
    expect(lastHtml).toContain(SHIFT_EARNINGS_APPROVED_LINE.replace('—', '—'));
    expect(lastHtml).toContain(STATEMENT_DISCLAIMER);
    expect(lastHtml.split(TO_BE_CONFIRMED).length - 1).toBe(2);
    expect(lastHtml).toContain('Adolphus Recruitment');
    expect(lastHtml).toMatch(/Verified payable hours/);
    expect(lastHtml).not.toMatch(/payslip<\/|Net pay/i);
  });

  it('retries and duplicate deliveries are idempotent: no second file, notification or audit', async () => {
    expect(await processShiftStatementJob(jobs.at(-1)!, deps())).toBe('stale');
    expect((await dispatch()).claimed).toBe(0); // generated rows are never due
    const second = await approvedRecordFor(1);
    await dispatch();
    const job = jobs.at(-1)!;
    expect(job.payrollRecordId).toBe(second);
    const outcomes = await Promise.all([processShiftStatementJob(job, deps()), processShiftStatementJob(job, deps())]);
    expect(outcomes.filter((o) => o === 'generated')).toHaveLength(1);
    for (const id of [recordId, second]) {
      const n = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.stored_file WHERE resource_type = 'payroll_record' AND resource_id = $1 AND status = 'AVAILABLE'`, [id]);
      expect(n[0].n).toBe(1);
      const notes = await adminDataSource.query(`SELECT count(*)::int AS n FROM core.notification WHERE related_entity_id = $1`, [id]);
      expect(notes[0].n).toBe(1);
    }
  });

  it('the staff member downloads their own statement; other staff, other-workspace managers and Venue Managers get 404', async () => {
    const own = await http().get(`/rest/v1/files/${fileId}/download`).set(auth(tokens.staff[0]!)).buffer(true)
      .parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(own.body).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await http().get(`/rest/v1/files/${fileId}/download`).set(auth(tokens.staff[1]!))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileId}/download`).set(auth(tokens.b))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileId}/download`).set(auth(tokens.vm))).status).toBe(404);
    expect((await http().get(`/rest/v1/files/${fileId}/download`).set(auth(tokens.a))).status).toBe(200);
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(tokens.staff[0]!));
    expect(mine.body.data[0]).toMatchObject({
      payrollRecordId: recordId, payrollPeriod: null, payday: null,
      statement: { state: 'available', fileId, filename: expect.stringMatching(/^approved-shift-statement-ASS-\d{8}-[0-9A-F]{8}\.pdf$/), generatedAt: expect.any(String), notifiedAt: expect.any(String) },
    });
    expect((await http().get('/rest/v1/payroll/me/statements').set(auth(tokens.staff[1]!))).body.data.map((d: { payrollRecordId: string }) => d.payrollRecordId)).not.toContain(recordId);
  });

  it('a failed render is recorded (safe code), retried by the dispatcher after back-off, and reported failed once retries are used', async () => {
    const failing = await approvedRecordFor(2);
    const boom = async () => { throw new Error('renderer down with details that must not be stored'); };
    await dispatch();
    expect(await processShiftStatementJob(jobs.at(-1)!, deps(boom))).toBe('failed');
    expect(await recordRow(failing)).toMatchObject({ statement_status: 'failed', statement_attempts: 1, statement_error: 'generation_failed', statement_file_id: null, statement_notified_at: null });
    expect(await adminDataSource.query(`SELECT 1 FROM core.notification WHERE related_entity_id = $1`, [failing])).toEqual([]);
    expect((await dispatch()).claimed).toBe(0); // back-off
    for (let attempt = 2; attempt <= SHIFT_STATEMENT_MAX_ATTEMPTS; attempt++) {
      await adminDataSource.query(`UPDATE core.payroll_record SET updated_at = now() - interval '1 hour' WHERE id = $1`, [failing]);
      const again = await dispatch();
      expect(again).toMatchObject({ claimed: 1, requeued: 1 });
      expect(await processShiftStatementJob(jobs.at(-1)!, deps(boom))).toBe('failed');
    }
    expect((await recordRow(failing)).statement_attempts).toBe(SHIFT_STATEMENT_MAX_ATTEMPTS);
    await adminDataSource.query(`UPDATE core.payroll_record SET updated_at = now() - interval '1 hour' WHERE id = $1`, [failing]);
    expect((await dispatch()).claimed).toBe(0); // exhausted: no longer retried
    const mine = await http().get('/rest/v1/payroll/me/statements').set(auth(tokens.staff[2]!));
    expect(mine.body.data[0].statement).toMatchObject({ state: 'failed', fileId: null });
  });

  it('reconciliation: an approved record that never had a statement requested is picked up', async () => {
    const orphan = await approvedRecordFor(3);
    await adminDataSource.query(`UPDATE core.payroll_record SET statement_status = 'none' WHERE id = $1`, [orphan]); // e.g. approved before this pipeline
    const r = await dispatch();
    expect(r).toMatchObject({ claimed: 1, reconciledMissing: 1 });
    expect(await processShiftStatementJob(jobs.at(-1)!, deps())).toBe('generated');
    expect((await recordRow(orphan)).statement_status).toBe('generated');
  });

  it('with the agency payment calendar imported, the statement prints the real payroll period and official payday', async () => {
    const imp = await http().post('/rest/v1/payroll/calendar/import').set(auth(tokens.a)).send({
      year: OFFICIAL_CALENDAR_2026.year, source: OFFICIAL_CALENDAR_2026.source, notes: OFFICIAL_CALENDAR_2026.notes,
      periods: OFFICIAL_CALENDAR_2026.periods.map((p) => ({ start: p.start, end: p.end, payday: p.payday, ...(p.note ? { note: p.note } : {}) })),
    });
    expect(imp.status).toBe(200);
    const id = await approvedRecordFor(4);
    await dispatch();
    expect(jobs.at(-1)!.payrollRecordId).toBe(id);
    expect(await processShiftStatementJob(jobs.at(-1)!, deps())).toBe('generated');
    expect(lastHtml).toContain('12 Oct 2026 – 25 Oct 2026');
    expect(lastHtml).toContain('Wed, 4 Nov 2026');
    expect(lastHtml).not.toContain(TO_BE_CONFIRMED);
  });

  it('period attention: an ended period with records awaiting approval notifies the workspace owner once, and never prepares a run', async () => {
    await approvedRecordFor(5, false); // finalised, pending approval
    const first = await runPayrollPeriodAttentionCycle(adminDataSource, tenantContext, notifications, { organisationId: orgId, today: '2026-10-27' });
    expect(first.notified).toBe(1);
    const again = await runPayrollPeriodAttentionCycle(adminDataSource, tenantContext, notifications, { organisationId: orgId, today: '2026-10-27' });
    expect(again.notified).toBe(0);
    const notes = await adminDataSource.query(`SELECT user_id, title FROM core.notification WHERE type = 'payroll_period_attention' AND organisation_id = $1`, [orgId]);
    expect(notes).toEqual([{ user_id: a.userId, title: 'Payroll period ended with unfinished records' }]);
    expect(await adminDataSource.query(`SELECT 1 FROM core.payroll_run WHERE organisation_id = $1`, [orgId])).toEqual([]);
    // Before the period has ended nothing is sent.
    expect((await runPayrollPeriodAttentionCycle(adminDataSource, tenantContext, notifications, { organisationId: orgId, today: '2026-10-20' })).notified).toBe(0);
  });
});
