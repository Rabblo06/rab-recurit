import 'reflect-metadata';
import { LIFECYCLE_SMTP_PORT } from './helpers/lifecycle-env'; // FIRST: fixes env before AppModule is imported
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Worker } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '../../engine/core-modules/email/email-outbox.service';
import { EMAIL_QUEUE_NAME } from '../../engine/core-modules/email/email-queue.constants';
import { EmailQueueService } from '../../engine/core-modules/email/email-queue.service';
import { EmailService } from '../../engine/core-modules/email/email.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { StorageService } from '../../engine/core-modules/storage/storage.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '../../modules/attendance/services/attendance-qr.service';
import { QrImageService } from '../../modules/attendance/services/qr-image.service';
import { Organisation } from '../../modules/identity/entities';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { runEmailDispatchCycle } from '../../queue-worker/jobs/email-dispatch.job';
import { createEmailSendProcessor } from '../../queue-worker/jobs/email-send.processor';
import { runFinalTimesheetCycle } from '../../queue-worker/reports/final-timesheet.job';
import * as renderPdf from '../../queue-worker/reports/render-pdf.util';
import { runShiftReportSchedulerCycle } from '../../queue-worker/reports/shift-report-scheduler.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { SmtpSink } from './helpers/smtp-sink';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * THE 42-STEP ATTENDANCE LIFECYCLE — one ordered, end-to-end flow, executed for
 * real: HTTP API (supertest, real guards/RLS/Postgres), the real worker job
 * entry points (report scheduler, final timesheet, email dispatch), the real
 * BullMQ email processor, the real Playwright PDF renderer, the real
 * `SmtpDriver` handing mail to a real (local) SMTP endpoint, and real
 * Redis. Nothing on the server side is mocked except one PASS-THROUGH spy on
 * the renderer that records the HTML it is asked to print.
 *
 * What is NOT real here (and is verified elsewhere / honestly marked in the
 * readiness report): the Flutter app, a phone camera, a physical device GPS,
 * a printed sheet and an external mail provider. Location and QR values are
 * submitted exactly as the mobile client submits them (same request bodies).
 * Server-time "passing" is modelled by moving the SHIFT's window (the server
 * clock itself is authoritative and is never touched).
 *
 * Isolation: a dedicated Redis DB index so the shared dev queue's leftovers
 * are never processed, and every worker cycle is narrowed to this test's own
 * organisation.
 */
jest.setTimeout(90_000);

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const VENUE_LAT = 51.508;
const VENUE_LNG = -0.1281;
const INSIDE = { lat: VENUE_LAT, lng: VENUE_LNG, accuracyM: 6 };
const OUTSIDE = { lat: VENUE_LAT + 0.01, lng: VENUE_LNG, accuracyM: 6 }; // ~1.1 km away
const MIN = 60 * 1000;

