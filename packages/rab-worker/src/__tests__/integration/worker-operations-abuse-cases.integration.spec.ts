import { PostShiftLifecycleService } from '@rab/server/modules/attendance/services/post-shift-lifecycle.service';
import 'reflect-metadata';
import { AttendanceStatus, ManagerType, NotificationType, OfferStatus, ShiftAssignmentStatus, ShiftStatus, UserStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { AUTH_TOKEN_CLEANUP_RETENTION_DAYS } from '@rab/server/engine/core-modules/auth/token/retention-policy';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { EmailOutbox, NotificationPreference, Organisation, RefreshToken, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { AttendanceService } from '@rab/server/modules/attendance/services/attendance.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { runAttendanceMonitorCycle } from '../../queues/rab-shifts/attendance-monitor.job';
import { runOfferExpiryCycle } from '../../queues/rab-offers/offer-expiry.job';
import { runTokenCleanupCycle } from '../../queues/rab-maintenance/token-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { integrationTestDatabaseReady } from '@rab/server/database/typeorm/core/integration-test-database-gate';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * The multi-job worker's 4 new operational categories — real Postgres, RLS
 * on, no mocks, calling each job's real exported function directly (same
 * direct-invocation pattern `email-outbox-abuse-cases.integration.spec.ts`
 * already established for `createEmailSendProcessor`). Fixtures are seeded
 * directly at the entity layer (mirroring `composite-workspace-fk-attack`'s
 * own established shape) rather than through full HTTP create/publish/send
 * flows — those flows are already covered elsewhere; this file's job is
 * proving the WORKER side (idempotency, revalidation, cross-org isolation,
 * never-mutate-what-you're-told-not-to) works correctly against real state.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
// The periodic-scan jobs under test here are deliberately cross-org — in
// this shared dev/test database, that means every OTHER integration test
// file's own near-term shift/attendance/offer fixtures are legitimate scan
// candidates too, processed one at a time (each its own scoped
// transaction). That's the correct, safe design for a 5-minute-cadence
// production job (see shift-monitor.job.ts's own doc comment) but it's
// slower than Jest's 5s default against a database this populated —
// extending the timeout, not changing the job's behaviour.
jest.setTimeout(60_000);

describeIfDb('worker operations abuse cases (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let attendanceService: AttendanceService;
  let attendanceQr: AttendanceQrService;

  interface OrgFixture {
    organisationId: string;
    workspaceId: string;
    managerUserId: string;
    staffProfileId: string;
    staffUserId: string;
    venueId: string;
    jobRoleId: string;
  }

  async function withContext<T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, fn: (manager: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (manager) => {
      // search_path: coreDataSourceOptions lost its static schema:'core' default in the HWS Part 2
      // migration (P2.2 fix — same systemic gap already found in rab-server's own
      // bulk-email-abuse-cases/scheduling-offer-abuse-cases, and in this package's own
      // worker-event-idempotency file).
      await manager.query(`SELECT set_config('search_path', 'core', true)`);
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await manager.query(`SELECT set_config('rab.role', '', true)`);
      return fn(manager);
    });
  }

  async function seedOrgFixture(label: string): Promise<OrgFixture> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;

    let workspaceId!: string;
    let managerUserId!: string;
    let staffProfileId!: string;
    let staffUserId!: string;
    let venueId!: string;
    let jobRoleId!: string;

    await withContext({ organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const managerHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const managerResult = await manager.insert(User, {
        organisationId,
        email: `${label}-mgr-${randomUUID()}@example.test`,
        passwordHash: managerHash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      managerUserId = managerResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: managerUserId, roleId: role.id, organisationId });

      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: managerUserId,
        name: `${label} Workspace ${managerUserId}`,
        subdomain: `${label}-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      // rab.workspace_id must be bound before this insert — same ordering bug already fixed in
      // worker-event-idempotency.integration.spec.ts (P2.2).
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
      await manager.insert(ManagerProfile, { organisationId, userId: managerUserId, type: ManagerType.INTERNAL, workspaceId });

      const staffHash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const staffResult = await manager.insert(User, {
        organisationId,
        email: `${label}-staff-${randomUUID()}@example.test`,
        passwordHash: staffHash,
        firstName: label,
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
      });
      staffUserId = staffResult.identifiers[0]!.id as string;
      let staffRole = await manager.findOne(Role, { where: { organisationId, key: 'staff' } });
      if (!staffRole) {
        const staffRoleResult = await manager.insert(Role, { organisationId, key: 'staff', name: 'Staff', isSystem: true });
        staffRole = await manager.findOneByOrFail(Role, { id: staffRoleResult.identifiers[0]!.id as string });
      }
      await manager.insert(UserRole, { userId: staffUserId, roleId: staffRole.id, organisationId });
      const staffProfile = await manager.save(StaffProfile, {
        organisationId,
        userId: staffUserId,
        staffRef: `STF-${label}-${randomUUID().slice(0, 8)}`,
        createdBy: managerUserId,
        workspaceId,
      });
      staffProfileId = staffProfile.id;

      const venue = await manager.save(Venue, { organisationId, name: `${label} Venue`, createdBy: managerUserId, workspaceId });
      venueId = venue.id;
      const jobRole = await manager.save(JobRole, { organisationId, name: `${label} Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: managerUserId, workspaceId });
      jobRoleId = jobRole.id;
    });

    return { organisationId, workspaceId, managerUserId, staffProfileId, staffUserId, venueId, jobRoleId };
  }

  /** A CONFIRMED assignment on a shift with the given start/end times. */
  async function seedConfirmedAssignment(fx: OrgFixture, startsAt: Date, endsAt: Date): Promise<{ shiftId: string; assignmentId: string }> {
    let shiftId!: string;
    let assignmentId!: string;
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const shift = await manager.save(Shift, {
        organisationId: fx.organisationId,
        venueId: fx.venueId,
        jobRoleId: fx.jobRoleId,
        startsAt,
        endsAt,
        breakMinutes: 0,
        requiredCount: 1,
        payRatePence: 1500,
        status: 'confirmed',
        createdBy: fx.managerUserId,
        workspaceId: fx.workspaceId,
      });
      shiftId = shift.id;
      const assignment = await manager.save(ShiftAssignment, {
        organisationId: fx.organisationId,
        shiftId,
        staffProfileId: fx.staffProfileId,
        status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500,
        assignedBy: fx.managerUserId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId: fx.workspaceId,
      });
      assignmentId = assignment.id;
    });
    return { shiftId, assignmentId };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    passwordHashing = app.get(PasswordHashingService);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    attendanceService = app.get(AttendanceService);
    attendanceQr = app.get(AttendanceQrService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('post-shift lifecycle', () => {
    async function fixture() {
      const fx = await seedOrgFixture('postshift');
      const start = new Date(Date.now()-10*3600000);
      const assignment = await seedConfirmedAssignment(fx, start, new Date(start.getTime()+3600000));
      const ctx = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId };
      const a = await withContext(ctx, m => m.save(Attendance, {
        organisationId: fx.organisationId, workspaceId: fx.workspaceId, shiftId: assignment.shiftId,
        shiftAssignmentId: assignment.assignmentId, staffProfileId: fx.staffProfileId,
        clockInAt: start, status: AttendanceStatus.CLOCKED_OUT, workedMinutes: 60, earnedPence: 1500,
      }));
      return { ctx, id: a.id };
    }
    // PHASE 7.1 — 1h/2h (previously 2h/6h). Boundaries in seconds: 3600 = 1h, 7200 = 2h.
    it.each([[3599,0,false,false],[3600,1,true,false],[7199,1,true,false],[7200,2,true,true]])(
      'DB boundary %s seconds', async (seconds, count, complete, expired) => {
        const {ctx,id} = await fixture();
        await withContext(ctx, async m => {
          await m.query("UPDATE core.attendance SET clock_out_at=now()-make_interval(secs=>$2) WHERE id=$1",[id,seconds]);
          expect((await PostShiftLifecycleService.discover(m)).some(row => row.id === id)).toBe(Number(seconds) >= 3600);
          const service = new PostShiftLifecycleService(auditService);
          expect(await service.advance(m,id)).toBe(count);
          expect(await service.advance(m,id)).toBe(0);
          const row = await m.findOneByOrFail(Attendance,{id});
          expect(Boolean(row.postShiftCompletedAt)).toBe(complete);
          expect(Boolean(row.postShiftExpiredAt)).toBe(expired);
          expect(row.status).toBe(AttendanceStatus.CLOCKED_OUT);
          expect(row.workedMinutes).toBe(60); expect(row.earnedPence).toBe(1500);
        });
      });
    it('concurrent workers and a restarted worker emit one event per milestone; tenant denial and corrections remain safe', async () => {
      const {ctx,id} = await fixture();
      await withContext(ctx,m=>m.query("UPDATE core.attendance SET clock_out_at=now()-interval '3 hours' WHERE id=$1",[id]));
      const run = () => withContext(ctx,m=>new PostShiftLifecycleService(auditService).advance(m,id));
      expect((await Promise.all([run(),run()])).reduce((a,b)=>a+b,0)).toBe(2);
      expect(await run()).toBe(0);
      await withContext(ctx,async m=>{
        const [audit] = await m.query("SELECT count(*)::int AS count FROM core.audit_log WHERE entity_id=$1 AND action IN ('attendance.post_shift_completed','attendance.post_shift_expired')",[id]);
        expect(audit.count).toBe(2);
        await m.query("UPDATE core.attendance SET clock_out_at=now() WHERE id=$1",[id]);
        const row=await m.findOneByOrFail(Attendance,{id});
        expect(row.postShiftCompletedAt).toBeNull(); expect(row.postShiftExpiredAt).toBeNull();
      });
      expect(await withContext({...ctx,organisationId:randomUUID(),workspaceId:randomUUID()},m=>new PostShiftLifecycleService(auditService).advance(m,id))).toBe(0);
    });
    it('missing clock-out and wrong status are ignored', async () => {
      const {ctx,id}=await fixture();
      await withContext(ctx,async m=>{
        const service=new PostShiftLifecycleService(auditService);
        expect(await service.advance(m,id)).toBe(0);
        await m.query("UPDATE core.attendance SET clock_out_at=now()-interval '3 hours', status='clocked_in' WHERE id=$1",[id]);
        expect(await service.advance(m,id)).toBe(0);
      });
    });
  });

  describe('shift monitor — reminders', () => {
    it('a confirmed assignment 23h55m before start gets a 24h reminder, and a second scan does not duplicate it', async () => {
      const fx = await seedOrgFixture('rem');
      const startsAt = new Date(Date.now() + 23 * 3600 * 1000 + 55 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);
      const afterFirst = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_24H } }),
      );
      expect(afterFirst).toHaveLength(1);

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);
      const afterSecond = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_24H } }),
      );
      expect(afterSecond).toHaveLength(1); // still exactly one — no duplicate reminder
    });

    it('a cancelled shift is never reminded even if its (stale) confirmed assignment would otherwise match', async () => {
      const fx = await seedOrgFixture('cancelrem');
      const startsAt = new Date(Date.now() + 60 * 60 * 1000);
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(Shift, shiftId, { status: 'cancelled' as never }));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);
      const notifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }),
      );
      expect(notifications).toHaveLength(0);
    });
  });

  describe('shift monitor — no-show detection', () => {
    it('a confirmed assignment on a shift that started 40 minutes ago with no attendance transitions to NO_SHOW and notifies the assigning manager', async () => {
      const fx = await seedOrgFixture('noshow');
      const startsAt = new Date(Date.now() - 40 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);

      const assignment = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentId }),
      );
      expect(assignment.status).toBe(ShiftAssignmentStatus.NO_SHOW);

      const notified = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { userId: fx.managerUserId, type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW, relatedEntityId: assignmentId } }),
      );
      expect(notified).toHaveLength(1);
    });

    it('a confirmed assignment started only 10 minutes ago (within grace) is not yet flagged as a no-show', async () => {
      const fx = await seedOrgFixture('grace');
      const startsAt = new Date(Date.now() - 10 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);

      const assignment = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentId }),
      );
      expect(assignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
    });

    it('an assignment WITH a clocked-in attendance row is never marked no-show', async () => {
      const fx = await seedOrgFixture('hasattend');
      const startsAt = new Date(Date.now() - 40 * 60 * 1000);
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.save(Attendance, {
          organisationId: fx.organisationId,
          shiftAssignmentId: assignmentId,
          shiftId,
          staffProfileId: fx.staffProfileId,
          workspaceId: fx.workspaceId,
          clockInAt: startsAt,
          status: AttendanceStatus.CLOCKED_IN,
        }),
      );

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);

      const assignment = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentId }),
      );
      expect(assignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
    });
  });

  it('extended assignment remains active after original default end', async () => {
    const fx = await seedOrgFixture('extended-default');
    const startsAt = new Date(Date.now() - 8 * 3600_000);
    const defaultEnd = new Date(Date.now() - 3600_000);
    const operationalEnd = new Date(Date.now() + 3 * 3600_000);
    const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, operationalEnd);
    const ctx = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId };
    let attendanceId!: string;
    await withContext(ctx, async m => {
      await m.update(Shift, shiftId, { defaultStartsAt: startsAt, defaultEndsAt: defaultEnd });
      const attendance = await m.save(Attendance, { organisationId: fx.organisationId, workspaceId: fx.workspaceId,
        shiftAssignmentId: assignmentId, shiftId, staffProfileId: fx.staffProfileId,
        clockInAt: startsAt, status: AttendanceStatus.CLOCKED_IN });
      attendanceId = attendance.id;
    });
    await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, app.get(EnvironmentService).get('QR_POST_SHIFT_GRACE_MINUTES'));
    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);
    await withContext(ctx, async m => {
      expect((await m.findOneByOrFail(Attendance, { id: attendanceId })).status).toBe(AttendanceStatus.CLOCKED_IN);
      expect((await m.findOneByOrFail(ShiftAssignment, { id: assignmentId })).status).toBe(ShiftAssignmentStatus.CONFIRMED);
      const shift = await m.findOneByOrFail(Shift, { id: shiftId });
      expect(shift.status).not.toBe(ShiftStatus.COMPLETED);
      expect(shift.endsAt.toISOString()).toBe(operationalEnd.toISOString());
    });
  });

  describe('attendance monitor — missing clock-out (status label only, never auto-clocks-out)', () => {
    it('an active attendance row whose shift ended 150 minutes ago (past the 120-min clock-out grace) is flagged (status -> missing_clock_out) and notified, but clockOutAt/workedMinutes/earnedPence are left completely untouched', async () => {
      const fx = await seedOrgFixture('missclock');
      const startsAt = new Date(Date.now() - 9 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 150 * 60 * 1000);
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, endsAt);
      let attendanceId!: string;
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        const attendance = await m.save(Attendance, {
          organisationId: fx.organisationId,
          shiftAssignmentId: assignmentId,
          shiftId,
          staffProfileId: fx.staffProfileId,
          workspaceId: fx.workspaceId,
          clockInAt: startsAt,
          status: AttendanceStatus.CLOCKED_IN,
        });
        attendanceId = attendance.id;
      });

      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, app.get(EnvironmentService).get('QR_POST_SHIFT_GRACE_MINUTES'));

      const attendanceAfter = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(Attendance, { id: attendanceId }),
      );
      // Status label moves to missing_clock_out, but the actual attendance
      // TRUTH (clockOutAt/workedMinutes/earnedPence) is never written here —
      // per the explicit "never auto-clocks-out" instruction.
      expect(attendanceAfter.status).toBe(AttendanceStatus.MISSING_CLOCK_OUT);
      expect(attendanceAfter.clockOutAt).toBeFalsy();
      expect(attendanceAfter.workedMinutes).toBeFalsy();
      expect(attendanceAfter.earnedPence).toBeFalsy();

      const notified = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'attendance', relatedEntityId: attendanceId, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(notified).toHaveLength(1);

      // Re-run: must not duplicate the flag.
      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, app.get(EnvironmentService).get('QR_POST_SHIFT_GRACE_MINUTES'));
      const notifiedAgain = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'attendance', relatedEntityId: attendanceId, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(notifiedAgain).toHaveLength(1);
    });
  });

  // Owner decision 2026-11-14: ONE clock-out grace (QR_POST_SHIFT_GRACE_MINUTES, 120) measured from the staff member's
  // OWN end. The staff member can clock out (QR + window) until own end + grace inclusive; the monitor flags
  // MISSING_CLOCK_OUT only strictly after it. Real AttendanceService.clockOut (service layer, RLS on) with a real QR,
  // real monitor cycle. Server time is modelled by moving the seat's window (the server clock is never touched).
  describe('clock-out grace end to end (monitor + staff clock-out share one 120-min grace)', () => {
    const MIN = 60_000;
    const grace = () => app.get(EnvironmentService).get('QR_POST_SHIFT_GRACE_MINUTES');
    const monitor = () => runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, grace());

    /** Another staff member in the same organisation/workspace (a second seat cannot reuse the first staff profile). */
    async function seedExtraStaff(fx: OrgFixture, label: string): Promise<{ staffProfileId: string; staffUserId: string }> {
      return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        const user = await m.insert(User, {
          organisationId: fx.organisationId, email: `${label}-${randomUUID()}@example.test`, passwordHash: await passwordHashing.hash(FIXTURE_PASSWORD),
          firstName: label, lastName: 'Staff', status: UserStatus.ACTIVE,
        });
        const staffUserId = user.identifiers[0]!.id as string;
        const staffRole = await m.findOneByOrFail(Role, { organisationId: fx.organisationId, key: 'staff' });
        await m.insert(UserRole, { userId: staffUserId, roleId: staffRole.id, organisationId: fx.organisationId });
        const profile = await m.save(StaffProfile, { organisationId: fx.organisationId, userId: staffUserId, staffRef: `STF-${label}-${randomUUID().slice(0, 8)}`, createdBy: fx.managerUserId, workspaceId: fx.workspaceId });
        return { staffProfileId: profile.id, staffUserId };
      });
    }

    /** A clocked-in seat for `staffProfileId` on `shiftId` with its own period (check-in not required, legacy rollout flag). */
    async function clockedInSeat(fx: OrgFixture, shiftId: string, staffProfileId: string, startsAt: Date, endsAt: Date): Promise<{ attendanceId: string }> {
      return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        const assignment = await m.save(ShiftAssignment, {
          organisationId: fx.organisationId, shiftId, staffProfileId, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500,
          assignedBy: fx.managerUserId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.workspaceId, checkInRequired: false,
        });
        const attendance = await m.save(Attendance, {
          organisationId: fx.organisationId, workspaceId: fx.workspaceId, shiftId, shiftAssignmentId: assignment.id, staffProfileId,
          clockInAt: new Date(startsAt.getTime() + 5 * MIN), status: AttendanceStatus.CLOCKED_IN,
        });
        return { attendanceId: attendance.id };
      });
    }

    async function shiftRow(fx: OrgFixture, startsAt: Date, endsAt: Date): Promise<Shift> {
      return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.save(Shift, {
          organisationId: fx.organisationId, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 2,
          payRatePence: 1500, status: 'in_progress', createdBy: fx.managerUserId, workspaceId: fx.workspaceId,
        }),
      );
    }

    const staffCtx = (fx: OrgFixture, staffUserId: string) => ({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: staffUserId, role: 'staff' });
    const statusOf = (fx: OrgFixture, attendanceId: string) =>
      withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => (await m.findOneByOrFail(Attendance, { id: attendanceId })).status);

    it('the monitor runs at own end + 100 min and leaves the row open; the staff clock-out with the shift QR then works', async () => {
      const fx = await seedOrgFixture('grace100');
      const endsAt = new Date(Date.now() - 100 * MIN);
      const startsAt = new Date(endsAt.getTime() - 8 * 60 * MIN);
      const shift = await shiftRow(fx, startsAt, endsAt);
      const { attendanceId } = await clockedInSeat(fx, shift.id, fx.staffProfileId, startsAt, endsAt);
      await monitor();
      expect(await statusOf(fx, attendanceId)).toBe(AttendanceStatus.CLOCKED_IN); // not flagged inside the grace
      const res = await attendanceService.clockOut(staffCtx(fx, fx.staffUserId), { qrToken: attendanceQr.sign(shift) } as never);
      expect(res.status).toBe(AttendanceStatus.CLOCKED_OUT);
    });

    it('at own end + 121 min the staff clock-out is refused (CLOCK_WINDOW_CLOSED) and the monitor then flags MISSING_CLOCK_OUT', async () => {
      const fx = await seedOrgFixture('grace121');
      const endsAt = new Date(Date.now() - 121 * MIN);
      const startsAt = new Date(endsAt.getTime() - 8 * 60 * MIN);
      const shift = await shiftRow(fx, startsAt, endsAt);
      const { attendanceId } = await clockedInSeat(fx, shift.id, fx.staffProfileId, startsAt, endsAt);
      await expect(attendanceService.clockOut(staffCtx(fx, fx.staffUserId), { qrToken: attendanceQr.sign(shift) } as never))
        .rejects.toMatchObject({ response: { code: 'CLOCK_WINDOW_CLOSED' } });
      expect(await statusOf(fx, attendanceId)).toBe(AttendanceStatus.CLOCKED_IN);
      await monitor();
      expect(await statusOf(fx, attendanceId)).toBe(AttendanceStatus.MISSING_CLOCK_OUT);
      // After the flag there is no open attendance for the staff member: the clock-out is the manager's recovery now.
      await expect(attendanceService.clockOut(staffCtx(fx, fx.staffUserId), { qrToken: attendanceQr.sign(shift) } as never)).rejects.toMatchObject({ status: 404 });
    });

    it('two seats: seat A (ends earlier) is refused after A end + grace and flagged, while seat B on the same shift is still accepted', async () => {
      const fx = await seedOrgFixture('graceseats');
      const shiftEnd = new Date(Date.now() - 30 * MIN);
      const shiftStart = new Date(shiftEnd.getTime() - 9 * 60 * MIN);
      const seatAEnd = new Date(Date.now() - 125 * MIN); // A's own end + 120 min passed 5 min ago
      const shift = await shiftRow(fx, shiftStart, shiftEnd);
      const b = await seedExtraStaff(fx, 'seatb');
      const seatA = await clockedInSeat(fx, shift.id, fx.staffProfileId, shiftStart, seatAEnd);
      const seatB = await clockedInSeat(fx, shift.id, b.staffProfileId, shiftStart, shiftEnd);
      const qrToken = attendanceQr.sign(shift);

      await monitor();
      expect(await statusOf(fx, seatA.attendanceId)).toBe(AttendanceStatus.MISSING_CLOCK_OUT); // flagged from A's own end
      expect(await statusOf(fx, seatB.attendanceId)).toBe(AttendanceStatus.CLOCKED_IN);
      await expect(attendanceService.clockOut(staffCtx(fx, fx.staffUserId), { qrToken } as never)).rejects.toMatchObject({ status: 404 });
      const outB = await attendanceService.clockOut(staffCtx(fx, b.staffUserId), { qrToken } as never);
      expect(outB.status).toBe(AttendanceStatus.CLOCKED_OUT);
    });

    it('two seats, no monitor yet: seat A clock-out is refused by its own window while seat B is accepted', async () => {
      const fx = await seedOrgFixture('graceseatsnomon');
      const shiftEnd = new Date(Date.now() - 30 * MIN);
      const shiftStart = new Date(shiftEnd.getTime() - 9 * 60 * MIN);
      const shift = await shiftRow(fx, shiftStart, shiftEnd);
      const b = await seedExtraStaff(fx, 'seatb2');
      await clockedInSeat(fx, shift.id, fx.staffProfileId, shiftStart, new Date(Date.now() - 121 * MIN));
      await clockedInSeat(fx, shift.id, b.staffProfileId, shiftStart, shiftEnd);
      const qrToken = attendanceQr.sign(shift);
      await expect(attendanceService.clockOut(staffCtx(fx, fx.staffUserId), { qrToken } as never)).rejects.toMatchObject({ response: { code: 'CLOCK_WINDOW_CLOSED' } });
      await expect(attendanceService.clockOut(staffCtx(fx, b.staffUserId), { qrToken } as never)).resolves.toMatchObject({ status: AttendanceStatus.CLOCKED_OUT });
    });
  });

  describe('offer expiry — proactive', () => {
    it('a PENDING offer past its expiresAt is transitioned to EXPIRED and the assigning manager is notified', async () => {
      const fx = await seedOrgFixture('offerexp');
      const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      let offerId!: string;
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        await m.update(ShiftAssignment, assignmentId, { status: ShiftAssignmentStatus.OFFERED });
        const offer = await m.save(JobOffer, {
          organisationId: fx.organisationId,
          shiftAssignmentId: assignmentId,
          staffProfileId: fx.staffProfileId,
          status: OfferStatus.PENDING,
          sentAt: new Date(Date.now() - 3600 * 1000),
          expiresAt: new Date(Date.now() - 60 * 1000),
          estimatedPayPence: 12000,
          createdBy: fx.managerUserId,
          workspaceId: fx.workspaceId,
        });
        offerId = offer.id;
      });

      await runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService);

      const offerAfter = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(JobOffer, { id: offerId }),
      );
      expect(offerAfter.status).toBe(OfferStatus.EXPIRED);

      const notified = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { userId: fx.managerUserId, type: NotificationType.OFFER_EXPIRED, relatedEntityId: offerId } }),
      );
      expect(notified).toHaveLength(1);
      void shiftId;
    });

    it('a PENDING offer not yet expired is left untouched', async () => {
      const fx = await seedOrgFixture('offernoexp');
      const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      let offerId!: string;
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        await m.update(ShiftAssignment, assignmentId, { status: ShiftAssignmentStatus.OFFERED });
        const offer = await m.save(JobOffer, {
          organisationId: fx.organisationId,
          shiftAssignmentId: assignmentId,
          staffProfileId: fx.staffProfileId,
          status: OfferStatus.PENDING,
          sentAt: new Date(),
          expiresAt: new Date(Date.now() + 3600 * 1000),
          estimatedPayPence: 12000,
          createdBy: fx.managerUserId,
          workspaceId: fx.workspaceId,
        });
        offerId = offer.id;
      });

      await runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService);

      const offerAfter = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(JobOffer, { id: offerId }),
      );
      expect(offerAfter.status).toBe(OfferStatus.PENDING);
    });
  });

  describe('cross-org isolation — one scan cycle processing candidates from two different organisations', () => {
    it('each candidate is scoped to its OWN organisation — no cross-org data bleed', async () => {
      const fxA = await seedOrgFixture('isoA');
      const fxB = await seedOrgFixture('isoB');
      const startsAt = new Date(Date.now() - 40 * 60 * 1000);
      const { assignmentId: assignmentA } = await seedConfirmedAssignment(fxA, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      const { assignmentId: assignmentB } = await seedConfirmedAssignment(fxB, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 0);

      const assignmentAAfter = await withContext({ organisationId: fxA.organisationId, workspaceId: fxA.workspaceId, userId: fxA.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentA }),
      );
      const assignmentBAfter = await withContext({ organisationId: fxB.organisationId, workspaceId: fxB.workspaceId, userId: fxB.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentB }),
      );
      expect(assignmentAAfter.status).toBe(ShiftAssignmentStatus.NO_SHOW);
      expect(assignmentBAfter.status).toBe(ShiftAssignmentStatus.NO_SHOW);

      // Org A's manager can never see org B's no-show notification, and vice versa (real RLS, not just a filtered query).
      const orgAVisibleToOrgB = await withContext({ organisationId: fxB.organisationId, workspaceId: fxB.workspaceId, userId: fxB.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityId: assignmentA } }),
      );
      expect(orgAVisibleToOrgB).toHaveLength(0);
    });
  });

  describe('maintenance — token cleanup', () => {
    // Retention history: 30 days → 91 (RefreshReuseRetentionExtension1786677900000) → 181
    // (WebSessionRetention1786717100000, owner decision 2026-10-14: manager web sessions live 180 days, so reuse
    // evidence must outlive them). The window is fixed inside core.worker_cleanup_auth_tokens; the codebase's record
    // of it is AUTH_TOKEN_CLEANUP_RETENTION_DAYS (retention-policy.spec.ts asserts it exceeds the longest absolute
    // session). This test used to hard-code 92 days — inside today's window — so it asserted a deletion the
    // documented policy forbids. It now straddles the boundary of the documented constant.
    const DAY_MS = 24 * 3600 * 1000;
    it('a refresh token expired more than the retention window ago is deleted; one still inside it is retained', async () => {
      expect(AUTH_TOKEN_CLEANUP_RETENTION_DAYS).toBe(181);
      const fx = await seedOrgFixture('tokclean');
      const oldTokenId = randomUUID();
      const insideWindowTokenId = randomUUID();
      const recentTokenId = randomUUID();
      const expiredDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        for (const [id, days] of [
          [oldTokenId, AUTH_TOKEN_CLEANUP_RETENTION_DAYS + 1],
          [insideWindowTokenId, AUTH_TOKEN_CLEANUP_RETENTION_DAYS - 1],
          [recentTokenId, 5],
        ] as const) {
          await m.insert(RefreshToken, {
            id,
            organisationId: fx.organisationId,
            userId: fx.managerUserId,
            tokenHash: `tok-${randomUUID()}`,
            familyId: randomUUID(),
            expiresAt: expiredDaysAgo(days),
            familyExpiresAt: expiredDaysAgo(days),
          });
        }
      });

      // The job deletes in bounded batches (production drains a backlog over successive ticks); drain the same way so
      // other suites' eligible rows on a shared test DB can't consume the batch before this test's row.
      for (let tick = 0; tick < 50; tick += 1) {
        if ((await runTokenCleanupCycle(adminDataSource)).refreshTokensDeleted === 0) break;
      }

      const find = (id: string) => adminDataSource.manager.findOne(RefreshToken, { where: { id } });
      expect(await find(oldTokenId)).toBeNull();
      expect(await find(insideWindowTokenId)).not.toBeNull();
      expect(await find(recentTokenId)).not.toBeNull();
    });
  });

  describe('deletion safety — a notification email queued for a since-deleted user is never sent', () => {
    it('the worker revalidates targetUserId and cancels rather than sends', async () => {
      const fx = await seedOrgFixture('notifdel');
      let outboxId!: string;
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        // Email delivery defaults OFF (see NotificationService.notify's own
        // doc comment) — opt this user in for this test, matching the real
        // precondition the service itself checks.
        await m.insert(NotificationPreference, {
          userId: fx.staffUserId,
          organisationId: fx.organisationId,
          notificationType: NotificationType.OFFER_SENT,
          inAppEnabled: true,
          emailEnabled: true,
        });
        // Same enqueue path NotificationService.notify() itself uses —
        // proves the generic worker revalidation (email-send.processor.ts's
        // `if (row.targetUserId)` check) protects notification emails too,
        // with zero notification-specific code needed.
        await notificationService.notify(m, {
          organisationId: fx.organisationId,
          userId: fx.staffUserId,
          type: NotificationType.OFFER_SENT,
          title: 'Test',
          message: 'Test message',
        });
        const outbox = await m.findOne(EmailOutbox, { where: { targetUserId: fx.staffUserId } });
        outboxId = outbox!.id;
        // Delete the target user directly (bypassing UserDeletionService's
        // own outbox-cancellation, deliberately — this test isolates the
        // WORKER's own defense-in-depth revalidation, not the deletion
        // service's proactive cancel, which is already covered by
        // user-deletion-abuse-cases.integration.spec.ts).
        await m.delete(User, { id: fx.staffUserId });
      });

      const fakeJob = { data: { emailOutboxId: outboxId, organisationId: fx.organisationId }, attemptsMade: 0, opts: { attempts: 5 } } as never;
      const neverCalled = { send: async () => { throw new Error('must never be called for a deleted target user'); } } as unknown as EmailService;
      const processor = createEmailSendProcessor({ tenantContext, emailService: neverCalled, auditService });
      await processor(fakeJob);

      const outboxAfter = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(EmailOutbox, { id: outboxId }),
      );
      expect(outboxAfter.status).toBe('CANCELLED');
    });
  });
});
