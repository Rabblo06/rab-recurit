/**
 * Staff Shift Reminders completion — item 11 of the approved spec: a real
 * `push_delivery` row is created when `PUSH_ENABLED=true` and the staff
 * member has an active registered device. Split into its own file/app
 * instance from `shift-monitor-clock-in-reminder.integration.spec.ts`
 * deliberately — `EnvironmentService` snapshots config once at boot, so the
 * "enabled" and "disabled" cases need two separate compiled app instances,
 * not one file toggling `process.env` mid-run (same documented limitation
 * `push-delivery.integration.spec.ts`/`push-delivery-dispatch.integration.
 * spec.ts` already rely on). This file never claims FCM/APNs device
 * delivery — only that the durable `push_delivery` row itself is created
 * correctly; see the Stage 6 report for that distinction.
 */
process.env.PUSH_ENABLED = 'true';

import 'reflect-metadata';
import { ManagerType, NotificationType, ShiftAssignmentStatus, UserStatus } from '@rab/shared';
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
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { StaffProfile } from '@rab/server/modules/staff/entities/staff-profile.entity';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

describeIfDb('shift monitor — clock-in reminder push fan-out (integration, PUSH_ENABLED=true)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let pushDeviceService: PushDeviceService;

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

  function ctxOf(fx: OrgFixture): AuthContext {
    return { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.staffUserId, role: '' };
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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    passwordHashing = app.get(PasswordHashingService);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    pushDeviceService = app.get(PushDeviceService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('11: an eligible staff member with an active registered device gets a push_delivery row for the clock-in-window-open notification', async () => {
    const fx = await seedOrgFixture('pushon');
    await pushDeviceService.register(ctxOf(fx), { deviceId: `d-${randomUUID()}`, platform: 'android', pushToken: `tok-${randomUUID()}` });

    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);

    const [reminder] = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.CLOCK_IN_WINDOW_OPEN } }),
    );
    expect(reminder).toBeDefined();
    const deliveries = await adminDataSource.manager.query(`SELECT status FROM core.push_delivery WHERE notification_id = $1`, [reminder!.id]);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe('PENDING'); // created durably — actual FCM/APNs submission is the worker-side dispatch cycle's job, not this one
  });

  it('a staff member with no registered device gets the notification but zero push_delivery rows', async () => {
    const fx = await seedOrgFixture('pushnodev');
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 4 * 3600 * 1000));

    await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);

    const [reminder] = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
      m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.CLOCK_IN_WINDOW_OPEN } }),
    );
    expect(reminder).toBeDefined();
    const deliveries = await adminDataSource.manager.query(`SELECT 1 FROM core.push_delivery WHERE notification_id = $1`, [reminder!.id]);
    expect(deliveries).toHaveLength(0);
  });
});