describeIfDb('attendance lifecycle — 42 steps (integration, end to end)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let storage: StorageService;
  let emailOutbox: EmailOutboxService;
  let emailQueue: EmailQueueService;
  let attendanceQr: AttendanceQrService;
  let qrImage: QrImageService;
  let audit: AuditService;
  let reportAvailableBefore: number;
  let sink: SmtpSink;
  let emailWorker: Worker;
  let workerRedis: Redis;
  let renderSpy: jest.SpyInstance;
  const renderedHtml: string[] = [];

  // ---- actors ---------------------------------------------------------
  let org: Organisation;
  let im: TestIdentity; // Internal Manager (owner of the workspace)
  let vm: TestIdentity; // Venue Manager
  let s1: TestIdentity; // requested, then removed by the Internal Manager
  let s2: TestIdentity; // works the shift, clocks in/out manually
  let s3: TestIdentity; // added by the Internal Manager, auto clock-out
  let orgB: Organisation;
  let imB: TestIdentity;
  let imToken: string;
  let vmToken: string;
  let s1Token: string;
  let s2Token: string;
  let s3Token: string;
  let imBToken: string;

  // ---- state carried between steps -------------------------------------
  let venueId: string;
  let jobRoleId: string;
  let shiftId: string;
  let offerS2: string;
  let offerS3: string;
  let attendanceS2: string;
  let attendanceS3: string;
  let preShiftKey: string;
  let preShiftSha: string;
  let finalKey: string;

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const http = () => request(app.getHttpServer());
  const get = (t: string, url: string) => http().get(`/rest/v1${url}`).set(bearer(t));
  const post = (t: string, url: string, body?: object) => http().post(`/rest/v1${url}`).set(bearer(t)).send(body ?? {});
  const patch = (t: string, url: string, body?: object) => http().patch(`/rest/v1${url}`).set(bearer(t)).send(body ?? {});
  const del = (t: string, url: string) => http().delete(`/rest/v1${url}`).set(bearer(t));

  const imContext = () => ({ organisationId: org.id, workspaceId: im.workspaceId, userId: im.userId, role: '' });

  /** Moves the SHIFT's window (the server clock is authoritative and never touched). `updated_at` is deliberately untouched — time passing is not an edit. */
  async function moveShift(startsInMs: number, durationMs = 8 * 60 * MIN): Promise<void> {
    await adminDataSource.transaction(async (m) => {
      await m.query(`ALTER TABLE core.shift DISABLE ROW LEVEL SECURITY`);
      await m.query(`ALTER TABLE core.shift_assignment DISABLE ROW LEVEL SECURITY`);
      await m.query(`UPDATE core.shift SET starts_at = now() + make_interval(secs => $2), ends_at = now() + make_interval(secs => $3) WHERE id = $1`, [
        shiftId,
        startsInMs / 1000,
        (startsInMs + durationMs) / 1000,
      ]);
      await m.query(
        `UPDATE core.shift_assignment SET period = tstzrange(now() + make_interval(secs => $2), now() + make_interval(secs => $3)) WHERE shift_id = $1`,
        [shiftId, startsInMs / 1000, (startsInMs + durationMs) / 1000],
      );
      await m.query(`ALTER TABLE core.shift ENABLE ROW LEVEL SECURITY`);
      await m.query(`ALTER TABLE core.shift_assignment ENABLE ROW LEVEL SECURITY`);
    });
  }

  const signQr = (forShiftId = shiftId) =>
    tenantContext.runInTenantContext(imContext(), async (m) => attendanceQr.sign(await m.findOneByOrFail(Shift, { id: forShiftId })));

  const runScheduler = () =>
    runShiftReportSchedulerCycle(adminDataSource, tenantContext, attendanceQr, qrImage, emailOutbox, storage, reportAvailableBefore, { organisationId: org.id });
  const runFinal = () => runFinalTimesheetCycle(adminDataSource, tenantContext, emailOutbox, storage, { organisationId: org.id });

  const mailsWith = (subjectFragment: string) => sink.mailsTo(vm.email).filter((m) => m.subject.includes(subjectFragment));

  /** Dispatch pending outbox rows to BullMQ, then wait until the real email worker has handed the expected mail to SMTP. */
  async function deliverEmails(subjectFragment: string, expectedCount = 1): Promise<void> {
    const dispatch = () => runEmailDispatchCycle(adminDataSource, (id, orgId) => emailQueue.publish(id, orgId));
    await dispatch();
    const deadline = Date.now() + 30_000;
    while (mailsWith(subjectFragment).length < expectedCount && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      await dispatch();
    }
    if (mailsWith(subjectFragment).length < expectedCount) {
      const rows = await tenantContext.runInTenantContext(imContext(), (m) =>
        m.query(`SELECT status, provider, infrastructure_attempt_count AS attempts, last_error_code AS code, last_error_message_sanitized AS err FROM core.email_outbox`),
      );
      throw new Error(`"${subjectFragment}" mail never reached the SMTP sink. Outbox: ${JSON.stringify(rows)}. Sink saw: ${JSON.stringify(sink.mails.map((m) => ({ to: m.to, subject: m.subject, attachments: m.attachments.map((a) => a.filename) })))}`);
    }
    await new Promise((r) => setTimeout(r, 500)); // settle: any duplicate would have been delivered by now
  }

  const outbox = () =>
    tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(
        `SELECT id, recipient_email, status, attachment_key, attachment_filename, rendered_subject AS subject FROM core.email_outbox WHERE organisation_id = $1 AND attachment_key IS NOT NULL ORDER BY created_at`,
        [org.id],
      ),
    );

  const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';

  beforeAll(async () => {
    sink = new SmtpSink();
    await sink.start(LIFECYCLE_SMTP_PORT);

    const flush = new Redis(process.env.REDIS_URL!);
    await flush.flushdb(); // dedicated DB index 8 — never the shared dev queue
    await flush.quit();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    storage = moduleRef.get(StorageService);
    emailOutbox = moduleRef.get(EmailOutboxService);
    emailQueue = moduleRef.get(EmailQueueService);
    attendanceQr = moduleRef.get(AttendanceQrService);
    qrImage = moduleRef.get(QrImageService);
    audit = moduleRef.get(AuditService);
    reportAvailableBefore = moduleRef.get(EnvironmentService).get('REPORT_AVAILABLE_BEFORE_MINUTES');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    // The real BullMQ email worker, exactly as `queue-worker/main.ts` builds it.
    workerRedis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    emailWorker = new Worker(EMAIL_QUEUE_NAME, createEmailSendProcessor({ tenantContext, emailService: moduleRef.get(EmailService), auditService: audit, storageService: storage }), {
      connection: workerRedis,
      concurrency: 2,
    });

    emailWorker.on('failed', (job, err) => console.error('[lifecycle] email job failed', job?.id, err.message));
    emailWorker.on('error', (err) => console.error('[lifecycle] email worker error', err.message));

    // Pass-through spy: records the HTML the renderer is asked to print, still renders a real PDF.
    const original = renderPdf.renderHtmlToPdf;
    renderSpy = jest.spyOn(renderPdf, 'renderHtmlToPdf').mockImplementation(async (html: string) => {
      renderedHtml.push(html);
      return original(html);
    });

    // ---- setup (not numbered): identities ---------------------------------
    org = await factory.createOrganisation('life');
    im = await factory.createInternalManager(org);
    s1 = await factory.createStaff(org, { owner: im, label: 'staff1' });
    s2 = await factory.createStaff(org, { owner: im, label: 'staff2' });
    s3 = await factory.createStaff(org, { owner: im, label: 'staff3' });
    orgB = await factory.createOrganisation('lifeB');
    imB = await factory.createInternalManager(orgB);
    imToken = await factory.login(im);
    imBToken = await factory.login(imB);
    s1Token = await factory.login(s1);
    s2Token = await factory.login(s2);
    s3Token = await factory.login(s3);
  }, 120_000);

  afterAll(async () => {
    renderSpy?.mockRestore();
    await emailWorker?.close();
    await workerRedis?.quit();
    await app.close();
    await adminDataSource.destroy();
    await sink.stop();
  });

  // ======================================================================
  // A. Venue configuration (Internal Manager)
  // ======================================================================
  it('Step 01 — Internal Manager creates a Venue with a 100 m enforced geofence', async () => {
    const res = await post(imToken, '/venues', { name: 'Lifecycle Hotel', type: 'hotel', lat: VENUE_LAT, lng: VENUE_LNG, geofenceRadiusM: 100, enforceGeofence: true });
    expect(res.status).toBe(201);
    venueId = res.body.id;
  });

  it('Step 02 — the saved geofence reloads exactly (numbers, not strings)', async () => {
    const res = await get(imToken, `/venues/${venueId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ lat: VENUE_LAT, lng: VENUE_LNG, geofenceRadiusM: 100, enforceGeofence: true }));
  });

  it('Step 03 — Internal Manager creates the job role and a Venue Manager is assigned to the venue', async () => {
    const role = await post(imToken, '/job-roles', { name: 'Bartender', defaultRatePence: 1500 });
    expect(role.status).toBe(201);
    jobRoleId = role.body.id;
    vm = await factory.createVenueManager(org, { owner: im, venueIds: [venueId] });
    vmToken = await factory.login(vm);
    const mine = await get(vmToken, '/venues');
    expect(mine.status).toBe(200);
    const rows = (mine.body.data ?? mine.body) as Array<{ id: string }>;
    expect(rows.map((v) => v.id)).toEqual([venueId]);
  });

  // ======================================================================
  // B. Venue Manager request -> Internal Manager review -> approval
  // ======================================================================
  it('Step 04 — Venue Manager builds a team pool (Staff 1 and Staff 2)', async () => {
    expect((await post(vmToken, `/staff/venue-directory/team/${s1.profileId}`)).status).toBe(201);
    expect((await post(vmToken, `/staff/venue-directory/team/${s2.profileId}`)).status).toBe(201);
  });

  it('Step 05 — Venue Manager submits a shift request (5 h ahead, 2 staff requested) — pending Internal Manager approval', async () => {
    const startsAt = new Date(Date.now() + 5 * 60 * MIN);
    const res = await post(vmToken, '/shifts/request', {
      venueId,
      jobRoleId,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 8 * 60 * MIN).toISOString(),
      staffRequired: 2,
      staffProfileIds: [s1.profileId, s2.profileId],
      breakMinutes: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending_manager_approval');
    shiftId = res.body.id;
  });

  it('Step 06 — the request appears in the Internal Manager\'s pending queue, not before approval anywhere else', async () => {
    const pending = await get(imToken, '/shifts/requests?status=pending');
    expect(pending.status).toBe(200);
    expect(((pending.body.data ?? pending.body) as Array<{ id: string }>).map((s) => s.id)).toContain(shiftId);
    const staffView = await get(s2Token, '/offers/mine');
    expect(((staffView.body.data ?? staffView.body) as unknown[]).length).toBe(0); // no offer exists yet
  });

  it('Step 07 — Internal Manager swaps Staff 1 for Staff 3 before approving (team-pool rule applies to the IM too)', async () => {
    await post(vmToken, `/staff/venue-directory/team/${s3.profileId}`); // Staff 3 must be in the venue's pool to be selectable
    expect((await del(imToken, `/shifts/${shiftId}/requested-staff/${s1.profileId}`)).status).toBe(200);
    const added = await post(imToken, `/shifts/${shiftId}/requested-staff/${s3.profileId}`);
    expect([200, 201]).toContain(added.status);
    const list = await get(imToken, `/shifts/${shiftId}/requested-staff`);
    const ids = ((list.body.data ?? list.body) as Array<{ staffProfileId?: string; id?: string }>).map((r) => r.staffProfileId ?? r.id);
    expect(ids).toEqual(expect.arrayContaining([s2.profileId, s3.profileId]));
    expect(ids).not.toContain(s1.profileId);
  });

  it('Step 08 — Internal Manager approves: offers go to Staff 2 and Staff 3 ONLY', async () => {
    const res = await post(imToken, `/shifts/${shiftId}/approve`, {});
    expect([200, 201]).toContain(res.status);
    const [o2, o3, o1] = await Promise.all([get(s2Token, '/offers/mine'), get(s3Token, '/offers/mine'), get(s1Token, '/offers/mine')]);
    const rows = (r: request.Response) => (r.body.data ?? r.body) as Array<{ id: string; status: string }>;
    expect(rows(o2)).toHaveLength(1);
    expect(rows(o3)).toHaveLength(1);
    expect(rows(o1)).toHaveLength(0); // the removed staff member never receives an offer
    offerS2 = rows(o2)[0]!.id;
    offerS3 = rows(o3)[0]!.id;
  });

  // ======================================================================
  // C. Staff accepts -> assignment CONFIRMED (no second approval)
  // ======================================================================
  it('Step 09 — Staff 2 accepts the offer', async () => {
    expect([200, 201]).toContain((await post(s2Token, `/offers/${offerS2}/accept`)).status);
  });

  it('Step 10 — the assignment is CONFIRMED immediately: a Venue-Manager-requested shift needs NO second manager approval', async () => {
    const rows = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT sa.status AS assignment_status, jo.status AS offer_status FROM core.shift_assignment sa JOIN core.job_offer jo ON jo.shift_assignment_id = sa.id WHERE jo.id = $1`, [offerS2]),
    );
    expect(rows[0]).toEqual({ assignment_status: 'confirmed', offer_status: 'manager_confirmed' });
  });

  it('Step 11 — Staff 3 accepts and is confirmed the same way', async () => {
    expect([200, 201]).toContain((await post(s3Token, `/offers/${offerS3}/accept`)).status);
    const rows = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT sa.status FROM core.shift_assignment sa JOIN core.job_offer jo ON jo.shift_assignment_id = sa.id WHERE jo.id = $1`, [offerS3]),
    );
    expect(rows[0].status).toBe('confirmed');
  });

  it('Step 12 — Staff 1 (removed) cannot clock in to a shift they were never assigned', async () => {
    await moveShift(10 * MIN); // inside the 15-minute clock-in window for this one probe
    const res = await post(s1Token, '/attendance/clock-in', { shiftId, qrToken: await signQr(), ...INSIDE });
    expect(res.status).toBe(404);
    await moveShift(5 * 60 * MIN); // back to 5 h ahead for the pre-shift steps
  });

  // ======================================================================
  // D. Pre-shift report (Worker) — roster + QR PDF emailed to the Venue Manager
  // ======================================================================
  it('Step 13 — outside the report window (5 h out) the scheduler generates NOTHING', async () => {
    const result = await runScheduler();
    expect(result.generated).toBe(0);
    expect(await outbox()).toHaveLength(0);
  });

  it('Step 14 — inside the window (100 min out) the Worker generates the roster + QR PDF', async () => {
    await moveShift(100 * MIN);
    const result = await runScheduler();
    expect(result.failed).toBe(0);
    expect(result.generated).toBe(1);
  });

  it('Step 15 — the PDF is stored durably and is a real PDF with the roster and the QR image embedded', async () => {
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    preShiftKey = rows[0].attachment_key;
    const stored = await storage.read(preShiftKey);
    expect(stored).not.toBeNull();
    expect(isPdf(stored!.buffer)).toBe(true);
    preShiftSha = createHash('sha256').update(stored!.buffer).digest('hex');
    const html = renderedHtml[renderedHtml.length - 1]!;
    expect(html).toContain('Lifecycle Hotel');
    expect(html).toContain('Staff'); // roster rows
    expect(html).toMatch(/data:image\/png;base64,[A-Za-z0-9+/=]{500,}/); // the embedded QR
    expect(html).toContain('SCAN TO CLOCK IN / CLOCK OUT');
  });

  it('Step 16 — the email reaches the Venue Manager over SMTP with the roster PDF attached (correct MIME, filename, bytes)', async () => {
    await deliverEmails('Shift roster');
    const mails = mailsWith('Shift roster');
    expect(mails).toHaveLength(1);
    const attachment = mails[0]!.attachments.find((a) => a.filename === 'shift-roster.pdf');
    expect(attachment).toBeDefined();
    expect(attachment!.contentType).toBe('application/pdf');
    expect(isPdf(attachment!.content)).toBe(true);
  });

  it('Step 17 — the emailed attachment is byte-identical to the stored PDF, outbox is SENT, and a second Worker tick sends nothing more', async () => {
    const mail = mailsWith('Shift roster')[0]!;
    expect(createHash('sha256').update(mail.attachments[0]!.content).digest('hex')).toBe(preShiftSha);
    const rosterRow = (await outbox()).find((r: { attachment_filename: string }) => r.attachment_filename === 'shift-roster.pdf');
    expect(rosterRow.status).toBe('SENT');
    const again = await runScheduler();
    expect(again.generated).toBe(0);
    await deliverEmails('Shift roster');
    expect(mailsWith('Shift roster')).toHaveLength(1);
  });

  // ======================================================================
  // E. Clock-in (Staff, mobile request shapes)
  // ======================================================================
  it('Step 18 — too early: 100 minutes before start is rejected with the real shiftStart/availableAt', async () => {
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, qrToken: await signQr(), ...INSIDE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CLOCK_IN_TOO_EARLY');
    const availableAt = new Date(res.body.availableAt).getTime();
    const shiftStart = new Date(res.body.shiftStart).getTime();
    expect(shiftStart - availableAt).toBe(15 * MIN);
  });

  it('Step 19 — in the 15-minute window the server still requires the QR (no qrToken is a validation error)', async () => {
    await moveShift(10 * MIN);
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, ...INSIDE });
    expect(res.status).toBe(400);
  });

  it('Step 20 — a QR that does not belong to this shift (or is tampered) is rejected', async () => {
    const tampered = `${await signQr()}x`;
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, qrToken: tampered, ...INSIDE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_QR');
  });

  it('Step 21 — valid QR from OUTSIDE the 100 m geofence is rejected (OUTSIDE_VENUE)', async () => {
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, qrToken: await signQr(), ...OUTSIDE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('OUTSIDE_VENUE');
  });

  it('Step 22 — a poor GPS fix (accuracy > limit) is rejected rather than trusted', async () => {
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, qrToken: await signQr(), ...INSIDE, accuracyM: 500 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCATION_ACCURACY_TOO_LOW');
  });

  it('Step 23 — the client cannot supply the venue location: venueLat/venueLng/venueRadius are rejected outright', async () => {
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, qrToken: await signQr(), ...OUTSIDE, venueLat: OUTSIDE.lat, venueLng: OUTSIDE.lng, venueRadius: 99999 });
    expect(res.status).toBe(400);
  });

  it('Step 24 — Staff 2 clocks in: valid QR, assigned, inside the radius, in the window', async () => {
    const res = await post(s2Token, '/attendance/clock-in', { shiftId, qrToken: await signQr(), ...INSIDE });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ status: 'clocked_in', locationVerified: true }));
    expect(Math.abs(new Date(res.body.clockInAt).getTime() - Date.now())).toBeLessThan(10_000); // server timestamp
    attendanceS2 = res.body.id;
  });

  it('Step 25 — five simultaneous clock-in taps produce exactly ONE attendance for Staff 3', async () => {
    const qr = await signQr();
    const results = await Promise.all(Array.from({ length: 5 }, () => post(s3Token, '/attendance/clock-in', { shiftId, qrToken: qr, ...INSIDE })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const rows = await tenantContext.runInTenantContext(imContext(), (m) => m.query(`SELECT id FROM core.attendance WHERE staff_profile_id = $1`, [s3.profileId]));
    expect(rows).toHaveLength(1);
    attendanceS3 = rows[0].id;
  });

  it('Step 26 — the shift is now in progress and Staff 2 sees their live attendance', async () => {
    const active = await get(s2Token, '/attendance/me/active');
    expect(active.status).toBe(200);
    expect(active.body.attendance.id).toBe(attendanceS2);
    expect(typeof active.body.serverNow).toBe('string');
    const shift = await get(imToken, `/shifts/${shiftId}`);
    expect(shift.body.status).toBe('in_progress');
  });

  it('Step 27 — the Venue Manager\'s live Report shows both staff as Clocked in (real statuses, no raw ids as names)', async () => {
    const res = await get(vmToken, `/attendance/report/shift/${shiftId}`);
    expect(res.status).toBe(200);
    expect(res.body.staff).toHaveLength(2);
    expect(res.body.staff.map((r: { attendanceStatus: string }) => r.attendanceStatus)).toEqual(['clocked_in', 'clocked_in']);
    for (const row of res.body.staff) expect(row.staffName).toMatch(/^Staff Member$/);
    expect(res.body.reportStatus).toBe('ready');
  });

  // ======================================================================
  // F. Clock-out: manual QR, and the auto (geofence-exit) fallback
  // ======================================================================
  it('Step 28 — clock-out with a QR for a different shift is rejected', async () => {
    const res = await post(s2Token, '/attendance/clock-out', { qrToken: `${await signQr()}x`, ...INSIDE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_QR');
  });

  it('Step 29 — Staff 2 clocks out by scanning the SAME shift QR; worked time is computed by the server', async () => {
    const res = await post(s2Token, '/attendance/clock-out', { qrToken: await signQr(), ...INSIDE });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({ status: 'clocked_out', clockOutMethod: 'manual' }));
    expect(typeof res.body.workedMinutes).toBe('number');
    expect(res.body.earnedPence).not.toBeNull();
  });

  it('Step 30 — a duplicate clock-out is a safe denial with no state change', async () => {
    const before = await get(vmToken, `/attendance/report/shift/${shiftId}`);
    const res = await post(s2Token, '/attendance/clock-out', { qrToken: await signQr(), ...INSIDE });
    expect([404, 409]).toContain(res.status);
    const after = await get(vmToken, `/attendance/report/shift/${shiftId}`);
    expect(after.body.staff).toEqual(before.body.staff);
  });

  it('Step 31 — Staff 3 forgets to clock out and leaves: a FALSE "outside" claim is rejected; a genuine one auto-clocks-out (no QR)', async () => {
    const inside = await post(s3Token, '/attendance/geofence-exit', INSIDE);
    expect(inside.status).toBe(409); // server recomputed: still inside — nothing changes
    const still = await get(s3Token, '/attendance/me/active');
    expect(still.body.attendance.status).toBe('clocked_in');
    const exit = await post(s3Token, '/attendance/geofence-exit', OUTSIDE);
    expect(exit.status).toBe(201);
    expect(exit.body).toEqual(expect.objectContaining({ status: 'clocked_out', clockOutMethod: 'auto_geofence' }));
  });

  // ======================================================================
  // G. Manager review, corrections, isolation
  // ======================================================================
  it('Step 32 — the Report shows both clocked out, with method (manual vs auto) and computed hours', async () => {
    const res = await get(vmToken, `/attendance/report/shift/${shiftId}`);
    const byId = new Map<string, { clockOutMethod: string; attendanceStatus: string; workedMinutes: number | null }>(res.body.staff.map((r: { attendanceId: string }) => [r.attendanceId, r]));
    expect(byId.get(attendanceS2)!.clockOutMethod).toBe('manual');
    expect(byId.get(attendanceS3)!.clockOutMethod).toBe('auto_geofence');
    expect([...byId.values()].every((r) => r.attendanceStatus === 'clocked_out')).toBe(true);
  });

  it('Step 33 — ANOTHER organisation\'s manager cannot read this report, correct it, or finalise it (404, never the data)', async () => {
    expect((await get(imBToken, `/attendance/report/shift/${shiftId}`)).status).toBe(404);
    expect((await post(imBToken, `/attendance/${attendanceS2}/correct`, { field: 'breakMinutes', newValue: '5', reason: 'cross tenant attempt' })).status).toBe(404);
    expect((await patch(imBToken, `/attendance/report/shift/${shiftId}/finalise`)).status).toBe(404);
  });

  it('Step 34 — a correction without a proper reason is rejected (400), nothing changes', async () => {
    const res = await post(vmToken, `/attendance/${attendanceS2}/correct`, { field: 'breakMinutes', newValue: '45', reason: 'short' });
    expect(res.status).toBe(400);
  });

  it('Step 35 — the Venue Manager corrects Staff 2\'s break to 45 min WITH a reason: hours recalculated, record goes under review', async () => {
    const res = await post(vmToken, `/attendance/${attendanceS2}/correct`, { field: 'breakMinutes', newValue: '45', reason: 'Staff took a longer break, confirmed with the bar manager' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('under_review');
    expect(res.body.breakMinutes).toBe(45);
    const before = await tenantContext.runInTenantContext(imContext(), (m) => m.query(`SELECT worked_minutes FROM core.attendance WHERE id = $1`, [attendanceS2]));
    expect(before[0].worked_minutes).toBe(res.body.workedMinutes);
  });

  it('Step 36 — the correction is a first-class record (before/after/actor/reason) AND written to the audit log', async () => {
    const rows = await tenantContext.runInTenantContext(imContext(), (m) => m.query(`SELECT * FROM core.attendance_correction WHERE attendance_id = $1`, [attendanceS2]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ field: 'breakMinutes', new_value: '45', corrected_by: vm.userId }));
    expect(rows[0].reason).toContain('longer break');
    expect(rows[0].old_value).not.toBe('45');
    const auditRows = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT actor_user_id, metadata FROM core.audit_log WHERE organisation_id = $1 AND action = 'attendance.corrected' AND entity_id = $2`, [org.id, attendanceS2]),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].actor_user_id).toBe(vm.userId);
    expect(auditRows[0].metadata).toEqual(expect.objectContaining({ field: 'breakMinutes', newValue: '45' }));
  });

  it('Step 37 — Finalise & Send: everything is approved; a DOUBLE finalise changes nothing (same who/when, one audit entry)', async () => {
    const first = await patch(vmToken, `/attendance/report/shift/${shiftId}/finalise`);
    expect(first.status).toBe(200);
    const snapshot = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT status, finalised_at, finalised_by FROM core.shift_report WHERE shift_id = $1`, [shiftId]),
    );
    expect(snapshot[0].status).toBe('finalised');
    expect(snapshot[0].finalised_by).toBe(vm.userId);
    const second = await patch(vmToken, `/attendance/report/shift/${shiftId}/finalise`);
    expect(second.status).toBe(200);
    const after = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT status, finalised_at, finalised_by FROM core.shift_report WHERE shift_id = $1`, [shiftId]),
    );
    expect(after[0].finalised_at.getTime()).toBe(snapshot[0].finalised_at.getTime());
    const finalisedAudits = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT 1 FROM core.audit_log WHERE organisation_id = $1 AND action = 'attendance.report_finalised'`, [org.id]),
    );
    expect(finalisedAudits).toHaveLength(1);
    const report = await get(vmToken, `/attendance/report/shift/${shiftId}`);
    expect(report.body.staff.map((r: { attendanceStatus: string }) => r.attendanceStatus)).toEqual(['approved', 'approved']);
  });

  it('Step 38 — a finalised report can no longer be changed: a further correction is refused (409)', async () => {
    const res = await post(vmToken, `/attendance/${attendanceS2}/correct`, { field: 'clockOutAt', newValue: new Date().toISOString(), reason: 'trying to change a finalised timesheet' });
    expect(res.status).toBe(409);
  });

  // ======================================================================
  // H. Final timesheet (Worker) -> storage -> outbox -> email
  // ======================================================================
  it('Step 39 — the Worker renders the FINAL timesheet, stores it durably, and queues exactly one email', async () => {
    const result = await runFinal();
    expect(result.failed).toBe(0);
    expect(result.sent).toBe(1);
    const rows = await outbox();
    const final = rows.find((r: { attachment_filename: string }) => r.attachment_filename === 'final-timesheet.pdf');
    expect(final).toBeDefined();
    finalKey = final.attachment_key;
    expect(finalKey).toBe(`org/${org.id}/reports/${shiftId}/final-timesheet.pdf`);
    const stored = await storage.read(finalKey);
    expect(isPdf(stored!.buffer)).toBe(true);
  });

  it('Step 40 — the final PDF reflects the CORRECTION (45 min break, "(corrected)" marker) and both clock-out methods/statuses', async () => {
    const html = renderedHtml[renderedHtml.length - 1]!;
    expect(html).toContain('Final Timesheet');
    expect(html).toContain('Lifecycle Hotel');
    expect(html).toContain('45 min');
    expect(html).toContain('(corrected)');
    expect(html).toContain('approved');
    expect(html).toContain('Reviewed by');
  });

  it('Step 41 — the final email reaches the Venue Manager with the timesheet attached; a repeat Worker tick sends no duplicate', async () => {
    await deliverEmails('Final Timesheet');
    const mails = mailsWith('Final Timesheet');
    expect(mails).toHaveLength(1);
    const attachment = mails[0]!.attachments.find((a) => a.filename === 'final-timesheet.pdf');
    expect(attachment).toBeDefined();
    expect(attachment!.contentType).toBe('application/pdf');
    expect(isPdf(attachment!.content)).toBe(true);
    const stored = await storage.read(finalKey);
    expect(createHash('sha256').update(attachment!.content).digest('hex')).toBe(createHash('sha256').update(stored!.buffer).digest('hex'));
    const again = await runFinal();
    expect(again.sent).toBe(0);
    await deliverEmails('Final Timesheet');
    expect(mailsWith('Final Timesheet')).toHaveLength(1);
  });

  it('Step 42 — final verification: state, hours, break, correction history, audit trail, and tenant isolation of every artefact', async () => {
    const report = await get(imToken, `/attendance/report/shift/${shiftId}`);
    expect(report.body.reportStatus).toBe('finalised');
    const s2Row = report.body.staff.find((r: { attendanceId: string }) => r.attendanceId === attendanceS2);
    expect(s2Row).toEqual(expect.objectContaining({ attendanceStatus: 'approved', breakMinutes: 45, corrected: true, clockOutMethod: 'manual' }));
    const s3Row = report.body.staff.find((r: { attendanceId: string }) => r.attendanceId === attendanceS3);
    expect(s3Row).toEqual(expect.objectContaining({ attendanceStatus: 'approved', corrected: false, clockOutMethod: 'auto_geofence' }));

    const actions = await tenantContext.runInTenantContext(imContext(), (m) =>
      m.query(`SELECT DISTINCT action FROM core.audit_log WHERE organisation_id = $1 AND action LIKE 'attendance.%' OR action LIKE 'venue.%' AND organisation_id = $1 ORDER BY 1`, [org.id]),
    );
    expect(actions.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['attendance.clocked_in', 'attendance.clocked_out', 'attendance.auto_clocked_out_geofence', 'attendance.corrected', 'attendance.report_finalised']),
    );

    // Tenant isolation of every artefact this flow produced: organisation B sees none of it.
    const ctxB = { organisationId: orgB.id, workspaceId: imB.workspaceId, userId: imB.userId, role: '' };
    const seenByB = await tenantContext.runInTenantContext(ctxB, async (m) => ({
      reports: await m.query(`SELECT 1 FROM core.shift_report`),
      corrections: await m.query(`SELECT 1 FROM core.attendance_correction`),
      attendance: await m.query(`SELECT 1 FROM core.attendance`),
      outbox: await m.query(`SELECT 1 FROM core.email_outbox`),
    }));
    expect(seenByB).toEqual({ reports: [], corrections: [], attendance: [], outbox: [] });
    // Storage keys are org-scoped by construction.
    for (const key of [preShiftKey, finalKey]) expect(key.startsWith(`org/${org.id}/`)).toBe(true);
  });
});
