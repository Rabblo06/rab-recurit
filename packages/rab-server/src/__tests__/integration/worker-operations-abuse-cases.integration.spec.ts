import 'reflect-metadata';
import { ManagerType, NotificationType, OfferStatus, ShiftAssignmentStatus, UserStatus } from '@rab/shared';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditService } from '../../engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { EmailOutbox, NotificationPreference, Organisation, RefreshToken, Role, User, UserRole } from '../../modules/identity/entities';
import { EmailService } from '../../engine/core-modules/email/email.service';
import { createEmailSendProcessor } from '../../queue-worker/jobs/email-send.processor';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { Notification } from '../../modules/notification/entities/notification.entity';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { Attendance } from '../../modules/attendance/entities/attendance.entity';
import { AttendanceStatus } from '../../modules/attendance/constants/attendance-status';
import { runShiftMonitorCycle } from '../../queue-worker/shifts/shift-monitor.job';
import { runAttendanceMonitorCycle } from '../../queue-worker/attendance/attendance-monitor.job';
import { runOfferExpiryCycle } from '../../queue-worker/offers/offer-expiry.job';
import { runTokenCleanupCycle } from '../../queue-worker/maintenance/token-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';

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
const RUN = Boolean(process.env.DATABASE_URL);
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
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('shift monitor — reminders', () => {
    it('a confirmed assignment 23h55m before start gets a 24h reminder, and a second scan does not duplicate it', async () => {
      const fx = await seedOrgFixture('rem');
      const startsAt = new Date(Date.now() + 23 * 3600 * 1000 + 55 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const afterFirst = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: NotificationType.SHIFT_REMINDER_24H } }),
      );
      expect(afterFirst).toHaveLength(1);

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
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

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
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

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);

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

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);

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
          status: AttendanceStatus.ACTIVE,
        }),
      );

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);

      const assignment = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(ShiftAssignment, { id: assignmentId }),
      );
      expect(assignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
    });
  });

  describe('attendance monitor — missing clock-out (flag only, never auto-mutate attendance)', () => {
    it('an active attendance row whose shift ended 40 minutes ago is flagged via notification, and attendance itself is left completely untouched', async () => {
      const fx = await seedOrgFixture('missclock');
      const startsAt = new Date(Date.now() - 9 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 40 * 60 * 1000);
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
          status: AttendanceStatus.ACTIVE,
        });
        attendanceId = attendance.id;
      });

      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);

      const attendanceAfter = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.findOneByOrFail(Attendance, { id: attendanceId }),
      );
      // Never auto-clocked-out, never mutated — flag-only, per the explicit instruction.
      expect(attendanceAfter.status).toBe(AttendanceStatus.ACTIVE);
      expect(attendanceAfter.clockOutAt).toBeFalsy();

      const notified = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'attendance', relatedEntityId: attendanceId, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(notified).toHaveLength(1);

      // Re-run: must not duplicate the flag.
      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const notifiedAgain = await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, (m) =>
        m.find(Notification, { where: { relatedEntityType: 'attendance', relatedEntityId: attendanceId, type: NotificationType.ATTENDANCE_MISSING_CLOCK_OUT } }),
      );
      expect(notifiedAgain).toHaveLength(1);
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

      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);

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
    it('a refresh token expired more than 30 days ago is deleted; a recently-expired one is retained', async () => {
      const fx = await seedOrgFixture('tokclean');
      const oldTokenId = randomUUID();
      const recentTokenId = randomUUID();
      await withContext({ organisationId: fx.organisationId, workspaceId: fx.workspaceId, userId: fx.managerUserId }, async (m) => {
        await m.insert(RefreshToken, {
          id: oldTokenId,
          organisationId: fx.organisationId,
          userId: fx.managerUserId,
          tokenHash: `old-${randomUUID()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() - 40 * 24 * 3600 * 1000),
        });
        await m.insert(RefreshToken, {
          id: recentTokenId,
          organisationId: fx.organisationId,
          userId: fx.managerUserId,
          tokenHash: `recent-${randomUUID()}`,
          familyId: randomUUID(),
          expiresAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
        });
      });

      await runTokenCleanupCycle(adminDataSource);

      const oldStillThere = await adminDataSource.manager.findOne(RefreshToken, { where: { id: oldTokenId } });
      const recentStillThere = await adminDataSource.manager.findOne(RefreshToken, { where: { id: recentTokenId } });
      expect(oldStillThere).toBeNull();
      expect(recentStillThere).not.toBeNull();
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
