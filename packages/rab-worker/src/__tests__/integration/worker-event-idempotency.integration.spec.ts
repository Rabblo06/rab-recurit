import 'reflect-metadata';
import { AttendanceStatus, ManagerType, NotificationType, ShiftAssignmentStatus, UserStatus } from '@rab/shared';
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
import { claimWorkerEvent, completeWorkerEvent, cancelWorkerEvent } from '../../core/database/worker-event';
import { runAttendanceMonitorCycle } from '../../queues/rab-shifts/attendance-monitor.job';
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Phase 2 — durable worker event idempotency (`core.worker_event`). Real
 * Postgres, RLS on, no mocks. Proves the specific property the old
 * `Notification`-row-existence check could not: a user's notification
 * preference must never influence whether the worker believes an
 * occurrence has already been processed, AND the claim itself must be
 * atomic under real concurrent access, not a SELECT-then-INSERT race.
 *
 * Fixture helpers mirror `worker-operations-abuse-cases.integration.spec.ts`'s
 * own established shape exactly (same org/workspace/staff/venue/shift/
 * assignment seeding), reused rather than reinvented.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

describeIfDb('worker event idempotency (integration)', () => {
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
      const managerHash = await passwordHashing.hash('correct horse battery staple 1!');
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
      await manager.insert(ManagerProfile, { organisationId, userId: managerUserId, type: ManagerType.INTERNAL, workspaceId });
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);

      const staffHash = await passwordHashing.hash('correct horse battery staple 1!');
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

  /** Sets both channels for one user+type in one call — undefined leaves the row absent (falls back to the service's own defaults). */
  async function setPreference(fx: OrgFixture, userId: string, type: string, inAppEnabled: boolean, emailEnabled: boolean): Promise<void> {
    await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (manager) =>
      manager.save(NotificationPreference, { organisationId: fx.organisationId, userId, notificationType: type as never, inAppEnabled, emailEnabled }),
    );
  }

  /**
   * WORK-02 — a SECOND Internal Manager in `fx`'s own workspace, used only
   * as the "staff onboarding owner" half of the adversarial fixture below.
   * Deliberately never made `assignedBy`/`shift.createdBy` for anything —
   * every WORK-02 test proves this identity is NEVER the notification
   * recipient merely because it onboarded the staff member.
   */
  async function createSecondManager(fx: OrgFixture, label: string): Promise<string> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const role = await manager.findOneByOrFail(Role, { organisationId: fx.organisationId, key: 'manager' });
      const hash = await passwordHashing.hash('correct horse battery staple 1!');
      const result = await manager.insert(User, {
        organisationId: fx.organisationId,
        email: `${label}-owner-${randomUUID()}@example.test`,
        passwordHash: hash,
        firstName: label,
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const userId = result.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId: role.id, organisationId: fx.organisationId });
      await manager.insert(ManagerProfile, { organisationId: fx.organisationId, userId, type: ManagerType.INTERNAL, workspaceId: fx.workspaceId });
      return userId;
    });
  }

  /**
   * WORK-02 §25's exact adversarial fixture: `StaffProfile.createdBy` =
   * Manager B (the onboarding owner), but `Shift.createdBy` AND
   * `ShiftAssignment.assignedBy` = Manager A (`fx.managerUserId`, the ACTUAL
   * responsible manager for this specific assignment). Every WORK-02 test
   * using this must prove notifications reach Manager A, never Manager B.
   */
  async function seedAdversarialAssignment(
    fx: OrgFixture,
    ownerManagerUserId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<{ shiftId: string; assignmentId: string; adversarialStaffProfileId: string; adversarialStaffUserId: string }> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const staffHash = await passwordHashing.hash('correct horse battery staple 1!');
      const staffResult = await manager.insert(User, {
        organisationId: fx.organisationId,
        email: `adversarial-staff-${randomUUID()}@example.test`,
        passwordHash: staffHash,
        firstName: 'Adversarial',
        lastName: 'Staff',
        status: UserStatus.ACTIVE,
      });
      const adversarialStaffUserId = staffResult.identifiers[0]!.id as string;
      const staffRole = await manager.findOneByOrFail(Role, { organisationId: fx.organisationId, key: 'staff' });
      await manager.insert(UserRole, { userId: adversarialStaffUserId, roleId: staffRole.id, organisationId: fx.organisationId });
      const staffProfile = await manager.save(StaffProfile, {
        organisationId: fx.organisationId,
        userId: adversarialStaffUserId,
        staffRef: `STF-ADV-${randomUUID().slice(0, 8)}`,
        // The adversarial part: onboarded by Manager B, never Manager A.
        createdBy: ownerManagerUserId,
        workspaceId: fx.workspaceId,
      });

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
        createdBy: fx.managerUserId, // Manager A — the real responsible manager
        workspaceId: fx.workspaceId,
      });
      const assignment = await manager.save(ShiftAssignment, {
        organisationId: fx.organisationId,
        shiftId: shift.id,
        staffProfileId: staffProfile.id,
        status: ShiftAssignmentStatus.CONFIRMED,
        payRateSnapshotPence: 1500,
        assignedBy: fx.managerUserId, // Manager A — same
        confirmedAt: new Date(),
        period: toTstzRange(startsAt, endsAt),
        workspaceId: fx.workspaceId,
      });
      return { shiftId: shift.id, assignmentId: assignment.id, adversarialStaffProfileId: staffProfile.id, adversarialStaffUserId };
    });
  }

  /**
   * Runs N job-cycle attempts truly concurrently (`Promise.allSettled`, never
   * `Promise.all`) and returns only the results that actually ran to
   * completion. `Promise.all` rejects as soon as the FIRST attempt throws,
   * leaving the other N-1 still executing in the background, unawaited —
   * they can still be mid-transaction (holding the discovery advisory lock,
   * or mid `ALTER TABLE`) when the NEXT test starts, corrupting it too. A
   * discovery scan racing another one for the same table's ACCESS EXCLUSIVE
   * lock is an already-documented, already-handled condition in production
   * (`isLockUnavailable`, caught by `WorkerRuntime.every()` itself — see
   * `discovery-lock.ts`'s own doc comment: "the fix is to make the WORKER
   * the one that always loses... the scan simply retries on its next
   * tick"). Calling a job function directly, bypassing `WorkerRuntime`,
   * means this test must apply that exact same tolerance itself to
   * accurately model real multi-replica concurrency rather than an
   * unrealistically higher contention level than any real deployment would
   * ever see from `WorkerRuntime`'s own per-replica `running` guard.
   */
  async function runConcurrentCycles<T>(attempts: Array<() => Promise<T>>): Promise<T[]> {
    const settled = await Promise.allSettled(attempts.map((run) => run()));
    const results: T[] = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
      else if (!isLockUnavailable(r.reason)) throw r.reason; // a genuine failure, not the documented "yielded to other traffic" case
    }
    return results;
  }

  async function workerEventStatus(fx: OrgFixture, eventKey: string): Promise<{ status: string; processedAt: Date | null } | null> {
    return withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (manager) => {
      const rows = await manager.query<Array<{ status: string; processed_at: Date | null }>>(
        `SELECT status, processed_at FROM core.worker_event WHERE event_key = $1`,
        [eventKey],
      );
      return rows[0] ? { status: rows[0].status, processedAt: rows[0].processed_at } : null;
    });
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

  describe('claimWorkerEvent — atomic uniqueness (the DB constraint, not application logic)', () => {
    it('a single claim succeeds and returns a real id', async () => {
      const fx = await seedOrgFixture('claim1');
      const key = `test-event:${randomUUID()}`;
      const id = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        claimWorkerEvent(m, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key, eventType: 'test', entityType: 'test', entityId: randomUUID() }),
      );
      expect(id).toEqual(expect.any(String));
    });

    it('a second claim of the same event_key from the same transaction shape returns null (already claimed)', async () => {
      const fx = await seedOrgFixture('claim2');
      const key = `test-event:${randomUUID()}`;
      const params = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key, eventType: 'test', entityType: 'test', entityId: randomUUID() };
      const first = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => claimWorkerEvent(m, params));
      const second = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => claimWorkerEvent(m, params));
      expect(first).toEqual(expect.any(String));
      expect(second).toBeNull();
    });

    it('TWO real concurrent claims of the same event_key: exactly one wins (Promise.all, not sequential)', async () => {
      const fx = await seedOrgFixture('claim3');
      const key = `test-event:${randomUUID()}`;
      const params = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key, eventType: 'test', entityType: 'test', entityId: randomUUID() };
      const attempt = () => withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => claimWorkerEvent(m, params));
      const results = await Promise.all([attempt(), attempt()]);
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
    });

    it('FIVE real concurrent claims of the same event_key: exactly one wins', async () => {
      const fx = await seedOrgFixture('claim5');
      const key = `test-event:${randomUUID()}`;
      const params = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key, eventType: 'test', entityType: 'test', entityId: randomUUID() };
      const attempt = () => withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => claimWorkerEvent(m, params));
      const results = await Promise.all([attempt(), attempt(), attempt(), attempt(), attempt()]);
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);

      const rows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.worker_event WHERE event_key = $1`, [key]),
      );
      expect(Number(rows[0]!.count)).toBe(1); // exactly one row ever exists for this key, not one per losing attempt
    });

    it('cross-organisation isolation: org B cannot see org A\'s worker_event row', async () => {
      const fxA = await seedOrgFixture('tenA');
      const fxB = await seedOrgFixture('tenB');
      const key = `test-event:${randomUUID()}`;
      await withContext({ organisationId: fxA.organisationId, workspaceId: fxA.workspaceId, userId: fxA.managerUserId }, (m) =>
        claimWorkerEvent(m, { organisationId: fxA.organisationId, workspaceId: fxA.workspaceId, eventKey: key, eventType: 'test', entityType: 'test', entityId: randomUUID() }),
      );
      const seenFromB = await withContext({ organisationId: fxB.organisationId, workspaceId: fxB.workspaceId, userId: fxB.managerUserId }, (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.worker_event WHERE event_key = $1`, [key]),
      );
      expect(seenFromB).toHaveLength(0);
      // Org A can still see its own row.
      const seenFromA = await withContext({ organisationId: fxA.organisationId, workspaceId: fxA.workspaceId, userId: fxA.managerUserId }, (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.worker_event WHERE event_key = $1`, [key]),
      );
      expect(seenFromA).toHaveLength(1);
    });

    it('a wrong-workspace context in the same organisation cannot see the row (workspace_id is bound, not just organisation_id)', async () => {
      const fx = await seedOrgFixture('wrongws');
      const key = `test-event:${randomUUID()}`;
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        claimWorkerEvent(m, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key, eventType: 'test', entityType: 'test', entityId: randomUUID() }),
      );
      const otherWorkspaceId = randomUUID();
      const seen = await withContext({ organisationId: fx.organisationId, workspaceId: otherWorkspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ id: string }>>(`SELECT id FROM core.worker_event WHERE event_key = $1`, [key]),
      );
      expect(seen).toHaveLength(0);
    });

    it('completeWorkerEvent and cancelWorkerEvent set the expected terminal status', async () => {
      const fx = await seedOrgFixture('termstate');
      const key1 = `test-event:${randomUUID()}`;
      const key2 = `test-event:${randomUUID()}`;
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        const id1 = await claimWorkerEvent(m, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key1, eventType: 'test', entityType: 'test', entityId: randomUUID() });
        await completeWorkerEvent(m, id1!);
        const id2 = await claimWorkerEvent(m, { organisationId: fx.organisationId, workspaceId: fx.workspaceId, eventKey: key2, eventType: 'test', entityType: 'test', entityId: randomUUID() });
        await cancelWorkerEvent(m, id2!, 'condition_no_longer_true');
      });
      expect((await workerEventStatus(fx, key1))?.status).toBe('completed');
      expect((await workerEventStatus(fx, key1))?.processedAt).not.toBeNull();
      expect((await workerEventStatus(fx, key2))?.status).toBe('cancelled');
    });
  });

  describe('late clock-in — preference-independent idempotency (job-level, end to end)', () => {
    async function fixtureLate(label: string) {
      const fx = await seedOrgFixture(label);
      const startsAt = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes ago
      const { assignmentId, shiftId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      return { fx, assignmentId, shiftId };
    }

    it('first cycle creates exactly one worker_event and one staff Notification; second cycle does not duplicate either', async () => {
      const { fx, assignmentId } = await fixtureLate('latefirst');
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      const afterFirst = await workerEventStatus(fx, `late-clock-in:${assignmentId}`);
      expect(afterFirst?.status).toBe('completed');
      const notificationsAfterFirst = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.LATE_CLOCK_IN, userId: fx.staffUserId } }),
      );
      expect(notificationsAfterFirst).toHaveLength(1);

      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      const notificationsAfterSecond = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.LATE_CLOCK_IN, userId: fx.staffUserId } }),
      );
      expect(notificationsAfterSecond).toHaveLength(1); // still exactly one — no duplicate

      const auditRows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`, [assignmentId]),
      );
      expect(Number(auditRows[0]!.count)).toBe(1); // no duplicate audit record either
    });

    it('THIS IS THE CORE FIX: both channels disabled still marks the worker_event completed exactly once — no repeated processing forever', async () => {
      const { fx, assignmentId } = await fixtureLate('latebothoff');
      // Disable BOTH in-app and email for the staff member AND the manager, for LATE_CLOCK_IN —
      // under the OLD Notification-existence dedupe, this would mean no Notification row is EVER
      // created, so the old check would see "not yet flagged" forever and re-run every single cycle.
      await setPreference(fx, fx.staffUserId, NotificationType.LATE_CLOCK_IN, false, false);
      await setPreference(fx, fx.managerUserId, NotificationType.LATE_CLOCK_IN, false, false);

      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');

      // Confirm zero Notification rows exist (both channels really were off) —
      // proving the ledger's completion is independent of any visible delivery.
      const notifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }),
      );
      expect(notifications).toHaveLength(0);

      // The second, third, ... cycle must NOT re-flag or re-audit THIS assignment, because the
      // worker_event ledger (not a Notification row) is what it checks — the aggregate `flagged`
      // count itself is not asserted here since runLateClockInCycle's scan is deliberately
      // cross-organisation (see that job's own doc comment) and a sibling test's fixture can
      // legitimately also be eligible in the same shared-database cycle.
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      const auditRows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = 'shift_assignment.late_clock_in_flagged' AND metadata->>'assignmentId' = $1`, [assignmentId]),
      );
      expect(Number(auditRows[0]!.count)).toBe(1); // exactly once, ever — not once per cycle
    });

    it('in-app enabled / email disabled and in-app disabled / email enabled: both still complete the event exactly once', async () => {
      const { fx: fxA, assignmentId: idA } = await fixtureLate('inappon');
      await setPreference(fxA, fxA.staffUserId, NotificationType.LATE_CLOCK_IN, true, false);
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect((await workerEventStatus(fxA, `late-clock-in:${idA}`))?.status).toBe('completed');

      const { fx: fxB, assignmentId: idB } = await fixtureLate('emailon');
      await setPreference(fxB, fxB.staffUserId, NotificationType.LATE_CLOCK_IN, false, true);
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect((await workerEventStatus(fxB, `late-clock-in:${idB}`))?.status).toBe('completed');
    });

    it('FIVE concurrent worker cycles for the same candidate flag exactly once (real Promise.all against the live table)', async () => {
      const { fx, assignmentId } = await fixtureLate('lateconcurrent');
      const run = () => runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      await runConcurrentCycles([run, run, run, run, run]);
      expect((await workerEventStatus(fx, `late-clock-in:${assignmentId}`))?.status).toBe('completed');
      const notifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, userId: fx.staffUserId } }),
      );
      expect(notifications).toHaveLength(1); // exactly one, for THIS assignment, despite 5 concurrent attempts
    });

    it('the business condition becoming invalid between discovery and claim (shift cancelled) is handled safely: no event ever completes, nothing is flagged', async () => {
      const { fx, assignmentId, shiftId } = await fixtureLate('latecancelled');
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) => m.update(Shift, shiftId, { status: 'cancelled' as never }));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      // No worker_event row at all — the scoped re-check bails out (assignment/shift no longer
      // eligible) before ever reaching claimWorkerEvent, exactly as it did before a cancelled shift.
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
    });

    it('an on-time (not-yet-late) staff member produces no event and no notification', async () => {
      const fx = await seedOrgFixture('ontime');
      const startsAt = new Date(Date.now() + 60 * 60 * 1000); // starts in the future — not late
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect(await workerEventStatus(fx, `late-clock-in:${assignmentId}`)).toBeNull();
    });
  });

  describe('no-show — the ledger adds real cross-replica protection this job never had before', () => {
    it('FIVE concurrent worker cycles for the same overdue assignment flip to NO_SHOW exactly once, with exactly one notification and one audit row', async () => {
      const fx = await seedOrgFixture('noshowconcurrent');
      const startsAt = new Date(Date.now() - 45 * 60 * 1000); // started 45 minutes ago — past the 30-minute grace period
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      // `runShiftMonitorCycle` is DELIBERATELY cross-organisation (see its
      // own doc comment) — in this shared integration-test database, a
      // sibling test file's own still-eligible fixtures are legitimate scan
      // candidates too, so the AGGREGATE `noShowsFlagged` across 5 concurrent
      // cross-org scans is not a safe assertion (it can legitimately be >1
      // if another file's fixture also qualifies in this exact window). The
      // safe, specific assertion is that THIS test's own event_key was
      // claimed exactly once — proven directly against the ledger below —
      // and that at least one no-show was flagged somewhere in this run.
      const run = () => runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const results = await runConcurrentCycles([run, run, run, run, run]);
      const totalNoShows = results.reduce((sum, r) => sum + r.noShowsFlagged, 0);
      expect(totalNoShows).toBeGreaterThanOrEqual(1);
      expect((await workerEventStatus(fx, `no-show:${assignmentId}`))?.status).toBe('completed');

      const assignment = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentId }),
      );
      expect(assignment.status).toBe(ShiftAssignmentStatus.NO_SHOW);

      const notifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW } }),
      );
      expect(notifications).toHaveLength(1);

      const auditRows = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = 'shift_assignment.no_show' AND metadata->>'assignmentId' = $1`, [assignmentId]),
      );
      expect(Number(auditRows[0]!.count)).toBe(1);
    });

    // WORK-02 §25 — the important regression: StaffProfile.createdBy (owner)
    // must NEVER be the recipient; Shift.createdBy/assignment.assignedBy
    // (the real responsible manager) must ALWAYS be, even though the OLD
    // code's `staffProfile.createdBy ?? user.id` fallback would have
    // notified the owner (or, worse, the staff member themselves).
    it('WORK-02: no-show notifies the responsible manager (assignedBy), never the staff-onboarding owner', async () => {
      const fx = await seedOrgFixture('noshowadversarial');
      const ownerManagerUserId = await createSecondManager(fx, 'noshowowner');
      const startsAt = new Date(Date.now() - 45 * 60 * 1000);
      const { assignmentId, adversarialStaffUserId } = await seedAdversarialAssignment(fx, ownerManagerUserId, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect((await workerEventStatus(fx, `no-show:${assignmentId}`))?.status).toBe('completed');

      const ownerNotifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { userId: ownerManagerUserId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW } }),
      );
      expect(ownerNotifications).toHaveLength(0); // never the onboarding owner
      const staffAsRecipientNotifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { userId: adversarialStaffUserId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW } }),
      );
      expect(staffAsRecipientNotifications).toHaveLength(0); // never the staff member as a manager-notification recipient
      const correctNotifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { userId: fx.managerUserId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_ASSIGNMENT_NO_SHOW } }),
      );
      expect(correctNotifications).toHaveLength(1); // the ACTUAL responsible manager (assignedBy)

      const auditRow = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.query<Array<{ metadata: { notifiedManagerUserId: string; managerResolutionSource: string } }>>(
          `SELECT metadata FROM core.audit_log WHERE action = 'shift_assignment.no_show' AND metadata->>'assignmentId' = $1`,
          [assignmentId],
        ),
      );
      expect(auditRow[0]!.metadata.notifiedManagerUserId).toBe(fx.managerUserId);
      expect(auditRow[0]!.metadata.managerResolutionSource).toBe('assigned_by');
    });

    it('both notification channels disabled: the assignment still flips to NO_SHOW exactly once and the worker_event still completes', async () => {
      const fx = await seedOrgFixture('noshowbothoff');
      const startsAt = new Date(Date.now() - 45 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await setPreference(fx, fx.managerUserId, NotificationType.SHIFT_ASSIGNMENT_NO_SHOW, false, false);

      // `noShowsFlagged`/`remindersSent` are aggregate counts across a
      // DELIBERATELY cross-organisation scan (see that job's own doc
      // comment) — in this shared integration-test database a sibling test
      // file's own still-eligible fixture can legitimately also be flagged
      // in the same cycle, so only the specific event/entity assertions
      // below are safe, not an aggregate `toBe(1)`/`toBe(0)`.
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect((await workerEventStatus(fx, `no-show:${assignmentId}`))?.status).toBe('completed');

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const assignmentAfterSecond = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentId }),
      );
      expect(assignmentAfterSecond.status).toBe(ShiftAssignmentStatus.NO_SHOW); // still exactly the one flip — status transition itself excludes reprocessing
    });

    // VENUE MANAGER PER-STAFF ASSIGNMENT-TIME VERIFICATION — case 3: no-show
    // (like reminders) must key off the assignment's OWN start
    // (`assignmentTimeSql().start` / `effectiveAssignmentTime(...).startsAt`),
    // not the parent shift's `starts_at`, whenever an individual period has
    // been set. Mirrors `late-clock-in-correctness.integration.spec.ts`'s own
    // "uses the individual start when the parent has already started" test,
    // applied to the no-show path specifically — that existing test does not
    // cover shift-monitor's own no-show/reminder query at all.
    it('uses the assignment\'s own individual start for no-show eligibility, not the parent shift\'s much-earlier start', async () => {
      const fx = await seedOrgFixture('noshowIndividualStart');
      // Parent shift started 3 hours ago — if the job used shift.starts_at
      // directly, this would already be WAY past the 30-minute no-show grace.
      const parentStart = new Date(Date.now() - 3 * 3600 * 1000);
      const parentEnd = new Date(Date.now() + 5 * 3600 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, parentStart, parentEnd);
      const ctx = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId };

      // Override the assignment's own period to start only 10 minutes ago —
      // still within the 30-minute no-show grace. If the job were reading
      // the parent's start instead, this candidate would already be flagged.
      await withContext(ctx, (m) => m.update(ShiftAssignment, assignmentId, { period: toTstzRange(new Date(Date.now() - 10 * 60 * 1000), parentEnd) }));
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect(await workerEventStatus(fx, `no-show:${assignmentId}`)).toBeNull();
      const stillConfirmed = await withContext(ctx, (m) => m.findOneByOrFail(ShiftAssignment, { id: assignmentId }));
      expect(stillConfirmed.status).toBe(ShiftAssignmentStatus.CONFIRMED);

      // Now push the assignment's own start to 45 minutes ago — past grace —
      // while the parent shift's start/end are untouched. Only the
      // assignment-time-aware query can catch this.
      await withContext(ctx, (m) => m.update(ShiftAssignment, assignmentId, { period: toTstzRange(new Date(Date.now() - 45 * 60 * 1000), parentEnd) }));
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect((await workerEventStatus(fx, `no-show:${assignmentId}`))?.status).toBe('completed');
      const flipped = await withContext(ctx, (m) => m.findOneByOrFail(ShiftAssignment, { id: assignmentId }));
      expect(flipped.status).toBe(ShiftAssignmentStatus.NO_SHOW);
    });
  });

  describe('shift reminders — preference-independent idempotency for all three windows', () => {
    it('the 24h reminder completes its worker_event and does not duplicate on a second scan, even with both channels disabled', async () => {
      const fx = await seedOrgFixture('rem24hoff');
      const startsAt = new Date(Date.now() + 23 * 3600 * 1000 + 55 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await setPreference(fx, fx.staffUserId, NotificationType.SHIFT_REMINDER_24H, false, false);

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect((await workerEventStatus(fx, `shift-reminder-24h:${assignmentId}`))?.status).toBe('completed');
      const notifications = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_24H } }),
      );
      expect(notifications).toHaveLength(0); // both channels off — nothing visible, but the ledger is still complete

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const notificationsAfterSecond = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_24H } }),
      );
      expect(notificationsAfterSecond).toHaveLength(0); // still zero — a second scan did not re-claim this specific event
    });
  });

  describe('missing clock-out — same preference-independence guarantee', () => {
    it('flags an ended assignment while the parent still runs', async () => {
      const fx = await seedOrgFixture('individualEnd');
      const start = new Date(Date.now()-3*3600_000);
      const end = new Date(Date.now()-45*60_000);
      const {shiftId, assignmentId} = await seedConfirmedAssignment(fx, start, end);
      const ctx = {organisationId:fx.organisationId,workspaceId:fx.workspaceId,userId:fx.managerUserId};
      const attendance = await withContext(ctx, async m => {
        await m.update(Shift,shiftId,{endsAt:new Date(Date.now()+3*3600_000)});
        return m.save(Attendance,{organisationId:fx.organisationId,workspaceId:fx.workspaceId,shiftId,shiftAssignmentId:assignmentId,staffProfileId:fx.staffProfileId,clockInAt:start,status:AttendanceStatus.CLOCKED_IN});
      });
      await runAttendanceMonitorCycle(adminDataSource,tenantContext,notificationService,auditService);
      expect((await workerEventStatus(fx,`missing-clock-out:${attendance.id}`))?.status).toBe('completed');
      const result = await withContext(ctx,m=>m.findOneByOrFail(Attendance,{id:attendance.id}));
      expect(result.status).toBe(AttendanceStatus.MISSING_CLOCK_OUT);
      expect(result.clockOutAt).toBeNull();
    });

    // WORK-02 §25 — same adversarial regression as no-show above, for
    // missing-clock-out: the OLD `staffProfile.createdBy ?? user.id`
    // fallback would have notified the onboarding owner (or the staff
    // member themselves); the resolver must notify the real responsible
    // manager (assignedBy) instead.
    it('WORK-02: missing-clock-out notifies the responsible manager (assignedBy), never the staff-onboarding owner', async () => {
      const fx = await seedOrgFixture('mcoadversarial');
      const ownerManagerUserId = await createSecondManager(fx, 'mcoowner');
      const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 45 * 60 * 1000); // ended 45 minutes ago — past the 30-minute grace period
      const { shiftId, assignmentId, adversarialStaffProfileId, adversarialStaffUserId } = await seedAdversarialAssignment(fx, ownerManagerUserId, startsAt, endsAt);
      const ctx = { organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId };
      const attendance = await withContext(ctx, (m) =>
        m.save(Attendance, {
          organisationId: fx.organisationId,
          workspaceId: fx.workspaceId,
          shiftId,
          shiftAssignmentId: assignmentId,
          staffProfileId: adversarialStaffProfileId,
          clockInAt: startsAt,
          status: AttendanceStatus.CLOCKED_IN,
        }),
      );

      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect((await workerEventStatus(fx, `missing-clock-out:${attendance.id}`))?.status).toBe('completed');

      const ownerNotifications = await withContext(ctx, (m) =>
        m.find(Notification, { where: { userId: ownerManagerUserId, relatedEntityType: 'attendance', relatedEntityId: attendance.id, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(ownerNotifications).toHaveLength(0); // never the onboarding owner
      const staffAsRecipientNotifications = await withContext(ctx, (m) =>
        m.find(Notification, { where: { userId: adversarialStaffUserId, relatedEntityType: 'attendance', relatedEntityId: attendance.id, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(staffAsRecipientNotifications).toHaveLength(0); // never the staff member as a manager-notification recipient
      const correctNotifications = await withContext(ctx, (m) =>
        m.find(Notification, { where: { userId: fx.managerUserId, relatedEntityType: 'attendance', relatedEntityId: attendance.id, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(correctNotifications).toHaveLength(1); // the ACTUAL responsible manager (assignedBy)

      const auditRow = await withContext(ctx, (m) =>
        m.query<Array<{ metadata: { notifiedManagerUserId: string; managerResolutionSource: string } }>>(
          `SELECT metadata FROM core.audit_log WHERE action = 'shift_assignment.missing_clock_out_flagged' AND metadata->>'attendanceId' = $1`,
          [attendance.id],
        ),
      );
      expect(auditRow[0]!.metadata.notifiedManagerUserId).toBe(fx.managerUserId);
      expect(auditRow[0]!.metadata.managerResolutionSource).toBe('assigned_by');
    });

    it('completes its worker_event exactly once with both channels disabled, and is never reprocessed', async () => {
      const fx = await seedOrgFixture('mcobothoff');
      const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 45 * 60 * 1000); // ended 45 minutes ago — past the 30-minute grace period
      const { shiftId } = await seedConfirmedAssignment(fx, startsAt, endsAt);
      const attendanceId = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        const a = await m.save(Attendance, {
          organisationId: fx.organisationId,
          workspaceId: fx.workspaceId,
          shiftId,
          shiftAssignmentId: (await m.findOneByOrFail(ShiftAssignment, { shiftId })).id,
          staffProfileId: fx.staffProfileId,
          clockInAt: startsAt,
          status: AttendanceStatus.CLOCKED_IN,
        });
        return a.id;
      });
      await setPreference(fx, fx.managerUserId, NotificationType.ATTENDANCE_MISSING_CLOCK_OUT, false, false);

      const first = await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect(first.flagged).toBeGreaterThanOrEqual(1);
      expect((await workerEventStatus(fx, `missing-clock-out:${attendanceId}`))?.status).toBe('completed');

      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      // The specific attendance row is no longer selectable (status moved off 'clocked_in'),
      // so it cannot contribute to a second flag — this assertion only concerns THIS row via the ledger.
      expect((await workerEventStatus(fx, `missing-clock-out:${attendanceId}`))?.status).toBe('completed');
    });
  });
});
