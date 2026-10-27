import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EmailOutboxJobType } from '@rab/shared';
import type { Job } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { runFinalTimesheetCycle } from '../../queues/rab-reports/final-timesheet.job';
import { runShiftReportSchedulerCycle } from '../../queues/rab-reports/shift-report-scheduler.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * REPORT EMAIL SAFETY (Phase 0 "Report emails"). The pre-shift roster PDF carries a signed Shift QR clock-in token and
 * other people's names; the final timesheet carries attendance evidence. Both go out as NOTIFICATION emails with the
 * PDF attached. Abuse cases covered, against the real jobs, the real send processor, the real database (FORCE RLS) and
 * the real Playwright renderer — only the email PROVIDER is a mock, so "0 provider calls" is directly observable.
 *
 * Every access-loss case changes exactly ONE predicate, so each rule is proven on its own:
 * user status only, workspace membership only (suspended / removed), manager profile archived only, organisation
 * membership revoked only, `report.view` revoked by override only, venue assignment removed only, user soft-deleted
 * only, organisation suspended only — at enqueue time, and (for the ones that change after enqueue) at send time.
 * Runs with HWS routing OFF (the test database's configuration); report-email-recipient-safety-hws covers HWS ON.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const HOSTILE_VENUE = 'Bar <script>alert("x")</script> & <img src=x onerror=alert(1)>\r\nBcc: attacker@example.test\r\n\r\n<b>bold</b>';
/** What the venue name must become: one line (CR/LF runs collapsed to one space), nothing else changed. */
const HOSTILE_VENUE_ONE_LINE = 'Bar <script>alert("x")</script> & <img src=x onerror=alert(1)> Bcc: attacker@example.test <b>bold</b>';
/** Independent HTML-escape oracle (deliberately not the production helper). */
const oracleEscape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface Fixture {
  organisation: Organisation;
  owner: TestIdentity;
  workspaceId: string;
  venueId: string;
  shiftId: string;
}
type Base = Omit<Fixture, 'shiftId'>;

interface OutboxRow {
  id: string;
  recipient_email: string;
  target_user_id: string | null;
  job_type: string;
  rendered_subject: string;
  rendered_html: string | null;
  rendered_text: string | null;
  attachment_file_id: string | null;
  attachment_filename: string | null;
  status: string;
  last_error_code: string | null;
}

describeIfDb('report emails: escaping, recipient eligibility and send-time re-check (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let storage: FileService;
  let emailOutbox: EmailOutboxService;
  let attendanceQr: AttendanceQrService;
  let qrImage: QrImageService;
  let audit: AuditService;
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
    audit = moduleRef.get(AuditService);
    reportAvailableBefore = moduleRef.get(EnvironmentService).get('REPORT_AVAILABLE_BEFORE_MINUTES');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  // ------------------------------------------------------------------ fixture helpers

  const ownerCtx = (f: Pick<Fixture, 'organisation' | 'owner' | 'workspaceId'>) => ({
    organisationId: f.organisation.id,
    workspaceId: f.workspaceId,
    userId: f.owner.userId,
    role: '',
  });

  async function seedOrg(venueName: string): Promise<Base> {
    const organisation = await factory.createOrganisation('rptsafe');
    const owner = await factory.createInternalManager(organisation);
    const workspaceId = owner.workspaceId!;
    const venue = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: owner.userId, role: '' },
      (m) => m.save(Venue, { organisationId: organisation.id, name: venueName, createdBy: owner.userId, workspaceId }),
    );
    return { organisation, owner, workspaceId, venueId: venue.id };
  }

  /** One staff member CONFIRMED on a shift starting in an hour at the fixture venue. */
  async function seedShift(f: Base): Promise<string> {
    const staff = await factory.createStaff(f.organisation, { owner: f.owner });
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    return tenantContext.runInTenantContext(ownerCtx(f), async (m) => {
      const jobRole = await m.save(JobRole, {
        organisationId: f.organisation.id,
        name: `Role ${randomUUID().slice(0, 6)}`,
        defaultRatePence: 1500,
        createdBy: f.owner.userId,
        workspaceId: f.workspaceId,
      });
      const shift = await m.save(Shift, {
        organisationId: f.organisation.id,
        venueId: f.venueId,
        jobRoleId: jobRole.id,
        startsAt,
        endsAt,
        breakMinutes: 30,
        requiredCount: 1,
        payRatePence: 1500,
        status: 'open',
        createdBy: f.owner.userId,
        workspaceId: f.workspaceId,
      });
      await m.save(ShiftAssignment, {
        organisationId: f.organisation.id,
        shiftId: shift.id,
        staffProfileId: staff.profileId!,
        status: 'confirmed',
        payRateSnapshotPence: 1500,
        assignedBy: f.owner.userId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId: f.workspaceId,
      });
      return shift.id;
    });
  }

  const venueManager = (f: Base, label: string) => factory.createVenueManager(f.organisation, { owner: f.owner, venueIds: [f.venueId], label });

  // One predicate each. Account-level writes use the owner's tenant context (the same rows the services write);
  // tables whose RLS only lets the member/owner write them use the fixture owner connection.

  /** ManagerService.setActive(false) does BOTH of the next two; each is also tested alone. */
  const deactivate = async (f: Base, userId: string) => {
    await suspendUserStatusOnly(f, userId);
    await suspendWorkspaceMembershipOnly(f, userId);
  };
  const suspendUserStatusOnly = (f: Base, userId: string) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [userId]));
  const suspendWorkspaceMembershipOnly = (f: Base, userId: string) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`SELECT core.suspend_workspace_membership($1)`, [userId]));
  const removeWorkspaceMembershipOnly = (userId: string) =>
    adminDataSource.query(`UPDATE core.workspace_membership SET status = 'removed', updated_at = now() WHERE user_id = $1`, [userId]);
  const archiveProfileOnly = (f: Base, vm: TestIdentity) =>
    adminDataSource.query(`UPDATE core.manager_profile SET archived_at = now(), archived_by = $2 WHERE id = $1`, [vm.profileId, f.owner.userId]);
  const revokeOrganisationMemberOnly = (f: Base, userId: string) =>
    adminDataSource.query(
      `INSERT INTO core.organisation_member (organisation_id, user_id, status) VALUES ($1, $2, 'revoked')
       ON CONFLICT (user_id, organisation_id) DO UPDATE SET status = 'revoked', updated_at = now()`,
      [f.organisation.id, userId],
    );
  /** A per-user REVOKE override — what PermissionsService resolves before the role grant. */
  const revokeReportViewOnly = (f: Base, userId: string) =>
    adminDataSource.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, p.id, $2, 'revoke' FROM core.permission p WHERE p.key = 'report.view'`,
      [userId, f.organisation.id],
    );
  /** The same write ManagerService.unassignVenue makes. */
  const unassignOnly = (f: Base, vm: TestIdentity) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) =>
      m.query(`DELETE FROM core.manager_venue WHERE manager_profile_id = $1 AND venue_id = $2`, [vm.profileId, f.venueId]),
    );
  const softDeleteOnly = (f: Base, userId: string) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`UPDATE core."user" SET deleted_at = now() WHERE id = $1`, [userId]));
  const suspendOrganisation = (f: Base) =>
    adminDataSource.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'test' WHERE id = $1`, [
      f.organisation.id,
      f.owner.userId,
    ]);

  const finalise = (f: Fixture) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) =>
      m.query(`UPDATE core.shift_report SET status = 'finalised', finalised_at = now(), finalised_by = $2 WHERE shift_id = $1`, [f.shiftId, f.owner.userId]),
    );

  const runScheduler = (f: Fixture) =>
    runShiftReportSchedulerCycle(adminDataSource, tenantContext, attendanceQr, qrImage, emailOutbox, storage, reportAvailableBefore, {
      organisationId: f.organisation.id,
      audit,
    });
  const runFinal = (f: Fixture) => runFinalTimesheetCycle(adminDataSource, tenantContext, emailOutbox, storage, { organisationId: f.organisation.id, audit });

  /** Roster + finalise + final timesheet: the two report emails, end to end. */
  async function produceBothReports(f: Fixture) {
    expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
    await finalise(f);
    expect(await runFinal(f)).toMatchObject({ sent: 1, failed: 0 });
  }

  const SELECT_ROW = `SELECT id, recipient_email, target_user_id, job_type, rendered_subject, rendered_html, rendered_text, attachment_file_id,
                             attachment_filename, status, last_error_code FROM core.email_outbox`;
  const reportRows = (f: Fixture): Promise<OutboxRow[]> =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) =>
      m.query(`${SELECT_ROW} WHERE organisation_id = $1 AND attachment_file_id IS NOT NULL ORDER BY created_at, id`, [f.organisation.id]),
    );
  const outboxRow = (f: Fixture, id: string): Promise<OutboxRow> =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`${SELECT_ROW} WHERE id = $1`, [id])).then((rows: OutboxRow[]) => rows[0]!);

  const storedReport = (f: Fixture) =>
    tenantContext
      .runInTenantContext(ownerCtx(f), (m) =>
        m.query(`SELECT pre_shift_file_id, original_file_id, final_file_id, final_pdf_sent_at FROM core.shift_report WHERE shift_id = $1`, [f.shiftId]),
      )
      .then((rows: Array<Record<string, unknown>>) => rows[0]);

  const readStoredFile = async (f: Fixture, fileId: string): Promise<Buffer> => {
    const file = await tenantContext.runInTenantContext(ownerCtx(f), (m) => storage.findAvailable(m, fileId));
    expect(file).not.toBeNull();
    return storage.readVerified(file!);
  };

  /** The real send processor with a MOCK provider: every provider call is recorded, nothing leaves the process. */
  function processorWithMockProvider() {
    const sends: Array<{ to: string; subject: string; html?: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
    const send = jest.fn(async (opts: (typeof sends)[number]) => {
      sends.push(opts);
      return { provider: 'test-mock', providerMessageId: randomUUID() };
    });
    const process = createEmailSendProcessor({ tenantContext, emailService: { send } as unknown as EmailService, auditService: audit, fileService: storage });
    const run = (organisationId: string, emailOutboxId: string) =>
      process({ data: { emailOutboxId, organisationId }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<EmailQueueJobData>);
    return { send, sends, run };
  }

  async function expectCancelledWithoutProviderCall(f: Fixture, rows: OutboxRow[]) {
    const { sends, run } = processorWithMockProvider();
    for (const row of rows) await run(f.organisation.id, row.id);
    expect(sends).toHaveLength(0);
    for (const row of rows) {
      const after = await outboxRow(f, row.id);
      expect(after.status).toBe('CANCELLED');
      expect(after.last_error_code).toBe('REPORT_RECIPIENT_INELIGIBLE');
    }
  }

  // ------------------------------------------------------------------ enqueue time

  describe('at enqueue time (roster + final timesheet)', () => {
    let f: Fixture;
    let active: TestIdentity;
    const excluded: Record<string, TestIdentity> = {};
    let allRows: OutboxRow[];
    let rosterRows: OutboxRow[];

    beforeAll(async () => {
      const base = await seedOrg(HOSTILE_VENUE);
      active = await venueManager(base, 'active');
      for (const label of ['deactivated', 'statusonly', 'wsmsuspended', 'wsmremoved', 'archived', 'orgrevoked', 'noreportview', 'unassigned', 'deleted']) {
        excluded[label] = await venueManager(base, label);
      }
      f = { ...base, shiftId: await seedShift(base) };

      await deactivate(f, excluded.deactivated!.userId);
      await suspendUserStatusOnly(f, excluded.statusonly!.userId);
      await suspendWorkspaceMembershipOnly(f, excluded.wsmsuspended!.userId);
      await removeWorkspaceMembershipOnly(excluded.wsmremoved!.userId);
      await archiveProfileOnly(f, excluded.archived!);
      await revokeOrganisationMemberOnly(f, excluded.orgrevoked!.userId);
      await revokeReportViewOnly(f, excluded.noreportview!.userId);
      await unassignOnly(f, excluded.unassigned!);
      await softDeleteOnly(f, excluded.deleted!.userId);

      expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
      rosterRows = await reportRows(f);
      await finalise(f);
      expect(await runFinal(f)).toMatchObject({ sent: 1, failed: 0 });
      allRows = await reportRows(f);
    }, 300_000);

    it('1. the HTML is exactly the template with the venue escaped (no other tag survives); subject and text are one line', () => {
      const roster = allRows.find((r) => r.attachment_filename === 'shift-attendance-sheet.pdf')!;
      const final = allRows.find((r) => r.attachment_filename === 'final-timesheet.pdf')!;
      expect(roster.rendered_html).toBe(`<p>Your shift attendance sheet with the Shift QR for ${oracleEscape(HOSTILE_VENUE_ONE_LINE)} is attached.</p>`);
      expect(final.rendered_html).toBe(`<p>Your finalised timesheet for ${oracleEscape(HOSTILE_VENUE_ONE_LINE)} is attached.</p>`);
      expect(roster.rendered_subject).toBe(`Shift attendance sheet & QR — ${HOSTILE_VENUE_ONE_LINE}`);
      expect(final.rendered_subject).toBe(`Final Timesheet — ${HOSTILE_VENUE_ONE_LINE}`);
      expect(roster.rendered_text).toBe(`Your shift attendance sheet with the Shift QR for ${HOSTILE_VENUE_ONE_LINE} is attached.`);
      for (const row of [roster, final]) {
        expect(row.rendered_html!.match(/<[^>]*>/g)).toEqual(['<p>', '</p>']); // the only real tags are the template's own
        for (const value of [row.rendered_subject, row.rendered_text!, row.rendered_html!]) {
          expect(value).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
        }
        expect(Array.from(row.rendered_subject).length).toBeLessThanOrEqual(200);
      }
    });

    it('2. only the eligible co-manager gets the roster and the timesheet', () => {
      expect(allRows).toHaveLength(2);
      expect(rosterRows.map((r) => r.target_user_id)).toEqual([active.userId]);
      expect(allRows.every((r) => r.target_user_id === active.userId && r.recipient_email === active.email && r.job_type === EmailOutboxJobType.NOTIFICATION)).toBe(true);
      expect(allRows.map((r) => r.attachment_filename).sort()).toEqual(['final-timesheet.pdf', 'shift-attendance-sheet.pdf']);
    });

    it.each([
      ['deactivated (status + membership, as ManagerService.setActive)', 'deactivated'],
      ['user.status suspended ONLY', 'statusonly'],
      ['workspace membership suspended ONLY', 'wsmsuspended'],
      ['workspace membership removed ONLY', 'wsmremoved'],
      ['manager_profile.archived_at set ONLY', 'archived'],
      ['organisation_member revoked ONLY', 'orgrevoked'],
      ['report.view REVOKE override ONLY', 'noreportview'],
      ['removed from the venue ONLY', 'unassigned'],
      ['soft-deleted ONLY', 'deleted'],
    ])('3/4. excluded at enqueue: %s', (_label, key) => {
      expect(allRows.filter((r) => r.target_user_id === excluded[key]!.userId)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------ suspended organisation

  it('5. a suspended organisation gets ZERO report emails, while its PDFs are still generated and stored', async () => {
    const base = await seedOrg('Suspended Org Venue');
    await venueManager(base, 'susporg');
    const f: Fixture = { ...base, shiftId: await seedShift(base) };
    await suspendOrganisation(f);

    expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
    await finalise(f);
    expect((await runFinal(f)).failed).toBe(0);

    expect(await reportRows(f)).toHaveLength(0);
    const report = await storedReport(f);
    expect(report?.pre_shift_file_id).toBeTruthy(); // evidence kept
    expect(report?.final_file_id).toBeTruthy();
  }, 300_000);

  it('5b. organisation suspended AFTER enqueue: every queued report email is CANCELLED and the provider is never called', async () => {
    const base = await seedOrg('Suspended Later Venue');
    const vm = await venueManager(base, 'susplater');
    const f: Fixture = { ...base, shiftId: await seedShift(base) };
    await produceBothReports(f);
    const rows = await reportRows(f);
    expect(rows.map((r) => r.target_user_id)).toEqual([vm.userId, vm.userId]);
    await suspendOrganisation(f);
    await expectCancelledWithoutProviderCall(f, rows);
  }, 300_000);

  // ------------------------------------------------------------------ send time

  describe('at send time (access lost AFTER enqueue, BEFORE delivery)', () => {
    let f: Fixture;
    let keeper: TestIdentity;
    const lost: Record<string, TestIdentity> = {};
    let rows: OutboxRow[];

    beforeAll(async () => {
      const base = await seedOrg('Send Time Venue');
      keeper = await venueManager(base, 'keeper');
      for (const label of ['leaver', 'statusonly', 'wsmonly', 'moved', 'revoked', 'archived', 'orgrevoked']) lost[label] = await venueManager(base, label);
      f = { ...base, shiftId: await seedShift(base) };
      await produceBothReports(f);
      rows = await reportRows(f);
      // Everyone was eligible when the rows were queued: one roster + one timesheet each.
      expect(rows).toHaveLength(2 * (1 + Object.keys(lost).length));
      expect(rows.every((r) => r.status === 'PENDING')).toBe(true);

      await deactivate(f, lost.leaver!.userId);
      await suspendUserStatusOnly(f, lost.statusonly!.userId);
      await suspendWorkspaceMembershipOnly(f, lost.wsmonly!.userId);
      await unassignOnly(f, lost.moved!);
      await revokeReportViewOnly(f, lost.revoked!.userId);
      await archiveProfileOnly(f, lost.archived!);
      await revokeOrganisationMemberOnly(f, lost.orgrevoked!.userId);
    }, 300_000);

    it.each([
      ['deactivated (status + membership)', 'leaver'],
      ['user.status suspended ONLY', 'statusonly'],
      ['workspace membership suspended ONLY', 'wsmonly'],
      ['removed from the venue ONLY', 'moved'],
      ['report.view REVOKE override ONLY', 'revoked'],
      ['manager_profile.archived_at set ONLY', 'archived'],
      ['organisation_member revoked ONLY', 'orgrevoked'],
    ])('6. %s after enqueue: both rows CANCELLED (safe code), 0 provider calls', async (_label, key) => {
      const theirs = rows.filter((r) => r.target_user_id === lost[key]!.userId);
      expect(theirs).toHaveLength(2);
      await expectCancelledWithoutProviderCall(f, theirs);
    }, 120_000);

    it('7. the active recipient still receives the roster and the timesheet with the stored PDF attached', async () => {
      const { sends, run } = processorWithMockProvider();
      const kept = rows.filter((r) => r.target_user_id === keeper.userId);
      expect(kept).toHaveLength(2);
      for (const row of kept) await run(f.organisation.id, row.id);

      expect(sends).toHaveLength(2);
      for (const row of kept) {
        expect((await outboxRow(f, row.id)).status).toBe('SENT');
        const sent = sends.find((s) => s.attachments?.[0]?.filename === row.attachment_filename)!;
        expect(sent.to).toBe(keeper.email);
        const stored = await readStoredFile(f, row.attachment_file_id!);
        expect(sent.attachments).toHaveLength(1);
        expect(createHash('sha256').update(sent.attachments![0]!.content).digest('hex')).toBe(createHash('sha256').update(stored).digest('hex'));
        expect(stored.subarray(0, 5).toString('utf8')).toBe('%PDF-');
      }
      expect(sends.map((s) => s.attachments![0]!.filename).sort()).toEqual(['final-timesheet.pdf', 'shift-attendance-sheet.pdf']);
    }, 120_000);

    it('8. non-report emails to the same deactivated user still send exactly as before', async () => {
      const { sends, run } = processorWithMockProvider();
      const leaver = lost.leaver!;
      const tokenId = (
        await adminDataSource.query(
          `INSERT INTO core.password_reset_token (organisation_id, user_id, token_hash, purpose, expires_at)
           VALUES ($1, $2, $3, 'admin_reset', now() + interval '1 hour') RETURNING id`,
          [f.organisation.id, leaver.userId, createHash('sha256').update(randomUUID()).digest('hex')],
        )
      )[0].id as string;
      const queued = await tenantContext.runInTenantContext(ownerCtx(f), async (m) => [
        await emailOutbox.enqueue(m, {
          organisationId: f.organisation.id,
          jobType: EmailOutboxJobType.ACCOUNT_SUSPENDED,
          recipientEmail: leaver.email,
          targetUserId: leaver.userId,
          rendered: { subject: 'Your account has been suspended', text: 'Suspended.', html: '<p>Suspended.</p>' },
        }),
        await emailOutbox.enqueue(m, {
          organisationId: f.organisation.id,
          jobType: EmailOutboxJobType.PASSWORD_RESET,
          recipientEmail: leaver.email,
          targetUserId: leaver.userId,
          passwordResetTokenId: tokenId,
          rendered: { subject: 'Reset your password', text: 'Reset.', html: '<p>Reset.</p>' },
        }),
        await emailOutbox.enqueue(m, {
          organisationId: f.organisation.id,
          jobType: EmailOutboxJobType.NOTIFICATION,
          recipientEmail: leaver.email,
          targetUserId: leaver.userId,
          workspaceId: f.workspaceId,
          rendered: { subject: 'A plain notification', text: 'Hello.', html: '<p>Hello.</p>' },
        }),
      ]);
      for (const row of queued) await run(f.organisation.id, row.id);

      expect(sends).toHaveLength(3);
      expect(sends.every((s) => s.to === leaver.email && !s.attachments)).toBe(true);
      for (const row of queued) expect((await outboxRow(f, row.id)).status).toBe('SENT');
    }, 120_000);
  });
});
