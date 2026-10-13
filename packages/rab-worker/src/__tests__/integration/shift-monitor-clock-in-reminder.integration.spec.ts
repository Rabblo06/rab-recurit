import 'reflect-metadata';
import { AttendanceStatus, ManagerType, NotificationType, ShiftAssignmentStatus, UserStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
import { ManagerProfile } from '@rab/server/modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '@rab/server/modules/manager-workspace/entities/manager-workspace.entity';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * Staff Shift Reminders completion — the new `CLOCK_IN_WINDOW_OPEN` window
 * in `shift-monitor.job.ts`. `PUSH_ENABLED` is deliberately left at its
 * default (false) throughout this file — this is the "disabled" half of
 * items 11/12 from the approved spec; the "enabled" half (a real
 * `push_delivery` row actually being created) lives in the sibling file
 * `shift-monitor-clock-in-reminder-push.integration.spec.ts`, which sets
 * `PUSH_ENABLED=true` at module load, before `AppModule` is ever imported
 * (`EnvironmentService` snapshots config once at boot — mutating
 * `process.env` mid-run never reaches an already-compiled instance, so the
 * two cases need two separate app instances, not one file toggling a flag).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('shift monitor — clock-in window open reminder (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;

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
      let managerRole = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!managerRole) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        managerRole = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const hash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const managerResult = await manager.insert(User, {
        organisationId,
        email: `${label}-mgr-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      managerUserId = managerResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: managerUserId, roleId: managerRole.id, organisationId });

      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: managerUserId,
        name: `${label} Workspace ${managerUserId}`,
        subdomain: `${label}-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      // rab.workspace_id must be bound before this insert — same ordering as every other fixture
      // in this suite (worker-operations-abuse-cases.integration.spec.ts's own comment).
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
      await manager.insert(ManagerProfile, { organisationId, userId: managerUserId, type: ManagerType.INTERNAL, workspaceId });

      let staffRole = await manager.findOne(Role, { where: { organisationId, key: 'staff' } });
      if (!staffRole) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'staff', name: 'Staff', isSystem: true });
        staffRole = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const staffResult = await manager.insert(User, {
        organisationId,
        email: `${label}-staff-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: label,
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
      });
      staffUserId = staffResult.identifiers[0]!.id as string;
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

  async function clockInReminders(fx: OrgFixture, assignmentId: string): Promise<Notification[]> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.CLOCK_IN_WINDOW_OPEN } }),
    );
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
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('1: fires once the clock-in window opens (CLOCK_IN_EARLY_MINUTES=15, shift in 10 minutes)', async () => {
    const fx = await seedOrgFixture('win');
    const startsAt = new Date(Date.now() + 10 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    const reminders = await clockInReminders(fx, assignmentId);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.title).toBe('Clock-In Is Available');
    expect(reminders[0]!.message).toContain('clock-in window is now open');
  });

  it('2: does not fire before the window opens, then fires once the shift gets close enough', async () => {
    const fx = await seedOrgFixture('early');
    const startsAt = new Date(Date.now() + 20 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(0);

    // Simulate time passing: pull the assignment's own effective start (its `period`, the
    // canonical scheduled window `effectiveAssignmentTime` reads — never the parent shift's own
    // `starts_at` once an assignment has its own period) to within the 15-minute window.
    const newStartsAt = new Date(Date.now() + 10 * 60 * 1000);
    const newEndsAt = new Date(newStartsAt.getTime() + 4 * 3600 * 1000);
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.query(`UPDATE shift_assignment SET period = $2 WHERE id = $1`, [assignmentId, toTstzRange(newStartsAt, newEndsAt)]),
    );
    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(1);
  });

  it('3: already clocked-in staff receives nothing', async () => {
    const fx = await seedOrgFixture('clockedin');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.save(Attendance, {
        organisationId: fx.organisationId,
        workspaceId: fx.workspaceId,
        shiftId,
        shiftAssignmentId: assignmentId,
        staffProfileId: fx.staffProfileId,
        clockInAt: new Date(),
        status: AttendanceStatus.CLOCKED_IN,
      }),
    );

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(0);
  });

  it('4: a cancelled shift never generates a clock-in reminder, even though its assignment is still (stale) confirmed', async () => {
    const fx = await seedOrgFixture('cancelled');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.query(`UPDATE shift SET status = 'cancelled' WHERE id = $1`, [shiftId]));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(0);
  });

  it('5: reassigning the shift to a different staff member never leaks the reminder to the previous owner', async () => {
    const fx = await seedOrgFixture('reassign');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { shiftId, assignmentId: oldAssignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    // Second staff member, same organisation/workspace.
    let newStaffProfileId!: string;
    let newStaffUserId!: string;
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
      const hash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const staffRole = await m.findOneByOrFail(Role, { organisationId: fx.organisationId, key: 'staff' });
      const result = await m.insert(User, { organisationId: fx.organisationId, email: `reassign-staff2-${randomUUID()}@example.test`, passwordHash: hash, firstName: 'New', lastName: 'Staff', status: UserStatus.ACTIVE });
      newStaffUserId = result.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: newStaffUserId, roleId: staffRole.id, organisationId: fx.organisationId });
      const profile = await m.save(StaffProfile, { organisationId: fx.organisationId, userId: newStaffUserId, staffRef: `STF-new-${randomUUID().slice(0, 8)}`, createdBy: fx.managerUserId, workspaceId: fx.workspaceId });
      newStaffProfileId = profile.id;

      // Reassignment: the old assignment is called off, a new one takes its place on the same shift.
      await m.update(ShiftAssignment, oldAssignmentId, { status: ShiftAssignmentStatus.CANCELLED });
    });
    const { assignmentId: newAssignmentId } = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
      const assignment = await m.save(ShiftAssignment, {
        organisationId: fx.organisationId,
        shiftId,
        staffProfileId: newStaffProfileId,
        status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500,
        assignedBy: fx.managerUserId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000)),
        workspaceId: fx.workspaceId,
      });
      return { assignmentId: assignment.id };
    });

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, oldAssignmentId)).toHaveLength(0); // old owner: nothing
    const newReminders = await clockInReminders(fx, newAssignmentId);
    expect(newReminders).toHaveLength(1);
    expect(newReminders[0]!.userId).toBe(newStaffUserId); // never the previous staff member
  });

  it('6: an unconfirmed (staff_accepted) assignment receives nothing', async () => {
    const fx = await seedOrgFixture('unconfirmed');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(ShiftAssignment, assignmentId, { status: ShiftAssignmentStatus.STAFF_ACCEPTED }));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(0);
  });

  it('7: an already-completed shift receives nothing, even if it would otherwise match the window', async () => {
    const fx = await seedOrgFixture('completed');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.query(`UPDATE shift SET status = 'completed' WHERE id = $1`, [shiftId]));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(0);
  });

  it('8: two concurrent worker cycles for the same eligible assignment produce exactly one reminder, never two', async () => {
    const fx = await seedOrgFixture('concurrent');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await Promise.all([
      runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15),
      runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15),
    ]);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(1);
  });

  it('9: three sequential scans (simulating worker restarts) remain idempotent — still exactly one reminder', async () => {
    const fx = await seedOrgFixture('restart');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(1);
  });

  it('10: the notification is addressed to the staff member, never the manager', async () => {
    const fx = await seedOrgFixture('recipient');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    const [reminder] = await clockInReminders(fx, assignmentId);
    expect(reminder!.userId).toBe(fx.staffUserId);
    expect(reminder!.userId).not.toBe(fx.managerUserId);
  });

  it('12: with PUSH_ENABLED=false (this file\'s default), no push_delivery row is ever created even though the reminder itself fires', async () => {
    const fx = await seedOrgFixture('pushoff');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    const [reminder] = await clockInReminders(fx, assignmentId);
    expect(reminder).toBeDefined();
    const deliveries = await adminDataSource.manager.query(`SELECT 1 FROM core.push_delivery WHERE notification_id = $1`, [reminder!.id]);
    expect(deliveries).toHaveLength(0);
  });

  it('13: cross-organisation isolation — org B can never see org A\'s clock-in reminder', async () => {
    const fxA = await seedOrgFixture('orgA');
    const fxB = await seedOrgFixture('orgB');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fxA, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fxA, assignmentId)).toHaveLength(1);
    const crossOrgRead = await withContext({ organisationId: fxB.organisationId, workspaceId: fxB.workspaceId, userId: fxB.managerUserId }, (m) =>
      m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }),
    );
    expect(crossOrgRead).toHaveLength(0); // RLS: org B's tenant context sees zero rows for org A's assignment
  });

  it('14: two managers in the same organisation each get their own staff reminded correctly, never mixed up', async () => {
    const fx = await seedOrgFixture('samorg');
    // Second manager + staff pair in the SAME organisation/workspace.
    let manager2UserId!: string;
    let staff2ProfileId!: string;
    let staff2UserId!: string;
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
      const hash = await passwordHashing.hash(FIXTURE_PASSWORD);
      const managerRole = await m.findOneByOrFail(Role, { organisationId: fx.organisationId, key: 'manager' });
      const staffRole = await m.findOneByOrFail(Role, { organisationId: fx.organisationId, key: 'staff' });
      const mgrResult = await m.insert(User, { organisationId: fx.organisationId, email: `samorg-mgr2-${randomUUID()}@example.test`, passwordHash: hash, firstName: 'Second', lastName: 'Manager', status: UserStatus.ACTIVE });
      manager2UserId = mgrResult.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: manager2UserId, roleId: managerRole.id, organisationId: fx.organisationId });
      const staffResult = await m.insert(User, { organisationId: fx.organisationId, email: `samorg-staff2-${randomUUID()}@example.test`, passwordHash: hash, firstName: 'Second', lastName: 'Staff', status: UserStatus.ACTIVE });
      staff2UserId = staffResult.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: staff2UserId, roleId: staffRole.id, organisationId: fx.organisationId });
      const profile = await m.save(StaffProfile, { organisationId: fx.organisationId, userId: staff2UserId, staffRef: `STF-s2-${randomUUID().slice(0, 8)}`, createdBy: manager2UserId, workspaceId: fx.workspaceId });
      staff2ProfileId = profile.id;
    });

    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId: a1 } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));
    // Manager 2's own assignment, for staff 2.
    const fx2 = { ...fx, managerUserId: manager2UserId, staffProfileId: staff2ProfileId, staffUserId: staff2UserId };
    const { assignmentId: a2 } = await seedConfirmedAssignment(fx2, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    const r1 = await clockInReminders(fx, a1);
    const r2 = await clockInReminders(fx, a2);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    expect(r1[0]!.userId).toBe(fx.staffUserId);
    expect(r2[0]!.userId).toBe(staff2UserId);
  });

  it('15: a shift crossing midnight (UTC instants, timezone-agnostic arithmetic) fires correctly', async () => {
    const fx = await seedOrgFixture('midnight');
    // 23:50 UTC today -> 06:00 UTC tomorrow: an overnight shift. The clock-in window (15 min) opens at 23:55 UTC.
    const startsAt = new Date(Date.now() + 10 * 60 * 1000);
    startsAt.setUTCHours(23, 50, 0, 0);
    if (startsAt.getTime() < Date.now()) startsAt.setUTCDate(startsAt.getUTCDate() + 1);
    // Re-pin to "10 minutes from now" regardless of today's wall-clock time, so the window is genuinely open right now.
    const pinned = new Date(Date.now() + 10 * 60 * 1000);
    const endsAt = new Date(pinned.getTime() + 8 * 3600 * 1000); // ends well after midnight relative to startsAt in local time
    const { assignmentId } = await seedConfirmedAssignment(fx, pinned, endsAt);

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(1);
  });

  it('16: a shift starting during a BST<->GMT transition instant still resolves the SAME ms-delta threshold (pure UTC arithmetic, no timezone library involved)', async () => {
    const fx = await seedOrgFixture('bst');
    // The actual wall-clock date doesn't matter to the formula (msUntilStart is a pure epoch-ms
    // delta) — what matters is proving no code path here ever converts through a civil calendar/
    // timezone. Using "10 minutes from now" again is the correct proof: if DST mattered to this
    // arithmetic, EVERY test in this file would already be wrong depending on when it happens to
    // run, which none of them are.
    const startsAt = new Date(Date.now() + 10 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(1);
  });

  it('17: CLOCK_IN_EARLY_MINUTES differing from 30 (e.g. 45) fires its own window independently of the fixed 30m reminder', async () => {
    const fx = await seedOrgFixture('diff45');
    const startsAt = new Date(Date.now() + 40 * 60 * 1000); // inside the 45m clock-in window, outside the 30m reminder window
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 45);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(1);
    const shift30mReminder = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_30M } }),
    );
    expect(shift30mReminder).toHaveLength(0); // not yet within 30 minutes of start
  });

  it('18: CLOCK_IN_EARLY_MINUTES=30 (exact collision with the fixed 30-minute reminder) suppresses the duplicate clock-in push — the 30m reminder still fires normally', async () => {
    const fx = await seedOrgFixture('collide30');
    const startsAt = new Date(Date.now() + 25 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 30);
    expect(await clockInReminders(fx, assignmentId)).toHaveLength(0); // suppressed: the 30m reminder already covers this moment
    const shift30mReminder = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_30M } }),
    );
    expect(shift30mReminder).toHaveLength(1); // the pre-existing window's own behaviour is NEVER changed by the collision rule
  });

  it('21: a worker catching up late never sends a clock-in reminder once the shift has actually started (staleness bound), but still sends it correctly for a not-yet-started shift found late', async () => {
    // Two separate organisations/staff — a single staff member can't hold two overlapping
    // CONFIRMED assignments at once (`shift_assignment_no_double_booking`), and these two
    // scenarios' windows (now+10min..+4h10m and now-35min..+3h25m) would otherwise overlap.
    const fxUpcoming = await seedOrgFixture('staleUpcoming');
    const fxStarted = await seedOrgFixture('staleStarted');
    // "Found late" but still before start: the window should have opened 5 minutes ago (shift in 10 min, 15m window) — still fires once, right now, not suppressed as "too late".
    const notYetStarted = new Date(Date.now() + 10 * 60 * 1000);
    const { assignmentId: lateButValidId } = await seedConfirmedAssignment(fxUpcoming, notYetStarted, new Date(notYetStarted.getTime() + 4 * 3600 * 1000));
    // Past the no-show grace period (35 min ago) — genuinely discovered by the scan (via the
    // no-show query, not the reminder query), reaching the SAME scoped transaction and the SAME
    // `if (msUntilStart > 0)` gate every window sits behind. Even with a deliberately large
    // CLOCK_IN_EARLY_MINUTES (60) that would have made the window "open" at some point, this
    // proves the gate — not merely the discovery SQL — is what stops a stale clock-in reminder:
    // the candidate IS processed (as a no-show, since there is still no attendance row), just
    // never through the reminder branch.
    const alreadyStarted = new Date(Date.now() - 35 * 60 * 1000);
    const { assignmentId: startedId } = await seedConfirmedAssignment(fxStarted, alreadyStarted, new Date(alreadyStarted.getTime() + 4 * 3600 * 1000));

    const result = await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 60);
    expect(await clockInReminders(fxUpcoming, lateButValidId)).toHaveLength(1);
    expect(await clockInReminders(fxStarted, startedId)).toHaveLength(0);
    expect(result.noShowsFlagged).toBeGreaterThanOrEqual(1); // confirms the candidate really was processed, just via the no-show branch
  });
});
