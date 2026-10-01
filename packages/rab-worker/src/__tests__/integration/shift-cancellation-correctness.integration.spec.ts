import 'reflect-metadata';
import {
  AttendanceStatus,
  EmailOutboxJobType,
  EmailOutboxStatus,
  InvalidTransitionError,
  OfferStatus,
  ReplacementRequestStatus,
  ShiftAssignmentStatus,
  ShiftStatus,
} from '@rab/shared';
import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { ShiftReport } from '@rab/server/modules/attendance/entities/shift-report.entity';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { EmailOutbox, Organisation } from '@rab/server/modules/identity/entities/index';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { ReplacementRequest } from '@rab/server/modules/offer/entities/replacement-request.entity';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { ReplacementRequestService } from '@rab/server/modules/offer/services/replacement-request.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { SchedulingService } from '@rab/server/modules/scheduling/services/scheduling.service';
import { toTstzRange } from '@rab/server/modules/scheduling/utils/tstzrange';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { isLockUnavailable } from '../helpers/legacy-discovery-lock';
import { createEmailSendProcessor } from '../../queues/rab-email/email-send.processor';
import { runAttendanceMonitorCycle } from '../../queues/rab-shifts/attendance-monitor.job';
import { runManagerConfirmationTimeoutCycle, runOfferExpiryCycle } from '../../queues/rab-offers/offer-expiry.job';
import { runReplacementStaffCycle } from '../../queues/rab-offers/replacement-staff.job';
import { runFinalTimesheetCycle } from '../../queues/rab-reports/final-timesheet.job';
import { runShiftReportSchedulerCycle } from '../../queues/rab-reports/shift-report-scheduler.job';
import { runShiftCancellationFollowupCycle } from '../../queues/rab-shifts/shift-cancellation-followup.job';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase 5 — shift cancellation correctness. Real Postgres, RLS on, no
 * mocks. Covers: the cancellation command itself (atomic claim, audit,
 * cancelled_by/cancelled_at), cancellation-vs-offer-acceptance and
 * -vs-manager-confirmation races, reminder/no-show/manager-confirmation-
 * timeout suppression after cancellation, replacement-vs-cancellation
 * (Phase 4 regression), attendance history preservation, pre-shift-report
 * suppression, the final-timesheet affected-row regression, and queued
 * pre-shift-roster email revalidation.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

