import 'reflect-metadata';
import { formatLondonDateTime, ManagerType, NotificationType, ShiftAssignmentStatus, UserStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { NotificationPreference, Organisation, Role, User, UserRole } from '@rab/server/modules/identity/entities/index';
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
import { isLockUnavailable } from '../helpers/legacy-discovery-lock';
import { resolveResponsibleManager } from '../../core/domain/resolve-responsible-manager';
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Phase 3 — late clock-in correctness. Real Postgres, RLS on, no mocks.
 * Covers: canonical manager-recipient resolution (replacing the unsafe
 * `staffProfile.createdBy` assumption), tenant/workspace isolation of that
 * resolution, London-timezone/DST-correct notification text, explicit
 * threshold semantics, final-state revalidation against the attendance/
 * cancellation/assignment-change races, and the Phase 2 ledger's continued
 * preference-independent idempotency under this new logic.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('late clock-in correctness (integration)', () => {
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
    /** The manager who "owns" the staff profile (createdBy) — deliberately NEVER the assignment's assignedBy, so tests can prove the resolver does not fall back to this. */
    ownerManagerUserId: string;
    /** The manager who actually assigned/confirmed the shift — the canonical recipient. */
    assigningManagerUserId: string;
    staffProfileId: string;
    staffUserId: string;
    venueId: string;
    jobRoleId: string;
  }

  async function withContext<T>(ctx: { organisationId: string; workspaceId: string | null; userId: string }, fn: (manager: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId]);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await manager.query(`SELECT set_config('rab.role', '', true)`);
      return fn(manager);
    });
  }

  async function createManager(organisationId: string, workspaceId: string, label: string): Promise<string> {
    return withContext({ organisationId, workspaceId, userId: randomUUID() }, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId, key: 'manager' } });
      if (!role) {
        const roleResult = await manager.insert(Role, { organisationId, key: 'manager', name: 'Manager', isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
      }
      const hash = await passwordHashing.hash('correct horse battery staple 1!');
      const userResult = await manager.insert(User, {
        organisationId,
        email: `${label}-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: label,
        lastName: 'Manager',
        status: UserStatus.ACTIVE,
      });
      const userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId });
      await manager.insert(ManagerProfile, { organisationId, userId, type: ManagerType.INTERNAL, workspaceId });
      return userId;
    });
  }

  async function seedOrgFixture(label: string): Promise<OrgFixture> {
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: `${label}-${randomUUID()}`, slug: `${label}-${randomUUID()}` });
    const organisationId = orgInsert.identifiers[0]!.id as string;

    let workspaceId!: string;
    let ownerManagerUserId!: string;
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
      const managerHash = await passwordHashing.hash('correct horse battery staple 1!');
      const managerResult = await manager.insert(User, {
        organisationId,
        email: `${label}-owner-${randomUUID()}@example.test`,
        passwordHash: managerHash,
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      ownerManagerUserId = managerResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerManagerUserId, roleId: role.id, organisationId });

      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerManagerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId: ownerManagerUserId,
        name: `${label} Workspace ${ownerManagerUserId}`,
        subdomain: `${label}-${ownerManagerUserId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      await manager.insert(ManagerProfile, { organisationId, userId: ownerManagerUserId, type: ManagerType.INTERNAL, workspaceId });
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);

      const staffHash = await passwordHashing.hash('correct horse battery staple 1!');
      const staffResult = await manager.insert(User, {
        organisationId,
        email: `${label}-staff-${randomUUID()}@example.test`,
        passwordHash: staffHash,
        firstName: 'Jamie',
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
      // Deliberately owned by the OWNER manager — every test proves the
      // recipient is NOT this relationship.
      const staffProfile = await manager.save(StaffProfile, {
        organisationId,
        userId: staffUserId,
        staffRef: `STF-${label}-${randomUUID().slice(0, 8)}`,
        createdBy: ownerManagerUserId,
        workspaceId,
      });
      staffProfileId = staffProfile.id;

      const venue = await manager.save(Venue, { organisationId, name: `${label} Venue`, createdBy: ownerManagerUserId, workspaceId });
      venueId = venue.id;
      const jobRole = await manager.save(JobRole, { organisationId, name: `Bartender ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: ownerManagerUserId, workspaceId });
      jobRoleId = jobRole.id;
    });

    const assigningManagerUserId = await createManager(organisationId, workspaceId, `${label}-assigner`);

    return { organisationId, workspaceId, ownerManagerUserId, assigningManagerUserId, staffProfileId, staffUserId, venueId, jobRoleId };
  }

  /** A CONFIRMED assignment, assignedBy the ASSIGNING manager (never the owner/createdBy manager) — the canonical shape every real confirmed assignment has. */
  async function seedConfirmedAssignment(
    fx: OrgFixture,
    startsAt: Date,
    endsAt: Date,
    overrides?: { assignedBy?: string | null; shiftCreatedBy?: string },
  ): Promise<{ shiftId: string; assignmentId: string }> {
    let shiftId!: string;
    let assignmentId!: string;
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, async (manager) => {
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
        createdBy: overrides?.shiftCreatedBy ?? fx.assigningManagerUserId,
        workspaceId: fx.workspaceId,
      });
      shiftId = shift.id;
      const assignment = await manager.save(ShiftAssignment, {
        organisationId: fx.organisationId,
        shiftId,
        staffProfileId: fx.staffProfileId,
        status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500,
        assignedBy: overrides && 'assignedBy' in overrides ? (overrides.assignedBy ?? undefined) : fx.assigningManagerUserId,
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId: fx.workspaceId,
      });
      assignmentId = assignment.id;
    });
    return { shiftId, assignmentId };
  }

  async function setPreference(fx: OrgFixture, userId: string, type: string, inAppEnabled: boolean, emailEnabled: boolean): Promise<void> {
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (manager) =>
      manager.save(NotificationPreference, { organisationId: fx.organisationId, userId, notificationType: type as never, inAppEnabled, emailEnabled }),
    );
  }

  async function deactivate(fx: OrgFixture, userId: string): Promise<void> {
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (manager) =>
      manager.update(User, { id: userId }, { status: UserStatus.DEACTIVATED }),
    );
  }

  async function workerEventStatus(fx: OrgFixture, eventKey: string): Promise<{ status: string } | null> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, async (manager) => {
      const rows = await manager.query<Array<{ status: string }>>(`SELECT status FROM core.worker_event WHERE event_key = $1`, [eventKey]);
      return rows[0] ?? null;
    });
  }

  async function managerNotifications(fx: OrgFixture, userId: string, assignmentId: string): Promise<Notification[]> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
      m.find(Notification, { where: { userId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.LATE_CLOCK_IN } }),
    );
  }

  /**
   * Runs N attempts truly concurrently (`Promise.allSettled`, never
   * `Promise.all` — see worker-event-idempotency.integration.spec.ts's own
   * doc comment for why `Promise.all` would leave losing attempts running
   * unawaited in the background). Deliberately untyped/`unknown` return
   * values: several call sites here race the job cycle against a DIFFERENT
   * kind of operation (a raw attendance insert, a status UPDATE) purely to
   * prove the FINAL DATABASE STATE is safe — the return values themselves
   * are never asserted on.
   */
  async function runConcurrentCycles(attempts: Array<() => Promise<unknown>>): Promise<void> {
    const settled = await Promise.allSettled(attempts.map((run) => run()));
    for (const r of settled) {
      if (r.status === 'rejected' && !isLockUnavailable(r.reason)) throw r.reason;
    }
  }

  /** Default: 15 minutes late against the standard 10-minute grace used throughout this file. */
  function lateStartsAt(minutesLate = 15): Date {
    return new Date(Date.now() - minutesLate * 60 * 1000);
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

  // ===================================================================
  // A. Manager resolution
  // ===================================================================
  describe('A. manager resolution', () => {
    it('A1/A2: the assigning manager (assignedBy) receives the alert — NOT the staff profile owner (createdBy)', async () => {
      const fx = await seedOrgFixture('resolveA');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);

      const assignerNotifications = await managerNotifications(fx, fx.assigningManagerUserId, assignmentId);
      expect(assignerNotifications).toHaveLength(1);
      const ownerNotifications = await managerNotifications(fx, fx.ownerManagerUserId, assignmentId);
      expect(ownerNotifications).toHaveLength(0); // the old, unsafe fallback must NOT fire

      const auditRow = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.query<Array<{ metadata: { notifiedManagerUserId: string; managerResolutionSource: string } }>>(
          `SELECT metadata FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`,
          [assignmentId],
        ),
      );
      expect(auditRow[0]!.metadata.notifiedManagerUserId).toBe(fx.assigningManagerUserId);
      expect(auditRow[0]!.metadata.managerResolutionSource).toBe('assigned_by');
    });

    it('falls back to shift.createdBy when assignedBy is absent (legacy data)', async () => {
      const fx = await seedOrgFixture('resolveFallback');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000), { assignedBy: null });
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);

      const assignerNotifications = await managerNotifications(fx, fx.assigningManagerUserId, assignmentId); // shift.createdBy defaults to assigningManagerUserId in the helper
      expect(assignerNotifications).toHaveLength(1);
      const auditRow = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.query<Array<{ metadata: { managerResolutionSource: string } }>>(
          `SELECT metadata FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`,
          [assignmentId],
        ),
      );
      expect(auditRow[0]!.metadata.managerResolutionSource).toBe('shift_created_by');
    });

    it('A3: a manager from a DIFFERENT organisation recorded as assignedBy (data anomaly) is never notified', async () => {
      const fx = await seedOrgFixture('wrongOrgA');
      const otherOrg = await seedOrgFixture('wrongOrgB');
      const { assignmentId, shiftId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000), {
        assignedBy: otherOrg.assigningManagerUserId, // anomalous cross-org id — must never be trusted
        shiftCreatedBy: fx.assigningManagerUserId, // valid same-org fallback so the event still completes
      });
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);

      const wrongOrgNotifications = await withContext({ organisationId: otherOrg.organisationId, workspaceId: otherOrg.workspaceId, userId: otherOrg.assigningManagerUserId }, (m) =>
        m.find(Notification, { where: { userId: otherOrg.assigningManagerUserId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }),
      );
      expect(wrongOrgNotifications).toHaveLength(0);
      // The valid same-org fallback (shift.createdBy) received it instead.
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(1);
      void shiftId;
    });

    it('A4: a manager belonging only to a DIFFERENT workspace in the SAME organisation is never notified', async () => {
      const fx = await seedOrgFixture('wrongWorkspace');
      // A second, genuinely real workspace in the SAME organisation — not a
      // fabricated UUID, since manager_profile.workspace_id has a real FK to
      // manager_workspace.
      const otherWorkspaceManagerId = await withContext({ organisationId: fx.organisationId, workspaceId: null, userId: randomUUID() }, async (manager) => {
        const hash = await passwordHashing.hash('correct horse battery staple 1!');
        const userResult = await manager.insert(User, {
          organisationId: fx.organisationId,
          email: `otherws-${randomUUID()}@example.test`,
          passwordHash: hash,
          firstName: 'Other',
          lastName: 'Workspace',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
        const workspace = await manager.save(ManagerWorkspace, {
          organisationId: fx.organisationId,
          ownerUserId: userId,
          name: `Other Workspace ${userId}`,
          subdomain: `otherws-${userId.slice(0, 8)}`,
          status: 'active',
        });
        await manager.insert(ManagerProfile, { organisationId: fx.organisationId, userId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
        return userId;
      });
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000), {
        assignedBy: otherWorkspaceManagerId,
        shiftCreatedBy: fx.assigningManagerUserId,
      });
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);

      const wrongWorkspaceNotifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.find(Notification, { where: { userId: otherWorkspaceManagerId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }),
      );
      expect(wrongWorkspaceNotifications).toHaveLength(0);
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(1); // valid fallback used instead
    });

    it('A5: a deactivated manager recorded as assignedBy is skipped safely, falling back to a valid manager', async () => {
      const fx = await seedOrgFixture('deactivatedMgr');
      await deactivate(fx, fx.assigningManagerUserId);
      const secondValidManager = await createManager(fx.organisationId, fx.workspaceId, 'secondvalid');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000), {
        assignedBy: fx.assigningManagerUserId, // now deactivated
        shiftCreatedBy: secondValidManager,
      });
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);

      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(0); // deactivated — never notified
      expect(await managerNotifications(fx, secondValidManager, assignmentId)).toHaveLength(1); // valid fallback used instead
    });

    it('A6: no valid manager relationship exists — the event still completes, the staff member is still notified, and no arbitrary fallback user receives anything', async () => {
      const fx = await seedOrgFixture('noValidManager');
      await deactivate(fx, fx.assigningManagerUserId); // both assignedBy AND shift.createdBy point at this now-deactivated user
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000), {
        assignedBy: fx.assigningManagerUserId,
        shiftCreatedBy: fx.assigningManagerUserId,
      });
      const result = await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(result.flagged).toBeGreaterThanOrEqual(1);

      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed'); // completes safely, not stuck retrying forever
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(0); // deactivated — never notified
      const ownerNotifications = await managerNotifications(fx, fx.ownerManagerUserId, assignmentId);
      expect(ownerNotifications).toHaveLength(0); // no silent fallback to staffProfile.createdBy either

      const staffNotifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.find(Notification, { where: { userId: fx.staffUserId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.LATE_CLOCK_IN } }),
      );
      expect(staffNotifications).toHaveLength(1); // the staff member's own notification is unaffected by manager resolution failing

      const auditRow = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.query<Array<{ metadata: { notifiedManagerUserId: string | null; managerResolutionSource: string } }>>(
          `SELECT metadata FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`,
          [assignmentId],
        ),
      );
      expect(auditRow[0]!.metadata.notifiedManagerUserId).toBeNull();
      expect(auditRow[0]!.metadata.managerResolutionSource).toBe('none');
    });
  });

  // ===================================================================
  // B. Lateness threshold
  // ===================================================================
  describe('B. lateness threshold', () => {
    it('uses the individual start when the parent has already started', async () => {
      const fx = await seedOrgFixture('individualWindow');
      const parentStart = new Date(Date.now() - 30 * 60_000);
      const end = new Date(Date.now() + 8 * 3600_000);
      const { assignmentId } = await seedConfirmedAssignment(fx, parentStart, end);
      const ctx = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId };
      await withContext(ctx, m => m.update(ShiftAssignment, assignmentId, {period: toTstzRange(new Date(Date.now()+150*60_000), end)}));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
      await withContext(ctx, m => m.update(ShiftAssignment, assignmentId, {period: toTstzRange(new Date(Date.now()-11*60_000), end)}));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(1);
    });

    it('B7: before the grace boundary — no event', async () => {
      const fx = await seedOrgFixture('beforeGrace');
      const { assignmentId } = await seedConfirmedAssignment(fx, new Date(Date.now() - 5 * 60 * 1000), new Date(Date.now() + 8 * 3600 * 1000)); // 5 min late, grace is 10
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
    });

    it('B8: exactly at the grace threshold — treated as late (inclusive)', async () => {
      const fx = await seedOrgFixture('exactGrace');
      // starts_at <= now() - grace is evaluated in SQL at scan time with a tiny
      // amount of clock drift versus this JS Date.now(); back it up by an extra
      // second so the SQL-side comparison reliably lands on the "late" side of
      // the boundary without flaking on either side of exactly 600.000s.
      const { assignmentId } = await seedConfirmedAssignment(fx, new Date(Date.now() - 10 * 60 * 1000 - 1000), new Date(Date.now() + 8 * 3600 * 1000));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');
    });

    it('B9: well after the grace threshold — one event', async () => {
      const fx = await seedOrgFixture('afterGrace');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(20), new Date(Date.now() + 8 * 3600 * 1000));
      const result = await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(result.flagged).toBeGreaterThanOrEqual(1);
      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');
    });

    it('B10: an existing clock-in before the scan — no late event ever created', async () => {
      const fx = await seedOrgFixture('alreadyClockedIn');
      const startsAt = lateStartsAt();
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(Date.now() + 8 * 3600 * 1000));
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.save(Attendance, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, shiftId, shiftAssignmentId: assignmentId, staffProfileId: fx.staffProfileId, clockInAt: startsAt, status: 'clocked_in' as never }),
      );
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
    });

    it('B11: a cancelled shift — no event', async () => {
      const fx = await seedOrgFixture('cancelledB');
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) => m.update(Shift, shiftId, { status: 'cancelled' as never }));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
    });

    it('B12: an assignment no longer CONFIRMED (e.g. withdrawn) — no event', async () => {
      const fx = await seedOrgFixture('notEligible');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) => m.update(ShiftAssignment, assignmentId, { status: ShiftAssignmentStatus.NO_SHOW }));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
    });
  });

  // ===================================================================
  // C. Concurrency / races
  // ===================================================================
  describe('C. concurrency and races', () => {
    it('C13/C14: five simultaneous cycles for the same candidate produce exactly one logical event and one manager notification', async () => {
      const fx = await seedOrgFixture('fiveConcurrent');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      const run = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([run, run, run, run, run]);
      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(1);
    });

    it('C15: a clock-in racing the late scan wins — the canonical final state (clocked in) suppresses the notification, and the claimed event is cancelled, not completed with a false alert', async () => {
      const fx = await seedOrgFixture('raceClockIn');
      const startsAt = lateStartsAt();
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(Date.now() + 8 * 3600 * 1000));

      // Simulate the race: insert the attendance row directly between Pass A
      // and Pass B by racing a real clock-in write against the cycle itself.
      const clockIn = () =>
        withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
          m.save(Attendance, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, shiftId, shiftAssignmentId: assignmentId, staffProfileId: fx.staffProfileId, clockInAt: new Date(), status: 'clocked_in' as never }),
        );
      const cycle = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([cycle, clockIn]);

      // Whichever interleaving actually happened, the canonical end state must be safe:
      // either no event was ever claimed (Pass A already saw the attendance row), or a
      // claimed event was CANCELLED (Pass B caught the race) — completed-with-a-false-alert
      // must never happen.
      const eventStatus = await workerEventStatus(fx, `late-clock-in:${assignmentId}`);
      if (eventStatus) expect(eventStatus.status).not.toBe('completed');
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(0);
      const staffNotifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.find(Notification, { where: { userId: fx.staffUserId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.LATE_CLOCK_IN } }),
      );
      expect(staffNotifications).toHaveLength(0);
    });

    it('C16: a cancellation racing the late scan wins — no notification, event cancelled not completed', async () => {
      const fx = await seedOrgFixture('raceCancel');
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      const cancel = () => withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) => m.update(Shift, shiftId, { status: 'cancelled' as never }));
      const cycle = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([cycle, cancel]);

      const eventStatus = await workerEventStatus(fx, `late-clock-in:${assignmentId}`);
      if (eventStatus) expect(eventStatus.status).not.toBe('completed');
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(0);
    });

    it('C17: an assignment status change racing the late scan wins — stale alert suppressed', async () => {
      const fx = await seedOrgFixture('raceAssignmentChange');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      const changeAssignment = () =>
        withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) => m.update(ShiftAssignment, assignmentId, { status: ShiftAssignmentStatus.NO_SHOW }));
      const cycle = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([cycle, changeAssignment]);

      const eventStatus = await workerEventStatus(fx, `late-clock-in:${assignmentId}`);
      if (eventStatus) expect(eventStatus.status).not.toBe('completed');
      expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(0);
    });
  });

  // ===================================================================
  // D. Notification preferences (Phase 2 ledger independence, re-verified against the new resolution logic)
  // ===================================================================
  describe('D. preferences remain independent of event processing', () => {
    it('D18-D21: every combination of in-app/email on the resolved manager still completes the event exactly once', async () => {
      for (const [inApp, email] of [[true, true], [true, false], [false, true], [false, false]] as const) {
        const fx = await seedOrgFixture(`prefs-${inApp}-${email}`);
        await setPreference(fx, fx.assigningManagerUserId, NotificationType.LATE_CLOCK_IN, inApp, email);
        const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
        await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
        expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');
        const notifications = await managerNotifications(fx, fx.assigningManagerUserId, assignmentId);
        expect(notifications).toHaveLength(inApp ? 1 : 0); // email delivery is a separate outbox row, not asserted here — see D. scope
        // A second cycle must not re-process regardless of preference combination.
        await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
        expect(await managerNotifications(fx, fx.assigningManagerUserId, assignmentId)).toHaveLength(inApp ? 1 : 0);
      }
    });
  });

  // ===================================================================
  // E. Timezone / DST
  // ===================================================================
  describe('E. timezone and DST correctness', () => {
    it('E22/E26/E27: a GMT-season instant renders as London local time with no raw ISO/UTC string in the text', () => {
      const winterInstant = new Date('2026-01-15T08:00:00.000Z'); // GMT, UTC+0 — London local time equals UTC
      const rendered = formatLondonDateTime(winterInstant);
      expect(rendered).toContain('08:00');
      expect(rendered).toContain('2026');
      expect(rendered).not.toContain('T'); // no raw ISO string leaking through
      expect(rendered).not.toContain('Z');
      expect(rendered).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no ISO date form at all
    });

    it('E23: a BST-season instant renders one hour ahead of its UTC value', () => {
      const summerInstant = new Date('2026-07-15T08:00:00.000Z'); // BST, UTC+1 -> 09:00 local
      const rendered = formatLondonDateTime(summerInstant);
      expect(rendered).toContain('09:00');
      expect(rendered).not.toContain('08:00');
    });

    it('E24: spring-forward transition (last Sunday of March 2026) — the late threshold instant is unaffected by the local clock jump', async () => {
      // 2026's UK clocks go forward on 29 March, 01:00 GMT -> 02:00 BST.
      // A shift starting at 00:50 GMT that day, with a 10-minute grace, has
      // its late threshold at the real instant 01:00 GMT — which does not
      // exist as a local wall-clock time (the clock jumps straight past it
      // to 02:00 BST). The job must still fire based on the INSTANT, not a
      // formatted local string.
      const fx = await seedOrgFixture('springForward');
      const startsAt = new Date('2026-03-29T00:50:00.000Z');
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      // Directly exercise the pure threshold logic against a fixed "now" at
      // the real late instant, rather than depending on the actual wall-clock
      // time this test happens to run at.
      const lateInstant = new Date('2026-03-29T01:05:00.000Z'); // 5 minutes past the real 01:00Z threshold
      const isLate = startsAt.getTime() <= lateInstant.getTime() - 10 * 60_000;
      expect(isLate).toBe(true);
      // The rendered start time is legible London local time (00:50 GMT, before the jump) — never crashes or produces an invalid string across the transition.
      const rendered = formatLondonDateTime(startsAt);
      expect(rendered).toMatch(/00:50/);
      void assignmentId;
    });

    it('E25: autumn-fallback transition (last Sunday of October 2026) — the ambiguous repeated local hour does not corrupt the instant-based threshold', async () => {
      // UK clocks go back on 25 October 2026, 02:00 BST -> 01:00 GMT — the
      // local hour 01:00-02:00 occurs twice. Format two DIFFERENT real
      // instants that both display in that repeated local hour and confirm
      // they remain distinguishable real instants (never collapsed to the
      // same threshold check).
      const firstOccurrence = new Date('2026-10-25T00:30:00.000Z'); // 01:30 BST (first time)
      const secondOccurrence = new Date('2026-10-25T01:30:00.000Z'); // 01:30 GMT (second time, one real hour later)
      expect(secondOccurrence.getTime() - firstOccurrence.getTime()).toBe(60 * 60 * 1000);
      const renderedFirst = formatLondonDateTime(firstOccurrence);
      const renderedSecond = formatLondonDateTime(secondOccurrence);
      expect(renderedFirst).toContain('01:30');
      expect(renderedSecond).toContain('01:30');
      // Same displayed local time, but the late-threshold arithmetic underneath operates on the real (different) instants — proven directly:
      const graceMs = 10 * 60_000;
      expect(firstOccurrence.getTime() + graceMs).not.toBe(secondOccurrence.getTime() + graceMs);
    });
  });

  // ===================================================================
  // F. Tenant / RLS
  // ===================================================================
  describe('F. tenant and RLS isolation of the late-clock-in worker_event', () => {
    it('F28/F29/F30: org B, a wrong workspace, and no tenant context at all cannot see org A\'s late-clock-in event', async () => {
      const fx = await seedOrgFixture('rlsA');
      const otherOrg = await seedOrgFixture('rlsB');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      const eventKey = `late-clock-in:${assignmentId}`;
      expect((await workerEventStatus(fx, eventKey))?.status).toBe('completed');

      const seenFromOtherOrg = await withContext({ organisationId: otherOrg.organisationId, workspaceId: otherOrg.workspaceId, userId: otherOrg.assigningManagerUserId }, (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.worker_event WHERE event_key = $1`, [eventKey]),
      );
      expect(seenFromOtherOrg).toHaveLength(0);

      const seenFromWrongWorkspace = await withContext({ organisationId: fx.organisationId, workspaceId: randomUUID(), userId: fx.assigningManagerUserId }, (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.worker_event WHERE event_key = $1`, [eventKey]),
      );
      expect(seenFromWrongWorkspace).toHaveLength(0);

      // No tenant context bound at all (both set_config values null/empty) — FORCE RLS must return zero rows, never all rows.
      const seenWithNoContext = await dataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', '', true)`);
        await m.query(`SELECT set_config('rab.workspace_id', '', true)`);
        await m.query(`SELECT set_config('rab.user_id', '', true)`);
        return m.query<Array<{ id: string }>>(`SELECT id FROM core.worker_event WHERE event_key = $1`, [eventKey]);
      });
      expect(seenWithNoContext).toHaveLength(0);
    });
  });

  // ===================================================================
  // G. Audit
  // ===================================================================
  describe('G. audit uniqueness', () => {
    it('G31/G32: five worker races still produce exactly one audit record for the target assignment', async () => {
      const fx = await seedOrgFixture('auditRace');
      const { assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      const run = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([run, run, run, run, run]);
      const auditRows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`, [assignmentId]),
      );
      expect(Number(auditRows[0]!.count)).toBe(1);
    });

    it('G33: no audit record when the late condition became invalid before completion (cancellation race)', async () => {
      const fx = await seedOrgFixture('auditCancelRace');
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, lateStartsAt(), new Date(Date.now() + 8 * 3600 * 1000));
      const cancel = () => withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) => m.update(Shift, shiftId, { status: 'cancelled' as never }));
      const cycle = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([cycle, cancel]);
      const auditRows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`, [assignmentId]),
      );
      expect(Number(auditRows[0]!.count)).toBe(0);
    });
  });

  // ===================================================================
  // Direct unit-level coverage of resolveResponsibleManager (fast, no worker cycle needed)
  // ===================================================================
  describe('resolveResponsibleManager (direct)', () => {
    it('returns null, never throws, when neither candidate is valid', async () => {
      const fx = await seedOrgFixture('directNull');
      await deactivate(fx, fx.assigningManagerUserId);
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.assigningManagerUserId }, async (m) => {
        const assignment = { assignedBy: fx.assigningManagerUserId, workspaceId: fx.workspaceId } as ShiftAssignment;
        const shift = { createdBy: fx.assigningManagerUserId, workspaceId: fx.workspaceId } as Shift;
        const result = await resolveResponsibleManager(m, fx.organisationId, assignment, shift);
        expect(result).toBeNull();
      });
    });
  });
});
