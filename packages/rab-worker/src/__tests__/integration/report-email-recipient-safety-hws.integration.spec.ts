import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { resolveIntegrationTestDatabase } from '@rab/server/database/typeorm/core/test-database-guard';
import { provisionWorkspaceSchema } from '@rab/server/database/typeorm/workspace-schema/provision-workspace-schema';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueJobData } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { SchemaResolverService, WorkspaceRoutingError } from '@rab/server/engine/core-modules/tenant/schema-resolver.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
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
 * REPORT EMAIL SAFETY under HWS routing (security review S-2). With `HWS_RUNTIME_ENABLED=true` the workspace business
 * tables (`venue`, `manager_venue`, `shift`, `shift_assignment`, `shift_report`, `staff_profile`, ...) live in the
 * workspace's OWN physical schema, provisioned to READY by the real provisioner here. The legacy `core.*` copies may
 * still hold stale rows. The enqueue side and the send-time re-check must both read the workspace schema:
 *
 *  - case 6 (HWS): a manager unassigned ONLY in the workspace schema (a stale `core.manager_venue` row still names them)
 *    has their queued roster and timesheet CANCELLED, 0 provider calls — reading `core` would wrongly pass them;
 *  - case 7 (HWS): the active manager, assigned ONLY in the workspace schema (no `core.manager_venue` row), still receives
 *    both PDFs — reading `core` would wrongly cancel them;
 *  - fail closed: when the row's workspace cannot be routed, nothing is sent (the attempt ends FAILED, not SENT).
 *
 * Real Postgres (FORCE RLS), real `SchemaResolverService`, a real `TenantContextService` with HWS on (the only difference
 * from the app's instance — the test database's app config runs HWS off), real jobs and Playwright; only the email
 * provider is a mock.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

interface OutboxRow {
  id: string;
  target_user_id: string | null;
  attachment_file_id: string | null;
  attachment_filename: string | null;
  status: string;
  last_error_code: string | null;
}

