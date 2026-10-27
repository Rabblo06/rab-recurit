import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EmailOutboxJobType } from '@rab/shared';
import { Job, UnrecoverableError } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { AccountLifecycleService } from '@rab/server/engine/core-modules/auth/services/account-lifecycle.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { SchemaResolverService, WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
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
import { inspectPdf } from '../helpers/pdf-inspect';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * REPORT EMAIL CANCELLATION — owner decisions S-6 and S-10, plus the measurements behind N-1 and N-2 (Phase 0).
 *
 * S-6: while the organisation is suspended, roster + timesheet emails are cancelled (send time) or withheld (enqueue
 *      time); every cancellation is AUDITED with ids, job type and a reason code only; reports, PDFs and their stored
 *      objects are kept; nothing is replayed after reactivation; a later delivery is a FRESH enqueue that re-evaluates
 *      current recipients and carries current data.
 * S-10: invited-only users and non-members never receive a confidential report, re-checked at delivery; legitimate
 *       ACCOUNT_INVITATION emails to those same invited users are NOT blocked.
 * N-1 / N-2: NOT fixed — these tests only measure the current behaviour (retry count for a report row whose workspace
 *       is missing; which actor fields the processor's contexts and audit rows carry).
 *
 * Real jobs, real send processor, real database (FORCE RLS), real Playwright renderer; only the email PROVIDER is a mock.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(300_000);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Fixture {
  organisation: Organisation;
  owner: TestIdentity;
  workspaceId: string;
  venueId: string;
  venueName: string;
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

interface AuditRow {
  action: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

describeIfDb('report email cancellation: S-6 audit + no replay, S-10 eligibility, N-1/N-2 measurements (integration)', () => {
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
  let accountLifecycle: AccountLifecycleService;
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
    accountLifecycle = moduleRef.get(AccountLifecycleService);
    reportAvailableBefore = moduleRef.get(EnvironmentService).get('REPORT_AVAILABLE_BEFORE_MINUTES');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  // ------------------------------------------------------------------ fixtures (same shapes as report-email-recipient-safety)

  const ownerCtx = (f: Pick<Fixture, 'organisation' | 'owner' | 'workspaceId'>) => ({
    organisationId: f.organisation.id,
    workspaceId: f.workspaceId,
    userId: f.owner.userId,
    role: '',
  });

  async function seedOrg(label: string): Promise<Base> {
    const organisation = await factory.createOrganisation('rptcancel');
    const owner = await factory.createInternalManager(organisation);
    const workspaceId = owner.workspaceId!;
    const venueName = `${label} Venue ${randomUUID().slice(0, 8)}`;
    const venue = await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: owner.userId, role: '' },
      (m) => m.save(Venue, { organisationId: organisation.id, name: venueName, createdBy: owner.userId, workspaceId }),
    );
    return { organisation, owner, workspaceId, venueId: venue.id, venueName };
  }

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

  const setUserStatus = (f: Base, userId: string, status: string) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`UPDATE core."user" SET status = $2 WHERE id = $1`, [userId, status]));
  /** ManagerService.setActive(false): user suspended + workspace membership suspended. */
  const deactivate = async (f: Base, userId: string) => {
    await setUserStatus(f, userId, 'suspended');
    await tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`SELECT core.suspend_workspace_membership($1)`, [userId]));
  };
  /** A non-member: no workspace_membership row at all (never joined, or the row is gone). */
  const dropWorkspaceMembership = (userId: string) => adminDataSource.query(`DELETE FROM core.workspace_membership WHERE user_id = $1`, [userId]);
  /** The same columns OrganisationSuspensionService.suspend / reactivate write. */
  const suspendOrganisation = (f: Base) =>
    adminDataSource.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'test' WHERE id = $1`, [
      f.organisation.id,
      f.owner.userId,
    ]);
  const reactivateOrganisation = (f: Base) =>
    adminDataSource.query(
      `UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL, reactivated_at = now(), reactivated_by = $2
        WHERE id = $1 AND suspended_at IS NOT NULL`,
      [f.organisation.id, f.owner.userId],
    );

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

  async function produceBothReports(f: Fixture) {
    expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
    await finalise(f);
    expect(await runFinal(f)).toMatchObject({ sent: 1, failed: 0 });
  }

  const SELECT_ROW = `SELECT id, recipient_email, target_user_id, job_type, rendered_subject, rendered_html, rendered_text, attachment_file_id,
                             attachment_filename, status, last_error_code FROM core.email_outbox`;
  const reportRows = (f: Base): Promise<OutboxRow[]> =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) =>
      m.query(`${SELECT_ROW} WHERE organisation_id = $1 AND attachment_file_id IS NOT NULL ORDER BY created_at, id`, [f.organisation.id]),
    );
  const allOutboxRows = (f: Base): Promise<OutboxRow[]> =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`${SELECT_ROW} WHERE organisation_id = $1 ORDER BY created_at, id`, [f.organisation.id]));
  const outboxRow = (f: Base, id: string): Promise<OutboxRow> =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`${SELECT_ROW} WHERE id = $1`, [id])).then((rows: OutboxRow[]) => rows[0]!);
  const auditRows = (f: Base, action: string): Promise<AuditRow[]> =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) =>
      m.query(
        `SELECT action, actor_user_id, target_user_id, entity_type, entity_id, metadata FROM core.audit_log
          WHERE organisation_id = $1 AND action = $2 ORDER BY created_at, id`,
        [f.organisation.id, action],
      ),
    );
  /** Every stored report file of the organisation, with the fields that prove it is unchanged. */
  const storedFiles = (f: Base) =>
    tenantContext.runInTenantContext(ownerCtx(f), (m) =>
      m.query(`SELECT id, kind, status, sha256, size_bytes, object_key FROM core.stored_file WHERE organisation_id = $1 ORDER BY created_at, id`, [f.organisation.id]),
    );
  const reportRow = (f: Fixture) =>
    tenantContext
      .runInTenantContext(ownerCtx(f), (m) =>
        m.query(`SELECT id, status, pre_shift_file_id, original_file_id, final_file_id, final_pdf_sent_at FROM core.shift_report WHERE shift_id = $1`, [f.shiftId]),
      )
      .then((rows: Array<Record<string, unknown>>) => rows[0]!);
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const readStoredBytes = async (f: Base, fileId: string): Promise<Buffer> => {
    const file = await tenantContext.runInTenantContext(ownerCtx(f), (m) => storage.findAvailable(m, fileId));
    expect(file).not.toBeNull();
    return storage.readVerified(file!);
  };

  type Send = { to: string; subject: string; html?: string; attachments?: Array<{ filename: string; content: Buffer }> };
  /** The real send processor with a MOCK provider: every provider call is recorded, nothing leaves the process. */
  function processorWithMockProvider(tc: TenantContextService = tenantContext) {
    const sends: Send[] = [];
    const send = jest.fn(async (opts: Send) => {
      sends.push(opts);
      return { provider: 'test-mock', providerMessageId: randomUUID() };
    });
    const process = createEmailSendProcessor({ tenantContext: tc, emailService: { send } as unknown as EmailService, auditService: audit, fileService: storage });
    const run = (organisationId: string, emailOutboxId: string, attemptsMade = 0, attempts = 3) =>
      process({ data: { emailOutboxId, organisationId }, attemptsMade, opts: { attempts } } as unknown as Job<EmailQueueJobData>);
    return { send, sends, run };
  }

  /** Nothing an audit row may carry: the address (and its local part), names, the venue, the subject or body, a file digest. */
  function expectNoSensitiveContent(rows: AuditRow[], forbidden: string[]) {
    for (const row of rows) {
      const serialised = JSON.stringify(row);
      for (const value of forbidden.filter((v) => v && v.length >= 4)) expect(serialised).not.toContain(value);
      for (const value of Object.values(row.metadata)) {
        // Every metadata value is an id, a job type or a reason code — never free text.
        expect(typeof value === 'string' && (UUID.test(value) || /^[A-Z_]+$/.test(value))).toBe(true);
      }
    }
  }

  // ================================================================== S-6

  describe('S-6: suspended organisation — send-time cancellation is audited, evidence kept, no replay, fresh enqueue', () => {
    let f: Fixture;
    let vm: TestIdentity;
    let rows: OutboxRow[];
    let filesBefore: Array<Record<string, unknown>>;
    let reportBefore: Record<string, unknown>;
    let bytesBefore: Record<string, string>;

    beforeAll(async () => {
      const base = await seedOrg('S6 Send');
      vm = await venueManager(base, 's6vm');
      f = { ...base, shiftId: await seedShift(base) };
      await produceBothReports(f);
      rows = await reportRows(f);
      expect(rows.map((r) => r.target_user_id)).toEqual([vm.userId, vm.userId]);
      filesBefore = await storedFiles(f);
      reportBefore = await reportRow(f);
      bytesBefore = {};
      for (const row of rows) bytesBefore[row.attachment_file_id!] = sha(await readStoredBytes(f, row.attachment_file_id!));
      await suspendOrganisation(f);
    });

    it('S6-1: both queued report emails are CANCELLED with 0 provider calls, and each cancellation writes ONE audit row', async () => {
      const { sends, run } = processorWithMockProvider();
      for (const row of rows) await run(f.organisation.id, row.id);
      expect(sends).toHaveLength(0);
      for (const row of rows) {
        expect(await outboxRow(f, row.id)).toMatchObject({ status: 'CANCELLED', last_error_code: 'REPORT_RECIPIENT_INELIGIBLE' });
      }

      const audits = await auditRows(f, 'report.email_cancelled');
      expect(audits).toHaveLength(2);
      for (const row of rows) {
        const entry = audits.find((a) => a.entity_id === row.id)!;
        expect(entry).toMatchObject({ entity_type: 'email_outbox', actor_user_id: null, target_user_id: vm.userId });
        expect(entry.metadata).toEqual({ emailOutboxId: row.id, fileId: row.attachment_file_id, jobType: 'NOTIFICATION', reasonCode: 'ORGANISATION_SUSPENDED' });
      }
    });

    it('S6-2: the audit rows carry no address, name, venue, subject, body, token or file content', async () => {
      const audits = await auditRows(f, 'report.email_cancelled');
      const forbidden = [vm.email, vm.email.split('@')[0]!, 'VenueMgr', f.venueName, ...rows.flatMap((r) => [r.rendered_subject, r.rendered_text ?? '', r.rendered_html ?? ''])];
      forbidden.push(...Object.values(bytesBefore)); // not even the digest of the PDF
      expectNoSensitiveContent(audits, forbidden);
      for (const a of audits) expect(Object.keys(a.metadata).sort()).toEqual(['emailOutboxId', 'fileId', 'jobType', 'reasonCode']);
    });

    it('S6-3: the report, both PDF records and the stored bytes are untouched by the cancellation', async () => {
      expect(await storedFiles(f)).toEqual(filesBefore);
      expect(filesBefore.every((file) => file.status === 'AVAILABLE')).toBe(true);
      expect(await reportRow(f)).toEqual(reportBefore);
      for (const [fileId, digest] of Object.entries(bytesBefore)) expect(sha(await readStoredBytes(f, fileId))).toBe(digest);
    });

    it('S6-4: a redelivered job for a CANCELLED row sends nothing and writes no second audit row', async () => {
      const { sends, run } = processorWithMockProvider();
      for (const row of rows) await run(f.organisation.id, row.id, 1);
      expect(sends).toHaveLength(0);
      expect(await auditRows(f, 'report.email_cancelled')).toHaveLength(2);
    });

    it('S6-5: after reactivation NOTHING is replayed — the rows stay CANCELLED, the jobs enqueue nothing, no provider call', async () => {
      await reactivateOrganisation(f);
      const outboxBefore = await allOutboxRows(f);
      const { sends, run } = processorWithMockProvider();
      for (const row of rows) await run(f.organisation.id, row.id);
      expect(await runScheduler(f)).toMatchObject({ generated: 0, failed: 0 });
      expect(await runFinal(f)).toMatchObject({ sent: 0, failed: 0 });
      expect(sends).toHaveLength(0);
      expect(await allOutboxRows(f)).toEqual(outboxBefore);
      for (const row of rows) expect((await outboxRow(f, row.id)).status).toBe('CANCELLED');
      expect(await storedFiles(f)).toEqual(filesBefore);
    });

  });

  it('S6-6: a LATER roster delivery is a fresh enqueue that re-evaluates CURRENT recipients and carries CURRENT data', async () => {
    const base = await seedOrg('S6 Fresh');
    const vm = await venueManager(base, 's6old');
    const f: Fixture = { ...base, shiftId: await seedShift(base) };
    expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
    const [cancelled] = await reportRows(f);
    expect(cancelled).toMatchObject({ target_user_id: vm.userId, attachment_filename: 'shift-attendance-sheet.pdf' });
    await suspendOrganisation(f);
    const first = processorWithMockProvider();
    await first.run(f.organisation.id, cancelled!.id);
    expect(first.sends).toHaveLength(0);
    await reactivateOrganisation(f);

    // Current state now differs from enqueue time: the original manager has since been deactivated, a new one assigned,
    // and the shift changed (break 30 -> 45 min), which is what makes the scheduler generate a new roster.
    const newVm = await venueManager(f, 's6new');
    await deactivate(f, vm.userId);
    await tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`UPDATE shift SET break_minutes = 45, updated_at = now() WHERE id = $1`, [f.shiftId]));

    expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
    const fresh = (await reportRows(f)).filter((r) => r.id !== cancelled!.id);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ target_user_id: newVm.userId, recipient_email: newVm.email, status: 'PENDING', attachment_filename: 'shift-attendance-sheet.pdf' });
    expect(fresh[0]!.attachment_file_id).not.toBe(cancelled!.attachment_file_id); // a NEW PDF, not the cancelled one re-sent
    expect((await outboxRow(f, cancelled!.id)).status).toBe('CANCELLED'); // the cancelled row itself is never revived

    const second = processorWithMockProvider();
    await second.run(f.organisation.id, fresh[0]!.id);
    expect(second.sends).toHaveLength(1);
    expect(second.sends[0]!.to).toBe(newVm.email);
    const newText = inspectPdf(second.sends[0]!.attachments![0]!.content).text;
    const oldText = inspectPdf(await readStoredBytes(f, cancelled!.attachment_file_id!)).text;
    expect(newText).toContain('45 min');
    expect(oldText).toContain('30 min');
    // The superseded roster is still stored (evidence is never deleted).
    expect((await storedFiles(f)).find((file: Record<string, unknown>) => file.id === cancelled!.attachment_file_id)).toMatchObject({ status: 'AVAILABLE' });
  });

  describe('S-6: suspended BEFORE the reports exist — the withheld emails are audited at enqueue time, then never replayed', () => {
    let f: Fixture;
    let vm: TestIdentity;

    beforeAll(async () => {
      const base = await seedOrg('S6 Enqueue');
      vm = await venueManager(base, 's6evm');
      f = { ...base, shiftId: await seedShift(base) };
      await suspendOrganisation(f);
      expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
      await finalise(f);
      expect((await runFinal(f)).failed).toBe(0);
    });

    it('S6-7: zero report emails are queued, both PDFs are stored, and each withheld email is audited (ids + job type + reason code)', async () => {
      expect(await reportRows(f)).toHaveLength(0);
      const report = await reportRow(f);
      expect(report.pre_shift_file_id).toBeTruthy();
      expect(report.final_file_id).toBeTruthy();

      const audits = await auditRows(f, 'report.email_cancelled');
      expect(audits).toHaveLength(2);
      const byFile = (fileId: unknown) => audits.find((a) => a.metadata.fileId === fileId)!;
      for (const fileId of [report.pre_shift_file_id, report.final_file_id]) {
        const entry = byFile(fileId);
        expect(entry).toMatchObject({ entity_type: 'shift_report', entity_id: report.id, actor_user_id: null, target_user_id: null });
        expect(entry.metadata).toEqual({ reportId: report.id, shiftId: f.shiftId, fileId, jobType: 'NOTIFICATION', reasonCode: 'ORGANISATION_SUSPENDED' });
      }
      expectNoSensitiveContent(audits, [vm.email, vm.email.split('@')[0]!, 'VenueMgr', f.venueName]);
    });

    it('S6-8: after reactivation the jobs re-send nothing (no automatic replay) and record nothing more', async () => {
      await reactivateOrganisation(f);
      expect(await runScheduler(f)).toMatchObject({ generated: 0, failed: 0 });
      expect(await runFinal(f)).toMatchObject({ sent: 0, failed: 0 });
      expect(await reportRows(f)).toHaveLength(0);
      expect(await auditRows(f, 'report.email_cancelled')).toHaveLength(2);
    });
  });

  // ================================================================== S-10

  describe('S-10: invited-only users and non-members never receive a report; invitations still go out', () => {
    let f: Fixture;
    let active: TestIdentity;
    let invited: TestIdentity;
    let inviteExpired: TestIdentity;
    let nonMember: TestIdentity;
    let laterInvited: TestIdentity;
    let laterNonMember: TestIdentity;
    let rows: OutboxRow[];

    beforeAll(async () => {
      const base = await seedOrg('S10');
      active = await venueManager(base, 's10active');
      invited = await venueManager(base, 's10invited');
      inviteExpired = await venueManager(base, 's10expired');
      nonMember = await venueManager(base, 's10nonmember');
      laterInvited = await venueManager(base, 's10laterinv');
      laterNonMember = await venueManager(base, 's10laternm');
      f = { ...base, shiftId: await seedShift(base) };
      // Invited-only = an account created by invitation that never activated (ManagerService creates it with the column
      // default `invited`; `invite_expired` once the invite lapses). Non-member = no workspace membership at all.
      await setUserStatus(f, invited.userId, 'invited');
      await setUserStatus(f, inviteExpired.userId, 'invite_expired');
      await dropWorkspaceMembership(nonMember.userId);
      await produceBothReports(f);
      rows = await reportRows(f);
    });

    it('S10-1 (enqueue): an invited-only, an invite-expired and a non-member manager of the venue get NO report row', () => {
      const targets = new Set(rows.map((r) => r.target_user_id));
      expect(targets.has(invited.userId)).toBe(false);
      expect(targets.has(inviteExpired.userId)).toBe(false);
      expect(targets.has(nonMember.userId)).toBe(false);
      expect([...targets].sort()).toEqual([active.userId, laterInvited.userId, laterNonMember.userId].sort());
      expect(rows).toHaveLength(6);
    });

    it('S10-2 (delivery): a recipient who becomes invited-only or a non-member after enqueue is re-checked and CANCELLED (audited), 0 provider calls', async () => {
      await setUserStatus(f, laterInvited.userId, 'invited');
      await dropWorkspaceMembership(laterNonMember.userId);
      const theirs = rows.filter((r) => r.target_user_id === laterInvited.userId || r.target_user_id === laterNonMember.userId);
      expect(theirs).toHaveLength(4);
      const { sends, run } = processorWithMockProvider();
      for (const row of theirs) await run(f.organisation.id, row.id);
      expect(sends).toHaveLength(0);
      for (const row of theirs) expect(await outboxRow(f, row.id)).toMatchObject({ status: 'CANCELLED', last_error_code: 'REPORT_RECIPIENT_INELIGIBLE' });
      const audits = await auditRows(f, 'report.email_cancelled');
      expect(audits).toHaveLength(4);
      expect(audits.every((a) => a.metadata.reasonCode === 'REPORT_RECIPIENT_INELIGIBLE' && a.entity_type === 'email_outbox')).toBe(true);
      expectNoSensitiveContent(audits, [laterInvited.email, laterNonMember.email, f.venueName]);
    });

    it('S10-3 (control): the active member still receives both reports', async () => {
      const kept = rows.filter((r) => r.target_user_id === active.userId);
      const { sends, run } = processorWithMockProvider();
      for (const row of kept) await run(f.organisation.id, row.id);
      expect(sends).toHaveLength(2);
      expect(sends.every((s) => s.to === active.email && s.attachments?.length === 1)).toBe(true);
    });

    it('S10-4: a legitimate ACCOUNT_INVITATION email to an invited-only user is NOT blocked (sent, no attachment)', async () => {
      const queued = await tenantContext.runInTenantContext(ownerCtx(f), async (m) => {
        await accountLifecycle.sendAccountInvite(m, ownerCtx(f), { userId: invited.userId, email: invited.email, createdBy: f.owner.userId });
        const [row] = await m.query(`${SELECT_ROW} WHERE target_user_id = $1 AND job_type = $2 ORDER BY created_at DESC LIMIT 1`, [
          invited.userId,
          EmailOutboxJobType.ACCOUNT_INVITATION,
        ]);
        return row as OutboxRow;
      });
      expect(queued).toBeDefined();
      const { sends, run } = processorWithMockProvider();
      await run(f.organisation.id, queued.id);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.to).toBe(invited.email);
      expect(sends[0]!.attachments).toBeUndefined();
      expect((await outboxRow(f, queued.id)).status).toBe('SENT');
    });
  });

  // ================================================================== N-1 (measured, not fixed)

  describe('N-1 (measurement only): a report row whose workspace cannot be resolved', () => {
    let f: Fixture;
    let vm: TestIdentity;

    beforeAll(async () => {
      const base = await seedOrg('N1');
      vm = await venueManager(base, 'n1vm');
      f = { ...base, shiftId: await seedShift(base) };
      expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
    });

    /** Drives the processor the way BullMQ would with the production queue options (attempts 5): stop on success or UnrecoverableError. */
    async function driveLikeBullmq(run: (attemptsMade: number) => Promise<void>) {
      const attempts: Array<{ attempt: number; outcome: string; ms: number }> = [];
      for (let attemptsMade = 0; attemptsMade < 5; attemptsMade += 1) {
        const t0 = Date.now();
        try {
          await run(attemptsMade);
          attempts.push({ attempt: attemptsMade + 1, outcome: 'resolved', ms: Date.now() - t0 });
          break;
        } catch (error) {
          const unrecoverable = error instanceof UnrecoverableError;
          attempts.push({ attempt: attemptsMade + 1, outcome: unrecoverable ? 'unrecoverable' : 'retryable-throw', ms: Date.now() - t0 });
          if (unrecoverable) break;
        }
      }
      return attempts;
    }

    it('N1-a: the row has NO workspace (workspace_id NULL) — attempts until terminal, provider calls, final state', async () => {
      const [row] = await reportRows(f);
      await adminDataSource.query(`UPDATE core.email_outbox SET workspace_id = NULL WHERE id = $1`, [row!.id]);
      const { sends, run } = processorWithMockProvider();
      const attempts = await driveLikeBullmq((attemptsMade) => run(f.organisation.id, row!.id, attemptsMade, 5));
      const after = await outboxRow(f, row!.id);
      // eslint-disable-next-line no-console
      console.log(`[N-1a] attempts=${JSON.stringify(attempts)} final=${after.status} code=${after.last_error_code} providerCalls=${sends.length}`);
      expect(sends).toHaveLength(0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.outcome).toBe('unrecoverable');
      expect(after).toMatchObject({ status: 'FAILED', last_error_code: 'missing-context' });
    });

    it('N1-b: the row workspace is not routable under HWS (registry missing) — attempts until terminal, provider calls, final state', async () => {
      // A second, fresh report row for the same manager (regenerate after a shift change).
      await tenantContext.runInTenantContext(ownerCtx(f), (m) => m.query(`UPDATE shift SET break_minutes = 40, updated_at = now() WHERE id = $1`, [f.shiftId]));
      expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
      const row = (await reportRows(f)).find((r) => r.status === 'PENDING' && r.target_user_id === vm.userId)!;
      const env = app.get(EnvironmentService);
      const hwsEnv = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? true : env.get(key as never)) } as unknown as EnvironmentService;
      const refusingResolver = { resolve: async () => { throw new WorkspaceRoutingError('registry-missing'); } } as unknown as SchemaResolverService;
      const { sends, run } = processorWithMockProvider(new TenantContextService(dataSource, refusingResolver, hwsEnv));
      const attempts = await driveLikeBullmq((attemptsMade) => run(f.organisation.id, row.id, attemptsMade, 5));
      const after = await outboxRow(f, row.id);
      // eslint-disable-next-line no-console
      console.log(`[N-1b] attempts=${JSON.stringify(attempts)} final=${after.status} code=${after.last_error_code} providerCalls=${sends.length}`);
      expect(sends).toHaveLength(0);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.outcome).toBe('unrecoverable');
      expect(after).toMatchObject({ status: 'FAILED', last_error_code: 'registry-missing' });
    });
  });

  // ================================================================== N-2 (measured, not fixed)

  describe('N-2 (measurement only): the actor the send processor binds and records', () => {
    it('N2-a: no processor context sets actorType; rab.actor_type is empty inside the workspace re-check; audit rows carry actor NULL', async () => {
      const base = await seedOrg('N2');
      const vm = await venueManager(base, 'n2vm');
      const f: Fixture = { ...base, shiftId: await seedShift(base) };
      expect(await runScheduler(f)).toMatchObject({ generated: 1, failed: 0 });
      const [row] = await reportRows(f);

      const contexts: Array<Record<string, unknown>> = [];
      const actorTypeSeen: string[] = [];
      const realTenant = tenantContext.runInTenantContext.bind(tenantContext);
      const realWorkspace = tenantContext.runInWorkspaceContext.bind(tenantContext);
      const tenantSpy = jest.spyOn(tenantContext, 'runInTenantContext').mockImplementation((ctx, fn) => {
        contexts.push({ via: 'runInTenantContext', ...ctx });
        return realTenant(ctx, fn);
      });
      const workspaceSpy = jest.spyOn(tenantContext, 'runInWorkspaceContext').mockImplementation((ctx, fn) => {
        contexts.push({ via: 'runInWorkspaceContext', ...ctx });
        return realWorkspace(ctx, async (manager, schema) => {
          const [{ actor_type }] = await manager.query(`SELECT current_setting('rab.actor_type', true) AS actor_type`);
          actorTypeSeen.push(actor_type);
          return fn(manager, schema);
        });
      });
      const { sends, run } = processorWithMockProvider();
      try {
        await run(f.organisation.id, row!.id);
      } finally {
        tenantSpy.mockRestore();
        workspaceSpy.mockRestore();
      }
      expect(sends).toHaveLength(1);
      expect(sends[0]!.to).toBe(vm.email);
      // eslint-disable-next-line no-console
      console.log(`[N-2] processor contexts=${JSON.stringify(contexts.map((c) => ({ via: c.via, actorType: c.actorType ?? null, userId: c.userId })))} rab.actor_type inside re-check=${JSON.stringify(actorTypeSeen)}`);
      expect(contexts.length).toBeGreaterThanOrEqual(3);
      expect(contexts.every((c) => c.actorType === undefined && c.userId === '')).toBe(true);
      expect(actorTypeSeen).toEqual(['']);

      // The audit row the processor writes vs. the one the scheduler wrote under actorType 'worker': identical actor shape.
      const [sent] = await auditRows(f, 'email.sent');
      const [stored] = await auditRows(f, 'report.stored');
      expect(sent).toMatchObject({ actor_user_id: null, target_user_id: vm.userId });
      expect(stored).toMatchObject({ actor_user_id: null });
      const columns: Array<{ column_name: string }> = await adminDataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'audit_log' ORDER BY ordinal_position`,
      );
      // There is no actor-type column: a worker-written and a processor-written row are indistinguishable by actor.
      expect(columns.map((c) => c.column_name)).not.toContain('actor_type');
    });
  });
});