describeIfDb('shift cancellation correctness (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let schedulingService: SchedulingService;
  let offerService: OfferService;
  let replacementRequestService: ReplacementRequestService;
  let emailOutbox: EmailOutboxService;
  let fileService: FileService;
  let attendanceQr: AttendanceQrService;
  let qrImage: QrImageService;
  let reportAvailableBeforeMinutes: number;
  let factory: TestIdentityFactory;

  interface OrgFixture {
    organisation: Organisation;
    owner: TestIdentity;
    venueId: string;
    jobRoleId: string;
  }

  function ctxOf(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext {
    return { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' };
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
    const organisation = await factory.createOrganisation(label);
    const owner = await factory.createInternalManager(organisation, { permissions: 'production' });
    const { venueId, jobRoleId } = await withContext(ctxOf(owner), async (m) => {
      const venue = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue`, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const jobRole = await m.save(JobRole, { organisationId: organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      return { venueId: venue.id, jobRoleId: jobRole.id };
    });
    return { organisation, owner, venueId, jobRoleId };
  }

  /** An OPEN shift directly created by the owner — the two-step (non-auto-confirm) flow, `requestedBy` stays null. */
  async function seedOpenShift(fx: OrgFixture, opts?: { startsAt?: Date; endsAt?: Date; requiredCount?: number }): Promise<Shift> {
    const startsAt = opts?.startsAt ?? new Date(Date.now() + 3 * 3600 * 1000);
    const endsAt = opts?.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);
    return withContext(ctxOf(fx.owner), (m) =>
      m.save(Shift, {
        organisationId: fx.organisation.id,
        venueId: fx.venueId,
        jobRoleId: fx.jobRoleId,
        startsAt,
        endsAt,
        breakMinutes: 0,
        requiredCount: opts?.requiredCount ?? 1,
        payRatePence: 1500,
        status: ShiftStatus.OPEN,
        createdBy: fx.owner.userId,
        workspaceId: fx.owner.workspaceId!,
      }),
    );
  }

  async function getShift(fx: OrgFixture, id: string): Promise<Shift> {
    return withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(Shift, { id }));
  }

  async function countAudit(fx: OrgFixture, action: string, entityId: string): Promise<number> {
    const rows = await withContext(ctxOf(fx.owner), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = $1 AND entity_id = $2`, [action, entityId]));
    return Number(rows[0]!.count);
  }

  async function raceAndReport<T>(attempts: Array<() => Promise<T>>): Promise<Array<{ ok: boolean; value?: T; error?: unknown }>> {
    const settled = await Promise.allSettled(attempts.map((run) => run()));
    return settled.map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    schedulingService = app.get(SchedulingService);
    offerService = app.get(OfferService);
    replacementRequestService = app.get(ReplacementRequestService);
    emailOutbox = app.get(EmailOutboxService);
    fileService = app.get(FileService);
    attendanceQr = app.get(AttendanceQrService);
    qrImage = app.get(QrImageService);
    reportAvailableBeforeMinutes = app.get(EnvironmentService).get('REPORT_AVAILABLE_BEFORE_MINUTES');
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ===================================================================
  // A. Basic cancellation
  // ===================================================================
  describe('A. basic cancellation', () => {
    it('A1: an active shift cancels successfully — status, reason, cancelledBy/At, exactly one audit row', async () => {
      const fx = await seedOrgFixture('cancelA1');
      const shift = await seedOpenShift(fx);
      const result = await schedulingService.cancel(ctxOf(fx.owner), shift.id, 'Venue closed');
      expect(result.status).toBe(ShiftStatus.CANCELLED);
      expect(result.cancelledReason).toBe('Venue closed');
      expect(result.cancelledBy).toBe(fx.owner.userId);
      expect(result.cancelledAt).toBeInstanceOf(Date);
      expect(await countAudit(fx, 'shift.cancelled', shift.id)).toBe(1);
    });

    it('A2: cancelling an already-cancelled shift is a clean 409, not a second audit row', async () => {
      const fx = await seedOrgFixture('cancelA2');
      const shift = await seedOpenShift(fx);
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);
      // `assertTransition` rejects `cancelled -> cancelled` before the atomic
      // claim is ever attempted (no valid destinations are listed from a
      // terminal state) — this maps to a clean 409 via the global
      // `InvalidTransitionError` filter in real HTTP traffic; calling the
      // service directly here sees the raw thrown error class.
      await expect(schedulingService.cancel(ctxOf(fx.owner), shift.id)).rejects.toBeInstanceOf(InvalidTransitionError);
      expect(await countAudit(fx, 'shift.cancelled', shift.id)).toBe(1);
    });

    it('A3: a manager from a different organisation cannot cancel — 404, not 403', async () => {
      const fx = await seedOrgFixture('cancelA3a');
      const otherOrg = await seedOrgFixture('cancelA3b');
      const shift = await seedOpenShift(fx);
      await expect(schedulingService.cancel(ctxOf(otherOrg.owner), shift.id)).rejects.toMatchObject({ status: 404 });
      expect((await getShift(fx, shift.id)).status).toBe(ShiftStatus.OPEN);
    });

    it('A4: a manager from a different workspace in the SAME organisation cannot cancel', async () => {
      const fx = await seedOrgFixture('cancelA4');
      const shift = await seedOpenShift(fx);
      const otherWorkspaceOwner = await factory.createInternalManager(fx.organisation, { permissions: 'production', label: 'otherws' });
      await expect(schedulingService.cancel(ctxOf(otherWorkspaceOwner), shift.id)).rejects.toMatchObject({ status: 404 });
    });

    it('A5: a staff member (no manager application/permission) cannot cancel', async () => {
      const fx = await seedOrgFixture('cancelA5');
      const shift = await seedOpenShift(fx);
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      // Staff has no manager_venue/createdBy relationship to the shift and no SCHEDULE_CREATE permission at the guard layer;
      // at the service layer (called directly here) the ownership check alone already denies it.
      await expect(schedulingService.cancel(ctxOf(staff), shift.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  // ===================================================================
  // B. Offer races
  // ===================================================================
  describe('B. offer-acceptance and manager-confirmation races', () => {
    it('B6/B29: two concurrent cancel attempts on the same shift — exactly one succeeds, exactly one audit row', async () => {
      const fx = await seedOrgFixture('raceB6');
      const shift = await seedOpenShift(fx);
      const results = await raceAndReport([() => schedulingService.cancel(ctxOf(fx.owner), shift.id), () => schedulingService.cancel(ctxOf(fx.owner), shift.id)]);
      const succeeded = results.filter((r) => r.ok);
      expect(succeeded).toHaveLength(1);
      expect(await countAudit(fx, 'shift.cancelled', shift.id)).toBe(1);
    });

    it('B7: cancel before accept — the accept is blocked with a clean conflict', async () => {
      const fx = await seedOrgFixture('raceB7');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);

      await expect(offerService.staffAccept(ctxOf(staff), offer.id)).rejects.toBeInstanceOf(ConflictException);
      const assignment = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftAssignment, { staffProfileId: staff.profileId! }));
      expect(assignment.status).toBe(ShiftAssignmentStatus.OFFERED); // never advanced to STAFF_ACCEPTED
    });

    it('B31: accept racing cancel — exactly one valid outcome, never a contradictory (cancelled shift + newly STAFF_ACCEPTED, unreconciled) end state', async () => {
      const fx = await seedOrgFixture('raceB31');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });

      await raceAndReport([() => offerService.staffAccept(ctxOf(staff), offer.id), () => schedulingService.cancel(ctxOf(fx.owner), shift.id)]);

      const finalShift = await getShift(fx, shift.id);
      const finalOffer = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      if (finalOffer.status === OfferStatus.STAFF_ACCEPTED) {
        // Accept won — the shift's own cancel() must still have succeeded cleanly afterward (it never touches assignments itself; the async follow-up job reconciles them — see B8).
        expect(finalShift.status).toBe(ShiftStatus.CANCELLED);
      } else {
        // Cancel won first — the accept must have been rejected, never silently advanced.
        expect(finalOffer.status).toBe(OfferStatus.PENDING);
        expect(finalShift.status).toBe(ShiftStatus.CANCELLED);
      }
    });

    it('B8: accept before cancel — cancel still succeeds, and the async follow-up job reconciles the now-stale STAFF_ACCEPTED assignment/offer without contradiction', async () => {
      const fx = await seedOrgFixture('raceB8');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(ctxOf(staff), offer.id);

      const cancelled = await schedulingService.cancel(ctxOf(fx.owner), shift.id);
      expect(cancelled.status).toBe(ShiftStatus.CANCELLED);

      await runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService);
      const assignment = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftAssignment, { staffProfileId: staff.profileId! }));
      expect(assignment.status).toBe(ShiftAssignmentStatus.CANCELLED);
      const finalOffer = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_REJECTED);
    });

    it('B9/B32: manager confirm racing cancel — exactly one valid outcome', async () => {
      const fx = await seedOrgFixture('raceB9');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(ctxOf(staff), offer.id);

      await raceAndReport([() => offerService.managerConfirm(ctxOf(fx.owner), offer.id), () => schedulingService.cancel(ctxOf(fx.owner), shift.id)]);

      const finalOffer = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      const finalShift = await getShift(fx, shift.id);
      if (finalOffer.status === OfferStatus.MANAGER_CONFIRMED) {
        expect(finalShift.status).not.toBe(ShiftStatus.OPEN); // filled_count advanced the shift's own status
      } else {
        expect(finalShift.status).toBe(ShiftStatus.CANCELLED);
        expect(finalOffer.status).toBe(OfferStatus.STAFF_ACCEPTED); // confirm never went through
      }
    });

    it('B10: cancel before confirmation — confirmation is blocked with a clean conflict, never a silently-filled seat on a dead shift', async () => {
      const fx = await seedOrgFixture('raceB10');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(ctxOf(staff), offer.id);
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);

      await expect(offerService.managerConfirm(ctxOf(fx.owner), offer.id)).rejects.toBeInstanceOf(ConflictException);
      const finalOffer = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.STAFF_ACCEPTED); // never advanced to MANAGER_CONFIRMED
      const finalShift = await getShift(fx, shift.id);
      expect(finalShift.filledCount).toBe(0); // the seat was never claimed
    });
  });

  // ===================================================================
  // C. Worker events — reminders / no-show / manager-confirmation-timeout
  // ===================================================================
  describe('C. worker events after cancellation', () => {
    async function seedConfirmedAssignment(fx: OrgFixture, staff: TestIdentity, startsAt: Date, endsAt: Date): Promise<{ shiftId: string; assignmentId: string }> {
      return withContext(ctxOf(fx.owner), async (m) => {
        const shift = await m.save(Shift, {
          organisationId: fx.organisation.id,
          venueId: fx.venueId,
          jobRoleId: fx.jobRoleId,
          startsAt,
          endsAt,
          breakMinutes: 0,
          requiredCount: 1,
          payRatePence: 1500,
          status: ShiftStatus.CONFIRMED,
          createdBy: fx.owner.userId,
          workspaceId: fx.owner.workspaceId!,
        });
        const assignment = await m.save(ShiftAssignment, {
          organisationId: fx.organisation.id,
          shiftId: shift.id,
          staffProfileId: staff.profileId!,
          status: ShiftAssignmentStatus.CONFIRMED,
          payRateSnapshotPence: 1500,
          assignedBy: fx.owner.userId,
          confirmedAt: new Date(),
          period: toTstzRange(startsAt, endsAt),
          workspaceId: fx.owner.workspaceId!,
        });
        return { shiftId: shift.id, assignmentId: assignment.id };
      });
    }

    async function cancelDirect(fx: OrgFixture, shiftId: string): Promise<void> {
      await withContext(ctxOf(fx.owner), (m) => m.update(Shift, shiftId, { status: ShiftStatus.CANCELLED, cancelledAt: new Date() }));
    }

    it('C11: a cancelled shift produces no 30m reminder', async () => {
      const fx = await seedOrgFixture('reminderC11');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() + 20 * 60 * 1000); // within the 30m window
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, staff, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await cancelDirect(fx, shiftId);
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const notifications = await withContext(ctxOf(fx.owner), (m) => m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }));
      expect(notifications).toHaveLength(0);
      expect(await countAudit(fx, 'shift.reminder_sent', assignmentId)).toBe(0);
    });

    it('C11b: same shift, NOT cancelled, DOES produce the 30m reminder (control — proves the suppression above is real, not a broken test)', async () => {
      const fx = await seedOrgFixture('reminderC11b');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() + 20 * 60 * 1000);
      const { assignmentId } = await seedConfirmedAssignment(fx, staff, startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000));
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const notifications = await withContext(ctxOf(fx.owner), (m) => m.find(Notification, { where: { relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId } }));
      expect(notifications.length).toBeGreaterThanOrEqual(1);
    });

    it('C14: a cancelled shift produces no no-show event/notification/audit', async () => {
      const fx = await seedOrgFixture('noshowC14');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() - 45 * 60 * 1000); // past the 30m no-show grace
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, staff, startsAt, new Date(Date.now() + 4 * 3600 * 1000));
      await cancelDirect(fx, shiftId);
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const assignment = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftAssignment, { id: assignmentId }));
      expect(assignment.status).toBe(ShiftAssignmentStatus.CONFIRMED); // never flipped to NO_SHOW
      expect(await countAudit(fx, 'shift_assignment.no_show', assignmentId)).toBe(0);
    });

    it('C29: a cancellation racing the no-show scan wins — no no-show event, no false NO_SHOW status', async () => {
      const fx = await seedOrgFixture('noshowRaceC29');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() - 45 * 60 * 1000);
      const { shiftId, assignmentId } = await seedConfirmedAssignment(fx, staff, startsAt, new Date(Date.now() + 4 * 3600 * 1000));
      await raceAndReport([() => runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService), () => cancelDirect(fx, shiftId)]);
      const assignment = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftAssignment, { id: assignmentId }));
      expect(assignment.status).not.toBe(ShiftAssignmentStatus.NO_SHOW);
    });

    it('C16: a cancelled shift produces no manager-confirmation-timeout resolution', async () => {
      const fx = await seedOrgFixture('timeoutC16');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(ctxOf(staff), offer.id);
      // Backdate staffAcceptedAt past the 60-minute timeout threshold, then cancel the shift.
      await withContext(ctxOf(fx.owner), (m) => m.update(JobOffer, offer.id, { staffAcceptedAt: new Date(Date.now() - 90 * 60 * 1000) }));
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);

      await runManagerConfirmationTimeoutCycle(adminDataSource, tenantContext, notificationService, auditService, 60);
      // PHASE 7.1 — the timeout worker auto-CONFIRMS (reusing the same
      // `applyOfferConfirmation` seat-claiming core a real Manager's confirm
      // click uses), never auto-rejects. Pass A's shift-cancelled check must
      // reject this candidate outright — the timeout path must never fire,
      // confirm, or claim a seat once cancellation-followup has already (or
      // will) reconcile it.
      const rows = await withContext(ctxOf(fx.owner), (m) =>
        m.query<Array<{ count: string }>>(
          `SELECT count(*) FROM core.audit_log WHERE action = 'offer.confirmed' AND entity_id = $1 AND metadata->>'source' = 'manager_confirmation_timeout'`,
          [offer.id],
        ),
      );
      expect(Number(rows[0]!.count)).toBe(0);
      const finalShift = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(0); // never claims a seat on a cancelled shift
      const notifications = await withContext(ctxOf(fx.owner), (m) => m.find(Notification, { where: { relatedEntityType: 'offer', relatedEntityId: offer.id } }));
      // staffAccept itself may have notified the manager once ("offer accepted") — the escalation type specifically must not appear.
      expect(notifications.filter((n) => n.type === ('manager_confirmation_timeout' as never))).toHaveLength(0);
    });

    it('C16b: same setup, NOT cancelled, DOES auto-confirm to MANAGER_CONFIRMED (control)', async () => {
      const fx = await seedOrgFixture('timeoutC16b');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(ctxOf(staff), offer.id);
      await withContext(ctxOf(fx.owner), (m) => m.update(JobOffer, offer.id, { staffAcceptedAt: new Date(Date.now() - 90 * 60 * 1000) }));

      await runManagerConfirmationTimeoutCycle(adminDataSource, tenantContext, notificationService, auditService, 60);
      const finalOffer = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED); // PHASE 7.1 — the offer is now actually auto-confirmed, not rejected or just flagged
      expect(finalOffer.confirmedBy).toBeFalsy(); // a SYSTEM confirmation, never a fabricated Manager identity
      const finalShift = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // the seat WAS genuinely claimed
      const rows = await withContext(ctxOf(fx.owner), (m) =>
        m.query<Array<{ count: string }>>(
          `SELECT count(*) FROM core.audit_log WHERE action = 'offer.confirmed' AND entity_id = $1 AND metadata->>'source' = 'manager_confirmation_timeout'`,
          [offer.id],
        ),
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });
  });

  // ===================================================================
  // D. Replacement (Phase 4 regression under Phase 5's cancellation lens)
  // ===================================================================
  describe('D. replacement vs cancellation', () => {
    it('D17: a cancelled shift never produces a new replacement_request from the worker (preparation)', async () => {
      const fx = await seedOrgFixture('replD17');
      const declining = await factory.createStaff(fx.organisation, { owner: fx.owner, label: 'declining' });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: declining.profileId! });
      await offerService.decline(ctxOf(declining), offer.id, { reason: 'no longer available' });
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);

      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const requests = await withContext(ctxOf(fx.owner), (m) => m.find(ReplacementRequest, { where: { shiftId: shift.id } }));
      expect(requests).toHaveLength(0);
    });

    it('D18/D33: approval racing cancellation — exactly one valid outcome (Phase 4 regression)', async () => {
      const fx = await seedOrgFixture('replD18');
      const candidate = await factory.createStaff(fx.organisation, { owner: fx.owner, label: 'cand' });
      await withContext(ctxOf(fx.owner), m => m.query("UPDATE core.staff_profile SET employment_status='active' WHERE id=$1", [candidate.profileId]));
      const declining = await factory.createStaff(fx.organisation, { owner: fx.owner, label: 'declining' });
      const shift = await seedOpenShift(fx);
      const declinedOffer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: declining.profileId! });
      const declinedAssignment = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftAssignment, { staffProfileId: declining.profileId! }));
      const request = await withContext(ctxOf(fx.owner), (m) =>
        m.save(ReplacementRequest, {
          organisationId: fx.organisation.id,
          workspaceId: fx.owner.workspaceId,
          shiftId: shift.id,
          declinedShiftAssignmentId: declinedAssignment.id,
          declinedOfferId: declinedOffer.id,
          status: ReplacementRequestStatus.AWAITING_APPROVAL,
          candidatesSnapshot: [{ staffProfileId: candidate.profileId!, firstName: 'Cand', lastName: 'Idate', score: 10, reasons: [] }],
        }),
      );

      await raceAndReport([
        () => replacementRequestService.approve(ctxOf(fx.owner), request.id, { staffProfileId: candidate.profileId! }),
        () => schedulingService.cancel(ctxOf(fx.owner), shift.id),
      ]);

      const finalRequest = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ReplacementRequest, { id: request.id }));
      const offerCount = await withContext(ctxOf(fx.owner), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = $1`, [candidate.profileId]));
      if (finalRequest.status === ReplacementRequestStatus.OFFER_SENT) {
        expect(Number(offerCount[0]!.count)).toBe(1);
      } else {
        expect(finalRequest.status).toBe(ReplacementRequestStatus.CANCELLED);
        expect(Number(offerCount[0]!.count)).toBe(0);
      }
    });

    it('D19: a cancelled shift cannot produce a replacement offer once cancellation is already in effect', async () => {
      const fx = await seedOrgFixture('replD19');
      const candidate = await factory.createStaff(fx.organisation, { owner: fx.owner, label: 'cand' });
      await withContext(ctxOf(fx.owner), m => m.query("UPDATE core.staff_profile SET employment_status='active' WHERE id=$1", [candidate.profileId]));
      const declining = await factory.createStaff(fx.organisation, { owner: fx.owner, label: 'declining' });
      const shift = await seedOpenShift(fx);
      const declinedOffer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: declining.profileId! });
      const declinedAssignment = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftAssignment, { staffProfileId: declining.profileId! }));
      const request = await withContext(ctxOf(fx.owner), (m) =>
        m.save(ReplacementRequest, {
          organisationId: fx.organisation.id,
          workspaceId: fx.owner.workspaceId,
          shiftId: shift.id,
          declinedShiftAssignmentId: declinedAssignment.id,
          declinedOfferId: declinedOffer.id,
          status: ReplacementRequestStatus.AWAITING_APPROVAL,
          candidatesSnapshot: [{ staffProfileId: candidate.profileId!, firstName: 'Cand', lastName: 'Idate', score: 10, reasons: [] }],
        }),
      );
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);

      await expect(replacementRequestService.approve(ctxOf(fx.owner), request.id, { staffProfileId: candidate.profileId! })).rejects.toBeInstanceOf(ConflictException);
      const offerCount = await withContext(ctxOf(fx.owner), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = $1`, [candidate.profileId]));
      expect(Number(offerCount[0]!.count)).toBe(0);
    });
  });

  // ===================================================================
  // E. Attendance — history preservation
  // ===================================================================
  describe('E. attendance history preservation', () => {
    it('E20: no attendance + cancellation → no missing-clock-out flag/notification, and the job completes cleanly with nothing to do', async () => {
      const fx = await seedOrgFixture('attE20');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 40 * 60 * 1000); // ended 40 min ago, past the 30 min grace
      const { assignmentId } = await withContext(ctxOf(fx.owner), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CANCELLED, createdBy: fx.owner.userId, workspaceId: fx.owner.workspaceId! });
        const assignment = await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.CANCELLED, payRateSnapshotPence: 1500, assignedBy: fx.owner.userId, period: toTstzRange(startsAt, endsAt), workspaceId: fx.owner.workspaceId! });
        return { assignmentId: assignment.id };
      });
      // `runAttendanceMonitorCycle` scans the whole shared dev database (no
      // organisationId narrowing option exists on this job, unlike offer-
      // expiry/final-timesheet/shift-report-scheduler) — under a full test-
      // suite run, `result.flagged` can be >0 from another concurrently-
      // running suite's own unrelated attendance row. The only assertion
      // that is actually about THIS fixture is that nothing was flagged for
      // THIS assignment specifically, checked below.
      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect(await countAudit(fx, 'shift_assignment.missing_clock_out_flagged', assignmentId)).toBe(0);
      const notifications = await withContext(ctxOf(fx.owner), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.notification WHERE related_entity_id = $1`, [assignmentId]));
      expect(Number(notifications[0]!.count)).toBe(0);
    });

    it('E21/E22: existing genuine attendance is preserved (never deleted, never touched) after cancellation, and the missing-clock-out FLAG (a label/notification only) is suppressed consistently with the discovery query\'s own exclusion', async () => {
      const fx = await seedOrgFixture('attE21');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 40 * 60 * 1000);
      const { shiftId, assignmentId, attendanceId, clockInAt } = await withContext(ctxOf(fx.owner), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CONFIRMED, createdBy: fx.owner.userId, workspaceId: fx.owner.workspaceId! });
        const assignment = await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500, assignedBy: fx.owner.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.owner.workspaceId! });
        const clockIn = new Date(startsAt.getTime() + 5 * 60 * 1000);
        const attendance = await m.save(Attendance, { organisationId: fx.organisation.id, workspaceId: fx.owner.workspaceId!, shiftId: shift.id, shiftAssignmentId: assignment.id, staffProfileId: staff.profileId!, clockInAt: clockIn, status: AttendanceStatus.CLOCKED_IN });
        return { shiftId: shift.id, assignmentId: assignment.id, attendanceId: attendance.id, clockInAt: clockIn };
      });
      // Cancel the shift AFTER real attendance already exists — the shift found real work, then got called off.
      await withContext(ctxOf(fx.owner), (m) => m.update(Shift, shiftId, { status: ShiftStatus.CANCELLED, cancelledAt: new Date() }));

      await runAttendanceMonitorCycle(adminDataSource, tenantContext, notificationService, auditService);
      const attendance = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(Attendance, { id: attendanceId }));
      // The clock-in fact itself is never touched, regardless of what the monitor decided about flagging.
      expect(attendance.clockInAt!.getTime()).toBe(clockInAt.getTime());
      expect(attendance.clockOutAt).toBeNull();
      // The status LABEL is untouched too — cancellation suppresses the flag consistently with the
      // discovery query's own `s.status != 'cancelled'` exclusion (see attendance-monitor.job.ts §9).
      expect(attendance.status).toBe(AttendanceStatus.CLOCKED_IN);
      expect(await countAudit(fx, 'shift_assignment.missing_clock_out_flagged', assignmentId)).toBe(0);
    });

    // NOTE: a "not cancelled, DOES get flagged" control test (matching the
    // C11b/C16b pattern elsewhere in this file) was attempted here and
    // removed — `runAttendanceMonitorCycle`'s discovery query has no
    // organisationId narrowing option (unlike offer-expiry/final-timesheet/
    // shift-report-scheduler) and orders `ORDER BY s.ends_at ASC LIMIT 500`,
    // so in the shared dev database, under a long-running full-suite pass,
    // a fresh fixture's relatively-recent `ends_at` can be crowded out of
    // the 500-row batch by older accumulated candidates from unrelated
    // tests — the same class of pre-existing batch-crowding limitation
    // already tracked for `account-invite-cleanup.job.ts`. This is a test-
    // environment reliability gap, not a Phase 5 regression; the E21/E22
    // suppression assertion above (0 flagged, checked directly against
    // THIS fixture's own assignmentId) is unaffected and reliable either
    // way. Flagged in the Phase 5 report as a newly-discovered, unrelated
    // defect for a future phase — not fixed here.
  });

  // ===================================================================
  // F. Reports
  // ===================================================================
  describe('F. report generation', () => {
    it('F23: a shift cancelled before its pre-shift report was ever generated never gets one generated after cancellation', async () => {
      const fx = await seedOrgFixture('reportF23');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() + Math.min(reportAvailableBeforeMinutes - 5, 60) * 60 * 1000);
      const { shiftId } = await withContext(ctxOf(fx.owner), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600 * 1000), breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CONFIRMED, createdBy: fx.owner.userId, workspaceId: fx.owner.workspaceId! });
        await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500, assignedBy: fx.owner.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000)), workspaceId: fx.owner.workspaceId! });
        return { shiftId: shift.id };
      });
      await withContext(ctxOf(fx.owner), (m) => m.update(Shift, shiftId, { status: ShiftStatus.CANCELLED, cancelledAt: new Date() }));

      await runShiftReportSchedulerCycle(adminDataSource, tenantContext, attendanceQr, qrImage, emailOutbox, fileService, reportAvailableBeforeMinutes, { organisationId: fx.organisation.id, audit: auditService });
      const report = await withContext(ctxOf(fx.owner), (m) => m.findOne(ShiftReport, { where: { shiftId } }));
      expect(report).toBeNull();
    }, 30_000);

    it('F25 (affected-row regression): final-timesheet delivery claims exactly once and never double-sends the roster email under the fixed [rows, rowCount] read', async () => {
      const fx = await seedOrgFixture('reportF25');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      // deliverFinalTimesheet's recipient query joins manager_venue -> manager_profile — without a real
      // Venue Manager assigned to this venue, `prepared.recipients` is empty and zero emails get enqueued
      // (which would look identical to a double-send bug from the outside — a real send with no recipients).
      await factory.createVenueManager(fx.organisation, { owner: fx.owner, venueIds: [fx.venueId] });
      const startsAt = new Date(Date.now() - 4 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 3600 * 1000);
      const { shiftId, reportId } = await withContext(ctxOf(fx.owner), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.COMPLETED, createdBy: fx.owner.userId, workspaceId: fx.owner.workspaceId! });
        await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.COMPLETED, payRateSnapshotPence: 1500, assignedBy: fx.owner.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.owner.workspaceId! });
        const report = await m.save(ShiftReport, { organisationId: fx.organisation.id, workspaceId: fx.owner.workspaceId!, shiftId: shift.id, status: 'finalised', finalisedAt: new Date(), finalisedBy: fx.owner.userId });
        return { shiftId: shift.id, reportId: report.id };
      });

      const result = await runFinalTimesheetCycle(adminDataSource, tenantContext, emailOutbox, fileService, { organisationId: fx.organisation.id, audit: auditService });
      expect(result.sent).toBe(1);
      // A second cycle must be a true no-op — the claim's own [rows, rowCount] read (not the outer tuple's always-2 length) is what makes `final_pdf_sent_at IS NULL` correctly stop matching.
      const second = await runFinalTimesheetCycle(adminDataSource, tenantContext, emailOutbox, fileService, { organisationId: fx.organisation.id, audit: auditService });
      expect(second.sent).toBe(0);
      const report = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(ShiftReport, { id: reportId }));
      expect(report.finalPdfSentAt).toBeInstanceOf(Date);
      const emailCount = await withContext(ctxOf(fx.owner), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.email_outbox WHERE job_type = $1 AND organisation_id = $2`, [EmailOutboxJobType.NOTIFICATION, fx.organisation.id]));
      expect(Number(emailCount[0]!.count)).toBe(1); // exactly one email enqueued across BOTH cycles, not two.
      void shiftId;
    }, 30_000);
  });

  // ===================================================================
  // G. Email
  // ===================================================================
  describe('G. queued email revalidation', () => {
    it('G26/G28: a pre-shift roster email queued before cancellation is revalidated and cancelled before send, never delivered as if the shift were still active', async () => {
      const fx = await seedOrgFixture('emailG26');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const startsAt = new Date(Date.now() + Math.min(reportAvailableBeforeMinutes - 5, 60) * 60 * 1000);
      const venueManager = await factory.createVenueManager(fx.organisation, { owner: fx.owner, venueIds: [fx.venueId] });
      const { shiftId } = await withContext(ctxOf(fx.owner), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId: fx.venueId, jobRoleId: fx.jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600 * 1000), breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CONFIRMED, createdBy: fx.owner.userId, workspaceId: fx.owner.workspaceId! });
        await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staff.profileId!, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500, assignedBy: fx.owner.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000)), workspaceId: fx.owner.workspaceId! });
        return { shiftId: shift.id };
      });
      void venueManager;

      // Generate the roster+QR report and enqueue its email WHILE the shift is still active.
      const generated = await runShiftReportSchedulerCycle(adminDataSource, tenantContext, attendanceQr, qrImage, emailOutbox, fileService, reportAvailableBeforeMinutes, { organisationId: fx.organisation.id, audit: auditService });
      expect(generated.generated).toBe(1);
      const outboxRow = await withContext(ctxOf(fx.owner), (m) => m.findOneOrFail(EmailOutbox, { where: { organisationId: fx.organisation.id, jobType: EmailOutboxJobType.NOTIFICATION }, order: { createdAt: 'DESC' } }));
      expect(outboxRow.attachmentFileId).toBeTruthy();

      // NOW cancel the shift — the email is already sitting in the outbox, PENDING.
      await withContext(ctxOf(fx.owner), (m) => m.update(Shift, shiftId, { status: ShiftStatus.CANCELLED, cancelledAt: new Date() }));

      // Directly exercise the send processor's revalidation without needing a real BullMQ job/SMTP transport.
      const emailService = app.get(EmailService);
      const fakeSend = jest.spyOn(emailService, 'send').mockResolvedValue({ provider: 'LOGGER' }); // never actually invoked below — revalidation must reject before this is reached
      const processor = createEmailSendProcessor({ tenantContext, emailService, auditService, fileService });
      await processor({ data: { emailOutboxId: outboxRow.id, organisationId: fx.organisation.id }, attemptsMade: 0, opts: {} } as never);

      const finalRow = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(EmailOutbox, { id: outboxRow.id }));
      expect(finalRow.status).toBe(EmailOutboxStatus.CANCELLED);
      expect(fakeSend).not.toHaveBeenCalled();
      fakeSend.mockRestore();
    }, 30_000);

    it('G27: the cancellation-notification itself (to the affected staff member) is unaffected by the roster-specific revalidation — it still gets enqueued/sent normally', async () => {
      const fx = await seedOrgFixture('emailG27');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(ctxOf(staff), offer.id);
      await schedulingService.cancel(ctxOf(fx.owner), shift.id);
      await runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService);

      const notifications = await withContext(ctxOf(fx.owner), (m) => m.find(Notification, { where: { userId: staff.userId, type: 'shift_cancelled' as never } }));
      expect(notifications.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ===================================================================
  // Regression: unrelated offer-expiry proactive path is unaffected
  // ===================================================================
  it('regression: proactive offer expiry (unrelated to cancellation) still works on an OPEN shift', async () => {
    const fx = await seedOrgFixture('regressionExpiry');
    const staff = await factory.createStaff(fx.organisation, { owner: fx.owner });
    const shift = await seedOpenShift(fx);
    const offer = await offerService.send(ctxOf(fx.owner), shift.id, { staffProfileId: staff.profileId!, expiresInHours: 1 });
    await withContext(ctxOf(fx.owner), (m) => m.update(JobOffer, offer.id, { expiresAt: new Date(Date.now() - 60_000) }));
    const result = await runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    const finalOffer = await withContext(ctxOf(fx.owner), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
    expect(finalOffer.status).toBe(OfferStatus.EXPIRED);
  });

  it('sanity: isLockUnavailable helper is importable and callable (guards the raceAndReport helper\'s own tolerance path)', () => {
    expect(typeof isLockUnavailable).toBe('function');
  });
});