describeIfDb('report emails under HWS routing: enqueue + send-time re-check read the workspace schema (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let appTenant: TenantContextService;
  let hwsTenant: TenantContextService;
  let factory: TestIdentityFactory;
  let provisioner: Client;

  let organisationId: string;
  let owner: TestIdentity;
  let workspaceId: string;
  let schemaName: string;
  let venueId: string;
  let shiftId: string;
  let keeper: TestIdentity;
  let moved: TestIdentity;
  let unroutable: TestIdentity;
  let rows: OutboxRow[];

  const ownerCtx = () => ({ organisationId, workspaceId, userId: owner.userId, role: '' });

  function processor(tenantContext: TenantContextService) {
    const sends: Array<{ to: string; attachments?: Array<{ filename: string; content: Buffer }> }> = [];
    const send = jest.fn(async (opts: (typeof sends)[number]) => {
      sends.push(opts);
      return { provider: 'test-mock', providerMessageId: randomUUID() };
    });
    const process = createEmailSendProcessor({
      tenantContext,
      emailService: { send } as unknown as EmailService,
      auditService: app.get(AuditService),
      fileService: app.get(FileService),
    });
    const run = (emailOutboxId: string) =>
      process({ data: { emailOutboxId, organisationId }, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<EmailQueueJobData>);
    return { sends, run };
  }

  const outboxRow = (id: string): Promise<OutboxRow> =>
    appTenant
      .runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, (m) =>
        m.query(`SELECT id, target_user_id, attachment_file_id, attachment_filename, status, last_error_code FROM core.email_outbox WHERE id = $1`, [id]),
      )
      .then((r: OutboxRow[]) => r[0]!);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    appTenant = app.get(TenantContextService);
    const env = app.get(EnvironmentService);
    const hwsEnv = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? true : env.get(key as never)) } as unknown as EnvironmentService;
    hwsTenant = new TenantContextService(dataSource, app.get(SchemaResolverService), hwsEnv);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext: appTenant, passwordHashing: app.get(PasswordHashingService) });
    const { adminUrl } = resolveIntegrationTestDatabase(process.env);
    provisioner = new Client({ connectionString: adminUrl });
    await provisioner.connect();
    await provisioner.query('SET ROLE crewflow'); // the real provisioner identity (see workspace-provisioning spec)

    // ---- organisation, owner workspace, provisioned to READY by the real provisioner
    const organisation = await factory.createOrganisation('rpthws');
    organisationId = organisation.id;
    owner = await factory.createInternalManager(organisation);
    workspaceId = owner.workspaceId!;
    const provisioned = await provisionWorkspaceSchema(provisioner, workspaceId);
    expect(provisioned.outcome).toBe('READY');
    schemaName = provisioned.schemaName;

    // ---- identities (core): three Venue Managers of this workspace, no venue links yet
    keeper = await factory.createVenueManager(organisation, { owner, label: 'hwskeeper' });
    moved = await factory.createVenueManager(organisation, { owner, label: 'hwsmoved' });
    unroutable = await factory.createVenueManager(organisation, { owner, label: 'hwsunroutable' });
    const staff = await factory.createStaff(organisation, { owner });

    // ---- business data in the WORKSPACE schema (HWS tenant context routes the unqualified tables there)
    const startsAt = new Date(Date.now() + 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    ({ venueId, shiftId } = await hwsTenant.runInTenantContext(ownerCtx(), async (m) => {
      const venue = await m.save(Venue, { organisationId, name: 'HWS Venue', createdBy: owner.userId, workspaceId });
      for (const vm of [keeper, moved, unroutable]) {
        await m.query(`INSERT INTO manager_venue (organisation_id, manager_profile_id, venue_id, workspace_id) VALUES ($1, $2, $3, $4)`, [
          organisationId,
          vm.profileId,
          venue.id,
          workspaceId,
        ]);
      }
      const [sp] = await m.query(
        `INSERT INTO staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id, employment_status) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
        [organisationId, staff.userId, `STF-${randomUUID().slice(0, 8)}`, owner.userId, workspaceId],
      );
      const jobRole = await m.save(JobRole, { organisationId, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId });
      const shift = await m.save(Shift, {
        organisationId,
        venueId: venue.id,
        jobRoleId: jobRole.id,
        startsAt,
        endsAt,
        breakMinutes: 30,
        requiredCount: 1,
        payRatePence: 1500,
        status: 'open',
        createdBy: owner.userId,
        workspaceId,
      });
      await m.save(ShiftAssignment, {
        organisationId,
        shiftId: shift.id,
        staffProfileId: sp.id,
        status: 'confirmed',
        payRateSnapshotPence: 1500,
        assignedBy: owner.userId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId,
      });
      return { venueId: venue.id, shiftId: shift.id };
    }));

    // ---- a STALE legacy copy in core: the same venue, and a core.manager_venue row for `moved` ONLY (never for `keeper`)
    await appTenant.runInTenantContext(ownerCtx(), (m) => m.save(Venue, { id: venueId, organisationId, name: 'HWS Venue', createdBy: owner.userId, workspaceId }));
    await factory.assignVenue(organisation, owner, moved.profileId!, venueId);

    // ---- produce both reports through the real jobs, routed by the HWS tenant context
    const files = app.get(FileService);
    const reportAvailableBefore = env.get('REPORT_AVAILABLE_BEFORE_MINUTES');
    const roster = await runShiftReportSchedulerCycle(adminDataSource, hwsTenant, app.get(AttendanceQrService), app.get(QrImageService), app.get(EmailOutboxService), files, reportAvailableBefore, { organisationId });
    expect(roster).toMatchObject({ generated: 1, failed: 0 });
    await hwsTenant.runInTenantContext(ownerCtx(), (m) =>
      m.query(`UPDATE shift_report SET status = 'finalised', finalised_at = now(), finalised_by = $2 WHERE shift_id = $1`, [shiftId, owner.userId]),
    );
    expect(await runFinalTimesheetCycle(adminDataSource, hwsTenant, app.get(EmailOutboxService), files, { organisationId })).toMatchObject({ sent: 1, failed: 0 });

    rows = await appTenant.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, (m) =>
      m.query(
        `SELECT id, target_user_id, attachment_file_id, attachment_filename, status, last_error_code FROM core.email_outbox
          WHERE organisation_id = $1 AND attachment_file_id IS NOT NULL ORDER BY created_at, id`,
        [organisationId],
      ),
    );

    // ---- access lost AFTER enqueue, in the WORKSPACE schema only: the stale core row for `moved` stays
    await hwsTenant.runInTenantContext(ownerCtx(), (m) => m.query(`DELETE FROM manager_venue WHERE manager_profile_id = $1 AND venue_id = $2`, [moved.profileId, venueId]));
  }, 300_000);

  afterAll(async () => {
    await provisioner?.end();
    await app?.close();
    await adminDataSource?.destroy();
  });

  it('precondition: the enqueue side read the WORKSPACE schema (all three assigned there) and the core copy is stale', async () => {
    expect(rows).toHaveLength(6);
    for (const vm of [keeper, moved, unroutable]) expect(rows.filter((r) => r.target_user_id === vm.userId)).toHaveLength(2);
    const ws = await adminDataSource.query(`SELECT manager_profile_id FROM ${schemaName}.manager_venue WHERE venue_id = $1 ORDER BY 1`, [venueId]);
    expect(ws.map((r: { manager_profile_id: string }) => r.manager_profile_id).sort()).toEqual([keeper.profileId, unroutable.profileId].sort());
    const core = await adminDataSource.query(`SELECT manager_profile_id FROM core.manager_venue WHERE venue_id = $1`, [venueId]);
    expect(core.map((r: { manager_profile_id: string }) => r.manager_profile_id)).toEqual([moved.profileId]); // stale: still says "moved"
  });

  it('6 (HWS). unassigned only in the workspace schema: both rows CANCELLED, 0 provider calls (the stale core row is NOT trusted)', async () => {
    const { sends, run } = processor(hwsTenant);
    const theirs = rows.filter((r) => r.target_user_id === moved.userId);
    for (const row of theirs) await run(row.id);
    expect(sends).toHaveLength(0);
    for (const row of theirs) {
      const after = await outboxRow(row.id);
      expect(after.status).toBe('CANCELLED');
      expect(after.last_error_code).toBe('REPORT_RECIPIENT_INELIGIBLE');
    }
  }, 120_000);

  it('7 (HWS). assigned only in the workspace schema: the roster and the timesheet are SENT with their PDFs', async () => {
    const { sends, run } = processor(hwsTenant);
    const theirs = rows.filter((r) => r.target_user_id === keeper.userId);
    for (const row of theirs) await run(row.id);
    expect(sends).toHaveLength(2);
    expect(sends.every((s) => s.to === keeper.email && s.attachments?.length === 1 && s.attachments[0]!.content.subarray(0, 5).toString('utf8') === '%PDF-')).toBe(true);
    expect(sends.map((s) => s.attachments![0]!.filename).sort()).toEqual(['final-timesheet.pdf', 'shift-attendance-sheet.pdf']);
    for (const row of theirs) expect((await outboxRow(row.id)).status).toBe('SENT');
  }, 120_000);

  it('fail closed: if the row workspace cannot be routed, nothing is sent and the attempt ends FAILED', async () => {
    const env = app.get(EnvironmentService);
    const hwsEnv = { get: (key: string) => (key === 'HWS_RUNTIME_ENABLED' ? true : env.get(key as never)) } as unknown as EnvironmentService;
    const refusingResolver = { resolve: async () => { throw new WorkspaceRoutingError('not-ready'); } } as unknown as SchemaResolverService;
    const { sends, run } = processor(new TenantContextService(dataSource, refusingResolver, hwsEnv));
    const theirs = rows.filter((r) => r.target_user_id === unroutable.userId);
    for (const row of theirs) await expect(run(row.id)).rejects.toThrow();
    expect(sends).toHaveLength(0);
    for (const row of theirs) expect((await outboxRow(row.id)).status).toBe('FAILED');
  }, 120_000);
});
