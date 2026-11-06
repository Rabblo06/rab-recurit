import 'reflect-metadata';
import {
  CONFIRMATION_DEADLINE_MESSAGES,
  CONFIRMATION_DEADLINE_NOTIFICATION,
  CONFIRMATION_DEADLINE_PASSED,
  OFFER_CLOSED_REASON,
  OfferStatus,
  ShiftAssignmentStatus,
  ShiftStatus,
} from '@rab/shared';
import { ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceService } from '@rab/server/modules/attendance/services/attendance.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { ReplacementRequest } from '@rab/server/modules/offer/entities/replacement-request.entity';
import { applyOfferConfirmation } from '@rab/server/modules/offer/services/apply-offer-confirmation';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { VenueOfferPipelineService } from '@rab/server/modules/offer/services/venue-offer-pipeline.service';
import { withdrawUnconfirmedOffer } from '@rab/server/modules/offer/services/withdraw-unconfirmed-offer';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { SchedulingService } from '@rab/server/modules/scheduling/services/scheduling.service';
import { confirmationDeadlineSql } from '@rab/server/modules/scheduling/utils/assignment-time';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runConfirmationDeadlineBackstopScan, runManagerConfirmationDeadlineCycle } from '../../queues/rab-offers/offer-expiry.job';
import { runReplacementStaffCycle } from '../../queues/rab-offers/replacement-staff.job';
import { runShiftCancellationFollowupCycle } from '../../queues/rab-shifts/shift-cancellation-followup.job';
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner rule 2026-11-06 — NO automatic confirmation; an unconfirmed STAFF_ACCEPTED offer is withdrawn at its approval
 * deadline (standard: assignment start − 30 min; replacement/standby: window end), on the DATABASE clock. Real Postgres,
 * RLS on, no mocks. Replaces manager-confirmation-timeout-correctness (which pinned the superseded Phase 7.1 auto-confirm).
 *
 * Fixture technique (plan §10.4): every offer is sent and accepted through the real services while its shift starts more
 * than 30 minutes ahead; the test then MOVES the assignment window (and the shift envelope) in SQL to put the deadline at
 * a controlled offset from the database clock, and re-aims the pointer exactly as a future period-editing feature must.
 * No production code has a test bypass.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const LEAD_MS = 30 * 60_000;
const HOUR = 3600_000;

describeIfDb('manager confirmation deadline correctness (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let realtimeEventService: RealtimeEventService;
  let schedulingService: SchedulingService;
  let offerService: OfferService;
  let pipelineService: VenueOfferPipelineService;
  let attendanceService: AttendanceService;
  let factory: TestIdentityFactory;
  const organisations: string[] = [];
  let suiteStart: Date;

  interface Fixture {
    organisation: Organisation;
    managerA: TestIdentity;
    managerB: TestIdentity;
    venueId: string;
    otherVenueId: string;
    jobRoleId: string;
  }

  function ctxOf(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext {
    return { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' };
  }
  function staffCtxOf(fx: Fixture, staff: TestIdentity): AuthContext {
    return { organisationId: fx.organisation.id, workspaceId: fx.managerA.workspaceId, userId: staff.userId, role: 'staff' };
  }

  async function withContext<T>(ctx: { organisationId: string | null; workspaceId: string | null; userId: string }, fn: (manager: DataSource['manager']) => Promise<T>): Promise<T> {
    return dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('search_path', 'core', true)`);
      await manager.query(`SELECT set_config('rab.organisation_id', $1, true)`, [ctx.organisationId ?? '']);
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [ctx.workspaceId ?? '']);
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ctx.userId]);
      await manager.query(`SELECT set_config('rab.role', '', true)`);
      return fn(manager);
    });
  }
  const asA = <T = unknown>(fx: Fixture, sql: string, params: unknown[] = []) => withContext(ctxOf(fx.managerA), (m) => m.query<T[]>(sql, params));

  async function dbNow(): Promise<Date> {
    const [{ now }] = await adminDataSource.manager.query<Array<{ now: Date }>>(`SELECT clock_timestamp() AS now`);
    return new Date(now);
  }

  async function seedFixture(label: string): Promise<Fixture> {
    const organisation = await factory.createOrganisation(label);
    organisations.push(organisation.id);
    const managerA = await factory.createInternalManager(organisation, { permissions: 'production', label: `${label}-a` });
    const managerB = await factory.createInternalManager(organisation, { permissions: 'production', label: `${label}-b` });
    const ids = await withContext(ctxOf(managerA), async (m) => {
      const venue = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue A`, createdBy: managerA.userId, workspaceId: managerA.workspaceId! });
      const other = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue Other`, createdBy: managerA.userId, workspaceId: managerA.workspaceId! });
      const jobRole = await m.save(JobRole, { organisationId: organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: managerA.userId, workspaceId: managerA.workspaceId! });
      return { venueId: venue.id, otherVenueId: other.id, jobRoleId: jobRole.id };
    });
    return { organisation, managerA, managerB, ...ids };
  }

  async function seedOpenShift(fx: Fixture, opts: { requestedBy?: string; requiredCount?: number; startsInMs?: number } = {}): Promise<Shift> {
    const startsAt = new Date((await dbNow()).getTime() + (opts.startsInMs ?? 3 * HOUR));
    const endsAt = new Date(startsAt.getTime() + 8 * HOUR);
    return withContext(ctxOf(fx.managerA), (m) =>
      m.save(Shift, {
        organisationId: fx.organisation.id,
        venueId: fx.venueId,
        jobRoleId: fx.jobRoleId,
        startsAt,
        endsAt,
        breakMinutes: 0,
        requiredCount: opts.requiredCount ?? 1,
        payRatePence: 1500,
        status: ShiftStatus.OPEN,
        createdBy: fx.managerA.userId,
        requestedBy: opts.requestedBy,
        workspaceId: fx.managerA.workspaceId!,
      }),
    );
  }

  /** Real send + real staff accept (shift ≥ 30 min ahead, so both are allowed). */
  async function sendAndAccept(fx: Fixture, shift: Shift, staff: TestIdentity): Promise<JobOffer> {
    const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
    const accepted = await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
    expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED);
    return accepted;
  }

  /**
   * FIXTURE STEP (tests only): move this offer's assignment window so its STANDARD deadline (start − 30 min) is
   * `deadlineOffsetMs` from the database clock, keep the shift envelope consistent, and re-aim its due-work pointer to the
   * new deadline (what any future period-editing feature must do — see confirmationDeadlineSql's doc).
   */
  async function setDeadline(fx: Fixture, offer: JobOffer, deadlineOffsetMs: number, durationMs = 8 * HOUR): Promise<Date> {
    const now = await dbNow();
    const start = new Date(now.getTime() + deadlineOffsetMs + LEAD_MS);
    const end = new Date(start.getTime() + durationMs);
    return placeWindow(fx, offer, start, end);
  }

  async function placeWindow(fx: Fixture, offer: JobOffer, start: Date, end: Date): Promise<Date> {
    await asA(fx, `UPDATE core.shift_assignment SET period = tstzrange($1, $2, '[)') WHERE id = $3`, [start, end, offer.shiftAssignmentId]);
    await asA(
      fx,
      `UPDATE core.shift s SET starts_at = $1, ends_at = $2, default_starts_at = $1, default_ends_at = $2
         FROM core.shift_assignment sa WHERE sa.id = $3 AND s.id = sa.shift_id`,
      [start, end, offer.shiftAssignmentId],
    );
    const [{ deadline_at }] = await asA<{ deadline_at: Date }>(
      fx,
      // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
      `SELECT ${confirmationDeadlineSql('o', 'sa', 's')} AS deadline_at FROM core.job_offer o
         JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id JOIN core.shift s ON s.id = sa.shift_id WHERE o.id = $1`,
      [offer.id],
    );
    await adminDataSource.manager.query(
      `UPDATE core.worker_due_work SET due_at = $1, status = 'PENDING', lease_until = NULL, lease_token = NULL
        WHERE job_type = 'manager_confirmation_timeout' AND subject_type = 'job_offer' AND subject_id = $2`,
      [deadline_at, offer.id],
    );
    return new Date(deadline_at);
  }

  const reload = (fx: Fixture, id: string) => withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id }));
  const reloadAssignment = (fx: Fixture, id: string) => withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id }));
  const reloadShift = (fx: Fixture, id: string) => withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id }));

  async function runDeadlineCycle(): Promise<number> {
    const a = await runManagerConfirmationDeadlineCycle(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService);
    const b = await runConfirmationDeadlineBackstopScan(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService);
    return a.withdrawn + b.withdrawn;
  }

  async function withdrawalAudits(fx: Fixture, offerId: string): Promise<Array<{ actor_user_id: string | null; metadata: Record<string, unknown> }>> {
    return asA(fx, `SELECT actor_user_id, metadata FROM core.audit_log WHERE action = 'offer.rejected_by_worker' AND entity_id = $1`, [offerId]);
  }
  async function notificationsFor(fx: Fixture, userId: string, offerId: string): Promise<Notification[]> {
    return adminDataSource.manager.query(
      `SELECT type, title, message FROM core.notification WHERE organisation_id = $1 AND user_id = $2 AND related_entity_type = 'offer' AND related_entity_id = $3`,
      [fx.organisation.id, userId, offerId],
    );
  }
  function expectDeadline409(error: unknown, message: string = CONFIRMATION_DEADLINE_MESSAGES.CONFIRM): void {
    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as HttpException).getResponse() as Record<string, unknown>;
    expect(body).toEqual({ statusCode: 409, code: CONFIRMATION_DEADLINE_PASSED, message });
  }
  async function expectWithdrawn(fx: Fixture, offerId: string, assignmentId: string): Promise<void> {
    const offer = await reload(fx, offerId);
    expect(offer.status).toBe(OfferStatus.MANAGER_REJECTED);
    expect(offer.rejectedBy ?? null).toBeNull();
    expect(offer.rejectionReason).toBe(OFFER_CLOSED_REASON.CONFIRMATION_DEADLINE_PASSED);
    expect(offer.confirmedBy ?? null).toBeNull();
    expect((await reloadAssignment(fx, assignmentId)).status).toBe(ShiftAssignmentStatus.REJECTED);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    dataSource = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    auditService = app.get(AuditService);
    notificationService = app.get(NotificationService);
    realtimeEventService = app.get(RealtimeEventService);
    schedulingService = app.get(SchedulingService);
    offerService = app.get(OfferService);
    pipelineService = app.get(VenueOfferPipelineService);
    attendanceService = app.get(AttendanceService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    suiteStart = await dbNow();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ===================================================================
  // Z. Zero automatic confirmation
  // ===================================================================
  describe('Z. the system never confirms', () => {
    it('Z3: a Venue-Manager-requested shift: accept ends at STAFF_ACCEPTED (no seat), and the sender is told it awaits confirmation', async () => {
      const fx = await seedFixture('dlVmReq');
      const vm = await factory.createVenueManager(fx.organisation, { owner: fx.managerA, venueIds: [fx.venueId] });
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx, { requestedBy: vm.userId });
      const offer = await sendAndAccept(fx, shift, staff);
      expect((await reloadAssignment(fx, offer.shiftAssignmentId)).status).toBe(ShiftAssignmentStatus.STAFF_ACCEPTED);
      expect((await reloadShift(fx, shift.id)).filledCount).toBe(0);
      const managerNotes = await notificationsFor(fx, fx.managerA.userId, offer.id);
      expect(managerNotes.map((n) => n.type)).toEqual(['offer_accepted']);
      expect(managerNotes[0]!.message).toContain('awaiting your confirmation');
      const pointer = await adminDataSource.manager.query(`SELECT due_at FROM core.worker_due_work WHERE job_type = 'manager_confirmation_timeout' AND subject_id = $1`, [offer.id]);
      expect(pointer).toHaveLength(1);
      expect(new Date(pointer[0].due_at).getTime()).toBe(new Date(shift.startsAt).getTime() - LEAD_MS); // armed with the DB-computed deadline
    });

    it('Z4: a deadline-due standby / replacement acceptance is withdrawn by the Worker, never confirmed', async () => {
      const fx = await seedFixture('dlKinds');
      for (const kind of ['replacement', 'standby'] as const) {
        const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: kind });
        const shift = await seedOpenShift(fx);
        const offer = await sendAndAccept(fx, shift, staff);
        // FIXTURE: give it the kind (a real replacement send needs a vacancy-freeing no-show; the kind is what the rule reads).
        await asA(fx, `UPDATE core.job_offer SET offer_kind = $1 WHERE id = $2`, [kind, offer.id]);
        const now = await dbNow();
        await placeWindow(fx, offer, new Date(now.getTime() - 4 * HOUR), new Date(now.getTime() - 60_000)); // window ended 1 min ago
        await runDeadlineCycle();
        await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
        expect((await reloadShift(fx, shift.id)).filledCount).toBe(0);
      }
    });
  });

  // ===================================================================
  // B. Deadline and withdrawal
  // ===================================================================
  describe('B. deadline and withdrawal', () => {
    it('B1: before the deadline nothing happens and the pointer is re-aimed at the real deadline', async () => {
      const fx = await seedFixture('dlBefore');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      const deadline = await setDeadline(fx, offer, 10 * 60_000);
      // Pre-deploy pointer shape: due = staff_accepted_at (the old API armed "due now").
      await adminDataSource.manager.query(`UPDATE core.worker_due_work SET due_at = now() - interval '1 minute' WHERE job_type = 'manager_confirmation_timeout' AND subject_id = $1`, [offer.id]);
      await runDeadlineCycle();
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.STAFF_ACCEPTED);
      const [pointer] = await adminDataSource.manager.query(`SELECT due_at, status FROM core.worker_due_work WHERE job_type = 'manager_confirmation_timeout' AND subject_id = $1`, [offer.id]);
      expect(new Date(pointer.due_at).getTime()).toBe(deadline.getTime());
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(0);
    });

    it('B2 (T-N2): at/after the deadline: withdrawn, history kept, one audit, exact notifications to staff, manager and THIS venue’s VM only', async () => {
      const fx = await seedFixture('dlWithdraw');
      const vm = await factory.createVenueManager(fx.organisation, { owner: fx.managerA, venueIds: [fx.venueId], label: 'vm-here' });
      const otherVm = await factory.createVenueManager(fx.organisation, { owner: fx.managerA, venueIds: [fx.otherVenueId], label: 'vm-other' });
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      const deadline = await setDeadline(fx, offer, -5_000);

      expect(await runDeadlineCycle()).toBeGreaterThanOrEqual(1);
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      const finalOffer = await reload(fx, offer.id);
      expect(finalOffer.staffAcceptedAt).toBeTruthy(); // history kept
      expect((await reloadShift(fx, shift.id)).filledCount).toBe(0);

      const audits = await withdrawalAudits(fx, offer.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actor_user_id).toBeNull();
      expect(audits[0]!.metadata).toMatchObject({ reason: 'confirmation_deadline_passed', deadlineAt: deadline.toISOString(), shiftId: shift.id, offerKind: 'standard', notified: true });

      const staffNotes = await notificationsFor(fx, staff.userId, offer.id);
      expect(staffNotes.filter((n) => n.type === 'offer_rejected')).toEqual([
        expect.objectContaining({ type: 'offer_rejected', title: 'Shift offer withdrawn', message: CONFIRMATION_DEADLINE_NOTIFICATION.STAFF.message }),
      ]);
      expect(CONFIRMATION_DEADLINE_NOTIFICATION.STAFF.message).toBe('Your shift offer was withdrawn because final manager confirmation was not received before the approval deadline.');
      const managerNotes = (await notificationsFor(fx, fx.managerA.userId, offer.id)).filter((n) => n.type === 'manager_confirmation_timeout');
      expect(managerNotes).toEqual([expect.objectContaining({ title: 'Confirmation deadline passed', message: 'The manager-confirmation deadline has passed. The pending staff assignment has been withdrawn and may require replacement.' })]);
      const vmNotes = await notificationsFor(fx, vm.userId, offer.id);
      expect(vmNotes).toEqual([expect.objectContaining({ type: 'manager_confirmation_timeout', title: 'Confirmation deadline passed', message: CONFIRMATION_DEADLINE_NOTIFICATION.MANAGER.message })]);
      expect(await notificationsFor(fx, otherVm.userId, offer.id)).toHaveLength(0); // another venue's VM hears nothing
      expect(await notificationsFor(fx, fx.managerB.userId, offer.id)).toHaveLength(0);
      // Q10: no automatic re-allocation.
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect(await withContext(ctxOf(fx.managerA), (m) => m.find(ReplacementRequest, { where: { shiftId: shift.id } }))).toHaveLength(0);
    });

    it('B3: a PENDING offer past its deadline is left to its own expiry (Q3)', async () => {
      const fx = await seedFixture('dlPending');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      await setDeadline(fx, offer, -60_000);
      await runDeadlineCycle();
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.PENDING);
    });

    it('B4: terminal offers are never touched (confirmed, manager-rejected, declined, withdrawn)', async () => {
      const fx = await seedFixture('dlTerminal');
      const staff = [0, 1, 2, 3].map(async (i) => factory.createStaff(fx.organisation, { owner: fx.managerA, label: `t${i}` }));
      const [s0, s1, s2, s3] = await Promise.all(staff);
      const o0 = await sendAndAccept(fx, await seedOpenShift(fx), s0!);
      await offerService.managerConfirm(ctxOf(fx.managerA), o0.id);
      const o1 = await sendAndAccept(fx, await seedOpenShift(fx), s1!);
      await offerService.managerReject(ctxOf(fx.managerA), o1.id, { reason: 'Not this time' });
      const o2 = await offerService.send(ctxOf(fx.managerA), (await seedOpenShift(fx)).id, { staffProfileId: s2!.profileId! });
      await offerService.decline(staffCtxOf(fx, s2!), o2.id, { reason: 'busy' } as never);
      const o3 = await offerService.send(ctxOf(fx.managerA), (await seedOpenShift(fx)).id, { staffProfileId: s3!.profileId! });
      await offerService.withdraw(ctxOf(fx.managerA), o3.id);
      for (const o of [o0, o1, o2, o3]) await setDeadline(fx, o, -60_000);
      await runDeadlineCycle();
      expect((await reload(fx, o0.id)).status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect((await reload(fx, o1.id)).rejectedBy).toBe(fx.managerA.userId);
      expect((await reload(fx, o2.id)).status).toBe(OfferStatus.DECLINED);
      expect((await reload(fx, o3.id)).status).toBe(OfferStatus.WITHDRAWN);
      for (const o of [o0, o1, o2, o3]) expect(await withdrawalAudits(fx, o.id)).toHaveLength(0);
    });

    it('B5: an accepted offer WITHOUT a pointer is caught by the backstop scan', async () => {
      const fx = await seedFixture('dlBackstop');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, offer, -60_000);
      await adminDataSource.manager.query(`DELETE FROM core.worker_due_work WHERE job_type = 'manager_confirmation_timeout' AND subject_id = $1`, [offer.id]);
      await runConfirmationDeadlineBackstopScan(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService);
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
    });
  });

  // ===================================================================
  // C. Manual confirm vs the deadline (5 layers: guard is the controller's; here service + CAS)
  // ===================================================================
  describe('C. manual confirm and the deadline', () => {
    it('C1: before the deadline the sender confirms (confirmedBy = the manager); the Worker later does nothing', async () => {
      const fx = await seedFixture('dlConfirmOk');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      await setDeadline(fx, offer, 10 * 60_000);
      const confirmed = await offerService.managerConfirm(ctxOf(fx.managerA), offer.id);
      expect(confirmed.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect(confirmed.confirmedBy).toBe(fx.managerA.userId);
      await setDeadline(fx, offer, -60_000);
      await runDeadlineCycle();
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect((await reloadShift(fx, shift.id)).filledCount).toBe(1);
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(0);
    });

    it('C2 (T-R6b): a confirm after the deadline with the Worker DOWN gets 409 CONFIRMATION_DEADLINE_PASSED and withdraws lazily, once', async () => {
      const fx = await seedFixture('dlLazy');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      await setDeadline(fx, offer, -2 * HOUR, 6 * HOUR); // the Worker has been down for 2 hours past the deadline
      await offerService.managerConfirm(ctxOf(fx.managerA), offer.id).then(() => { throw new Error('expected 409'); }, (e) => expectDeadline409(e));
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      expect((await reloadShift(fx, shift.id)).filledCount).toBe(0);
      const audits = await withdrawalAudits(fx, offer.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({ source: 'api_confirm' });
      // The Worker comes back: nothing more happens (one audit, one notice each).
      await runDeadlineCycle();
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(1);
      expect((await notificationsFor(fx, staff.userId, offer.id)).filter((n) => n.type === 'offer_rejected')).toHaveLength(1);
      expect((await notificationsFor(fx, fx.managerA.userId, offer.id)).filter((n) => n.type === 'manager_confirmation_timeout')).toHaveLength(1);
      // A second confirm attempt: still the coded 409, still no extra side effects.
      await offerService.managerConfirm(ctxOf(fx.managerA), offer.id).then(() => { throw new Error('expected 409'); }, (e) => expectDeadline409(e));
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(1);
    });

    it('C3: confirm-all past the deadline reports the deadline message per recipient and withdraws them', async () => {
      const fx = await seedFixture('dlConfirmAll');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      await setDeadline(fx, offer, -60_000);
      const result = await offerService.confirmAll(ctxOf(fx.managerA), offer.offerBatchId!);
      expect(result.results).toEqual([{ staffProfileId: staff.profileId, ok: false, message: CONFIRMATION_DEADLINE_MESSAGES.CONFIRM }]);
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
    });

    it('C5: reject after the deadline — before the Worker ran it is still the manager’s decision; once withdrawn it is the coded 409 and nothing changes', async () => {
      const fx = await seedFixture('dlReject');
      const s1 = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'r1' });
      const s2 = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'r2' });
      const pending = await sendAndAccept(fx, await seedOpenShift(fx), s1);
      await setDeadline(fx, pending, -60_000);
      const rejected = await offerService.managerReject(ctxOf(fx.managerA), pending.id, { reason: 'Not needed' });
      expect(rejected).toMatchObject({ status: OfferStatus.MANAGER_REJECTED, rejectedBy: fx.managerA.userId, rejectionReason: 'Not needed' });
      await runDeadlineCycle();
      expect(await withdrawalAudits(fx, pending.id)).toHaveLength(0);

      const withdrawn = await sendAndAccept(fx, await seedOpenShift(fx), s2);
      await setDeadline(fx, withdrawn, -60_000);
      await runDeadlineCycle();
      await offerService.managerReject(ctxOf(fx.managerA), withdrawn.id, { reason: 'late' }).then(
        () => { throw new Error('expected 409'); },
        (e) => expectDeadline409(e, CONFIRMATION_DEADLINE_MESSAGES.REJECT),
      );
      await expectWithdrawn(fx, withdrawn.id, withdrawn.shiftAssignmentId);
      expect(await asA(fx, `SELECT 1 FROM core.audit_log WHERE action = 'offer.rejected' AND entity_id = $1`, [withdrawn.id])).toHaveLength(0);
    });

    it('C4 (T-X2/X3): another workspace’s manager and a Venue Manager get 404 (never 403) and nothing changes', async () => {
      const fx = await seedFixture('dlIdor');
      const vm = await factory.createVenueManager(fx.organisation, { owner: fx.managerA, venueIds: [fx.venueId] });
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, offer, -60_000);
      await expect(offerService.managerConfirm(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.managerConfirm(ctxOf(vm), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      // Neither a foreign confirm nor a VM confirm triggers the lazy withdrawal (only the owner's refused confirm does).
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.STAFF_ACCEPTED);
    });
  });

  // ===================================================================
  // S. Sending and accepting after the deadline (Q1a, Q2)
  // ===================================================================
  describe('S. send and accept refusals', () => {
    it('S1 (Q1a): a STANDARD send to a shift starting in under 30 minutes is a 409 with the deadline code; nothing is created', async () => {
      const fx = await seedFixture('dlSend');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx, { startsInMs: 20 * 60_000 });
      await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! }).then(
        () => { throw new Error('expected 409'); },
        (e) => expectDeadline409(e, CONFIRMATION_DEADLINE_MESSAGES.SEND),
      );
      const bulk = await offerService.sendBulk(ctxOf(fx.managerA), shift.id, { staffProfileIds: [staff.profileId!] } as never);
      expect(bulk.results).toEqual([{ staffProfileId: staff.profileId, ok: false, message: CONFIRMATION_DEADLINE_MESSAGES.SEND }]);
      const offers = await asA(fx, `SELECT o.id FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1`, [shift.id]);
      expect(offers).toHaveLength(0);
    });

    it('S2 (Q2): accepting a pending offer after its deadline is a 409; the offer stays PENDING; no pointer', async () => {
      const fx = await seedFixture('dlAccept');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await offerService.send(ctxOf(fx.managerA), (await seedOpenShift(fx)).id, { staffProfileId: staff.profileId! });
      await setDeadline(fx, offer, -60_000);
      await offerService.staffAccept(staffCtxOf(fx, staff), offer.id).then(
        () => { throw new Error('expected 409'); },
        (e) => expectDeadline409(e, CONFIRMATION_DEADLINE_MESSAGES.ACCEPT),
      );
      const after = await reload(fx, offer.id);
      expect(after.status).toBe(OfferStatus.PENDING);
      expect(after.staffAcceptedAt ?? null).toBeNull();
      expect(await adminDataSource.manager.query(`SELECT 1 FROM core.worker_due_work WHERE subject_id = $1`, [offer.id])).toHaveLength(0);
    });

    it('S3 (T-R5): a duplicate concurrent accept yields one STAFF_ACCEPTED and exactly one pointer', async () => {
      const fx = await seedFixture('dlDupAccept');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await offerService.send(ctxOf(fx.managerA), (await seedOpenShift(fx)).id, { staffProfileId: staff.profileId! });
      const settled = await Promise.allSettled([offerService.staffAccept(staffCtxOf(fx, staff), offer.id), offerService.staffAccept(staffCtxOf(fx, staff), offer.id)]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.STAFF_ACCEPTED);
      expect(await adminDataSource.manager.query(`SELECT 1 FROM core.worker_due_work WHERE subject_id = $1`, [offer.id])).toHaveLength(1);
    });
  });

  // ===================================================================
  // D. Exact boundary and BST/GMT
  // ===================================================================
  describe('D. boundary and clocks', () => {
    it('D1 (T-B1): confirm just before the deadline succeeds; confirm just after it is refused', async () => {
      const fx = await seedFixture('dlBoundary');
      const s1 = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'b1' });
      const s2 = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'b2' });
      const o1 = await sendAndAccept(fx, await seedOpenShift(fx), s1);
      const o2 = await sendAndAccept(fx, await seedOpenShift(fx), s2);
      const d1 = await setDeadline(fx, o1, 4_000);
      await setDeadline(fx, o2, 4_000);
      expect((await dbNow()).getTime()).toBeLessThan(d1.getTime());
      expect((await offerService.managerConfirm(ctxOf(fx.managerA), o1.id)).status).toBe(OfferStatus.MANAGER_CONFIRMED);
      await adminDataSource.manager.query(`SELECT pg_sleep(4.5)`);
      await offerService.managerConfirm(ctxOf(fx.managerA), o2.id).then(() => { throw new Error('expected 409'); }, (e) => expectDeadline409(e));
    });

    it('D2 (T-B2): at equality the withdrawal predicate holds (>=) and the confirm predicate does not (<)', async () => {
      const [row] = await adminDataSource.manager.query(
        // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
        `SELECT ts >= d AS withdraw, ts < d AS confirm FROM (
           SELECT $1::timestamptz AS ts, ${confirmationDeadlineSql('o', 'sa', 's')} AS d
             FROM (SELECT 'standard'::text AS offer_kind) o, (SELECT tstzrange($2, $3, '[)') AS period) sa, (SELECT $2::timestamptz AS starts_at, $3::timestamptz AS ends_at) s) x`,
        ['2026-12-01T09:30:00Z', '2026-12-01T10:00:00Z', '2026-12-01T18:00:00Z'],
      );
      expect(row).toEqual({ withdraw: true, confirm: false });
    });

    it.each(['Europe/London', 'UTC'])('D3 (T-D1/D2): the deadline is exactly start − 1800 s across BST/GMT changes (session TimeZone %s)', async (tz) => {
      const starts = ['2026-10-25T00:20:00Z', '2026-10-25T01:20:00Z', '2027-03-28T01:10:00Z', '2027-03-28T00:40:00Z'];
      await adminDataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('TimeZone', $1, true)`, [tz]);
        for (const start of starts) {
          const [row] = await m.query(
            // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
            `SELECT extract(epoch FROM $1::timestamptz - d)::int AS lead_seconds, (d AT TIME ZONE 'UTC')::text AS deadline_utc FROM (
               SELECT ${confirmationDeadlineSql('o', 'sa', 's')} AS d
                 FROM (SELECT 'standard'::text AS offer_kind) o, (SELECT tstzrange($1::timestamptz, $1::timestamptz + interval '6 hours', '[)') AS period) sa,
                      (SELECT $1::timestamptz AS starts_at, $1::timestamptz + interval '6 hours' AS ends_at) s) x`,
            [start],
          );
          expect(row.lead_seconds).toBe(1800);
          expect(new Date(`${row.deadline_utc}Z`).getTime()).toBe(new Date(start).getTime() - LEAD_MS);
        }
        // Replacement / standby: the deadline is the window end, unchanged by the zone.
        const [rep] = await m.query(
          // sql-injection-reviewed: code-constant SQL fragment from a helper called with literal aliases; values are bound $n parameters.
          `SELECT (${confirmationDeadlineSql('o', 'sa', 's')} = $2::timestamptz) AS is_end
             FROM (SELECT 'replacement'::text AS offer_kind) o, (SELECT tstzrange($1::timestamptz, $2::timestamptz, '[)') AS period) sa,
                  (SELECT $1::timestamptz AS starts_at, $2::timestamptz AS ends_at) s`,
          ['2026-10-25T00:20:00Z', '2026-10-25T06:20:00Z'],
        );
        expect(rep.is_end).toBe(true);
      });
    });
  });

  // ===================================================================
  // R. Races
  // ===================================================================
  describe('R. races', () => {
    it('R1a (T-R1, Q11): a confirm that CLAIMED the row before the deadline but commits after it stands; the withdrawal then finds nothing', async () => {
      const fx = await seedFixture('dlRaceConfirmFirst');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      await setDeadline(fx, offer, 1_500);
      const ctx = ctxOf(fx.managerA);
      const confirming = tenantContext.runInWorkspaceContext(ctx, async (m) => {
        const o = await m.findOneByOrFail(JobOffer, { id: offer.id });
        const a = await m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId });
        await applyOfferConfirmation(m, auditService, notificationService, realtimeEventService, ctx, o, a, ctx.userId);
        await m.query(`SELECT pg_sleep(3)`); // still holding the offer row lock across the deadline
      });
      await adminDataSource.manager.query(`SELECT pg_sleep(2)`);
      const withdrawing = tenantContext.runInWorkspaceContext(ctx, (m) => withdrawUnconfirmedOffer(m, { auditService, notificationService, realtimeEventService }, fx.organisation.id, offer.id, 'worker_pointer'));
      const [, withdrawn] = await Promise.all([confirming, withdrawing]);
      expect(withdrawn).toBeNull();
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect((await reloadShift(fx, shift.id)).filledCount).toBe(1);
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(0);
    });

    it('R1b (T-R1): a withdrawal holding the row makes a concurrent confirm wait, then fail with the deadline 409; no seat', async () => {
      const fx = await seedFixture('dlRaceWithdrawFirst');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      await setDeadline(fx, offer, -1_000);
      const ctx = ctxOf(fx.managerA);
      const withdrawing = tenantContext.runInWorkspaceContext(ctx, async (m) => {
        const r = await withdrawUnconfirmedOffer(m, { auditService, notificationService, realtimeEventService }, fx.organisation.id, offer.id, 'worker_pointer');
        await m.query(`SELECT pg_sleep(2)`);
        return r;
      });
      await adminDataSource.manager.query(`SELECT pg_sleep(0.5)`);
      const confirming = offerService.managerConfirm(ctx, offer.id).then(() => 'confirmed', (e) => e);
      const [withdrawn, confirmOutcome] = await Promise.all([withdrawing, confirming]);
      expect(withdrawn).not.toBeNull();
      expectDeadline409(confirmOutcome);
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      expect((await reloadShift(fx, shift.id)).filledCount).toBe(0);
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(1);
    });

    it('R2 (T-R2): manager reject vs the withdrawal — exactly one terminal result, one audit, one staff notice', async () => {
      const fx = await seedFixture('dlRaceReject');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, offer, -1_000);
      await Promise.allSettled([offerService.managerReject(ctxOf(fx.managerA), offer.id, { reason: 'No' }), runDeadlineCycle()]);
      const final = await reload(fx, offer.id);
      expect(final.status).toBe(OfferStatus.MANAGER_REJECTED);
      const managerRejects = await asA(fx, `SELECT 1 FROM core.audit_log WHERE action = 'offer.rejected' AND entity_id = $1`, [offer.id]);
      const withdrawals = await withdrawalAudits(fx, offer.id);
      expect(managerRejects.length + withdrawals.length).toBe(1);
      expect(final.rejectedBy ? managerRejects.length : withdrawals.length).toBe(1);
      expect((await notificationsFor(fx, staff.userId, offer.id)).filter((n) => n.type === 'offer_rejected')).toHaveLength(1);
    });

    it('R3 (T-R3): shift cancellation vs the deadline — the cancellation follow-up closes it with the truthful reason; the withdrawal skips it', async () => {
      const fx = await seedFixture('dlRaceCancel');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      await schedulingService.cancel(ctxOf(fx.managerA), shift.id);
      await setDeadline(fx, offer, -60_000);
      await Promise.allSettled([runDeadlineCycle(), runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService)]);
      await runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService);
      const final = await reload(fx, offer.id);
      expect(final.status).toBe(OfferStatus.MANAGER_REJECTED);
      expect(final.rejectionReason).toBe('This shift was cancelled.');
      expect((await withdrawalAudits(fx, offer.id)).filter((a) => a.metadata.reason === 'confirmation_deadline_passed')).toHaveLength(0);
    });

    it('R4 (T-R4/T-N1): five Worker cycles + the backstop scan + a lazy confirm at once — one withdrawal, one audit, one notice per recipient, one completed worker_event', async () => {
      const fx = await seedFixture('dlRaceMany');
      const vm = await factory.createVenueManager(fx.organisation, { owner: fx.managerA, venueIds: [fx.venueId] });
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, offer, -1_000);
      await Promise.allSettled([
        ...Array.from({ length: 5 }, () => runManagerConfirmationDeadlineCycle(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService)),
        runConfirmationDeadlineBackstopScan(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService),
        offerService.managerConfirm(ctxOf(fx.managerA), offer.id),
      ]);
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(1);
      for (const userId of [staff.userId, fx.managerA.userId, vm.userId]) {
        const notes = (await notificationsFor(fx, userId, offer.id)).filter((n) => n.type === 'offer_rejected' || n.type === 'manager_confirmation_timeout');
        expect(notes).toHaveLength(1);
      }
      const events = await adminDataSource.manager.query(`SELECT status FROM core.worker_event WHERE entity_id = $1 AND event_type = 'manager_confirmation_deadline'`, [offer.id]);
      expect(events.filter((e: { status: string }) => e.status === 'completed').length).toBeLessThanOrEqual(1);
    });

    it('R5 (T-R6, after a Worker restart): a pointer due 2 h ago is processed with the ORIGINAL deadline; the manager was refused meanwhile', async () => {
      const fx = await seedFixture('dlLate');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      const deadline = await setDeadline(fx, offer, -2 * HOUR, 6 * HOUR);
      // A fresh Worker process: a brand-new cycle invocation with nothing in memory.
      await runManagerConfirmationDeadlineCycle(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService);
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      const [audit] = await withdrawalAudits(fx, offer.id);
      expect(audit!.metadata.deadlineAt).toBe(deadline.toISOString());
      expect(Number(audit!.metadata.processedLagMs)).toBeGreaterThanOrEqual(2 * HOUR - 60_000);
      expect(audit!.metadata.notified).toBe(true); // the assignment has not ended yet
    });
  });

  // ===================================================================
  // G. Go-live backlog (Q4) and the notification window (coordinator default)
  // ===================================================================
  describe('G. go-live backlog and notification window', () => {
    it('G1 (Q4): an accepted offer whose assignment ended long ago is withdrawn and audited on the first tick, silently', async () => {
      const fx = await seedFixture('dlBacklog');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      const now = await dbNow();
      await placeWindow(fx, offer, new Date(now.getTime() - 3 * 24 * HOUR), new Date(now.getTime() - 3 * 24 * HOUR + 6 * HOUR));
      await runDeadlineCycle();
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      const [audit] = await withdrawalAudits(fx, offer.id);
      expect(audit!.metadata.notified).toBe(false);
      expect((await notificationsFor(fx, staff.userId, offer.id)).filter((n) => n.type === 'offer_rejected')).toHaveLength(0);
      expect((await notificationsFor(fx, fx.managerA.userId, offer.id)).filter((n) => n.type === 'manager_confirmation_timeout')).toHaveLength(0);
    });

    it('G2 (coordinator default): a replacement withdrawn at its window end IS notified (deadline + 1 h grace)', async () => {
      const fx = await seedFixture('dlReplNotify');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await asA(fx, `UPDATE core.job_offer SET offer_kind = 'replacement' WHERE id = $1`, [offer.id]);
      const now = await dbNow();
      await placeWindow(fx, offer, new Date(now.getTime() - 3 * HOUR), new Date(now.getTime() - 2 * 60_000));
      await runDeadlineCycle();
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      const [audit] = await withdrawalAudits(fx, offer.id);
      expect(audit!.metadata).toMatchObject({ offerKind: 'replacement', notified: true });
      expect((await notificationsFor(fx, staff.userId, offer.id)).filter((n) => n.type === 'offer_rejected')).toHaveLength(1);
    });
  });

  // ===================================================================
  // A. No attendance / payroll penalty; no double booking
  // ===================================================================
  describe('A. no penalty, no double booking', () => {
    it('A1-A4: a withdrawn assignment past start + grace: no no-show, no late-clock-in, no reminder, clock-in refused, no attendance or payroll', async () => {
      const fx = await seedFixture('dlNoPenalty');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendAndAccept(fx, shift, staff);
      const now = await dbNow();
      await placeWindow(fx, offer, new Date(now.getTime() - HOUR), new Date(now.getTime() + 5 * HOUR)); // started 1 h ago
      await runDeadlineCycle();
      await expectWithdrawn(fx, offer.id, offer.shiftAssignmentId);
      await runShiftMonitorCycle(adminDataSource, tenantContext, notificationService, auditService, 15);
      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);
      expect((await reloadAssignment(fx, offer.shiftAssignmentId)).status).toBe(ShiftAssignmentStatus.REJECTED);
      const events = await adminDataSource.manager.query(`SELECT event_key FROM core.worker_event WHERE entity_id = $1`, [offer.shiftAssignmentId]);
      expect(events).toHaveLength(0);
      const reminders = await adminDataSource.manager.query(
        `SELECT type FROM core.notification WHERE organisation_id = $1 AND user_id = $2 AND type LIKE ANY (ARRAY['shift_reminder%', 'late_clock_in', 'shift_assignment_no_show', 'clock_in_window_open'])`,
        [fx.organisation.id, staff.userId],
      );
      expect(reminders).toHaveLength(0);
      await expect(attendanceService.checkIn(staffCtxOf(fx, staff), { shiftId: shift.id } as never)).rejects.toBeInstanceOf(ConflictException);
      const attendance = await asA(fx, `SELECT id FROM core.attendance WHERE shift_assignment_id = $1`, [offer.shiftAssignmentId]);
      expect(attendance).toHaveLength(0);
      const payroll = await asA(fx, `SELECT pr.id FROM core.payroll_record pr JOIN core.attendance a ON a.id = pr.attendance_id WHERE a.shift_assignment_id = $1`, [offer.shiftAssignmentId]);
      expect(payroll).toHaveLength(0);
    });

    it('DB1: a withdrawn overlapping offer never blocks a later confirm elsewhere; two overlapping confirms still trip the exclusion', async () => {
      const fx = await seedFixture('dlOverlap');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const withdrawnOffer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, withdrawnOffer, -60_000);
      await runDeadlineCycle();
      await expectWithdrawn(fx, withdrawnOffer.id, withdrawnOffer.shiftAssignmentId);
      // Two new shifts overlapping each other (and the withdrawn window's span).
      const shiftB = await seedOpenShift(fx, { startsInMs: 2 * HOUR });
      const shiftC = await seedOpenShift(fx, { startsInMs: 2 * HOUR + 30 * 60_000 });
      const offerB = await sendAndAccept(fx, shiftB, staff);
      const offerC = await offerService.send(ctxOf(fx.managerA), shiftC.id, { staffProfileId: staff.profileId! }).then(
        async (o) => offerService.staffAccept(staffCtxOf(fx, staff), o.id),
        () => null,
      );
      expect((await offerService.managerConfirm(ctxOf(fx.managerA), offerB.id)).status).toBe(OfferStatus.MANAGER_CONFIRMED);
      if (offerC) await expect(offerService.managerConfirm(ctxOf(fx.managerA), offerC.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ===================================================================
  // X. Tenancy
  // ===================================================================
  describe('X. tenancy', () => {
    it('X1 (T-X1): a forged pointer naming another organisation never touches the offer (RLS: the scoped read finds nothing)', async () => {
      const fx = await seedFixture('dlForgeA');
      const other = await seedFixture('dlForgeB');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, offer, -60_000);
      await adminDataSource.manager.query(`DELETE FROM core.worker_due_work WHERE subject_id = $1`, [offer.id]);
      await adminDataSource.manager.query(
        `INSERT INTO core.worker_due_work (organisation_id, workspace_id, job_type, subject_type, subject_id, due_at) VALUES ($1, $2, 'manager_confirmation_timeout', 'job_offer', $3, now() - interval '1 minute')`,
        [other.organisation.id, other.managerA.workspaceId, offer.id],
      );
      await runManagerConfirmationDeadlineCycle(adminDataSource, tenantContext, notificationService, auditService, realtimeEventService);
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.STAFF_ACCEPTED);
      expect(await withdrawalAudits(fx, offer.id)).toHaveLength(0);
      // The forged pointer was consumed as "nothing to do", not retried forever.
      expect(await adminDataSource.manager.query(`SELECT 1 FROM core.worker_due_work WHERE subject_id = $1`, [offer.id])).toHaveLength(0);
    });

    it('X4: with no tenant context bound, the withdrawal CAS matches zero rows', async () => {
      const fx = await seedFixture('dlNoCtx');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const offer = await sendAndAccept(fx, await seedOpenShift(fx), staff);
      await setDeadline(fx, offer, -60_000);
      const result = await dataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('search_path', 'core', true)`);
        await m.query(`SELECT set_config('rab.organisation_id', '', true)`);
        await m.query(`SELECT set_config('rab.workspace_id', '', true)`);
        await m.query(`SELECT set_config('rab.user_id', '', true)`);
        const [{ n }] = await m.query(`SELECT count(*)::int AS n FROM job_offer`);
        const withdrawn = await withdrawUnconfirmedOffer(m, { auditService, notificationService, realtimeEventService }, fx.organisation.id, offer.id, 'worker_pointer');
        return { n, withdrawn };
      });
      expect(result.n).toBe(0);
      expect(result.withdrawn).toBeNull();
      expect((await reload(fx, offer.id)).status).toBe(OfferStatus.STAFF_ACCEPTED);
    });
  });

  // ===================================================================
  // P. Projections (§7)
  // ===================================================================
  describe('P. projections', () => {
    it('P1/P3: OfferSummary before, past (projection only) and after the withdrawal; canConfirm / canAccept', async () => {
      const fx = await seedFixture('dlProj');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const pending = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      let mine = (await offerService.listMine(staffCtxOf(fx, staff))).find((o) => o.id === pending.id)!;
      expect(mine.canAccept).toBe(true);
      expect(mine.presentation.canAccept).toBe(true);
      expect(mine).not.toHaveProperty('canConfirm');
      await offerService.staffAccept(staffCtxOf(fx, staff), pending.id);
      const deadline = await setDeadline(fx, pending, 10 * 60_000);

      const before = (await offerService.list(ctxOf(fx.managerA), { status: 'staff_accepted' } as never)).data.find((o) => o.id === pending.id)!;
      expect(new Date(before.approvalDeadlineAt).getTime()).toBe(deadline.getTime());
      expect(before).toMatchObject({ awaitingManagerConfirmation: true, canConfirm: true, closedReason: null });
      const asB = await offerService.list(ctxOf(fx.managerB), {} as never);
      expect(asB.data.find((o) => o.id === pending.id)).toBeUndefined();

      await setDeadline(fx, pending, -60_000); // past the deadline, Worker not run yet
      const past = (await offerService.list(ctxOf(fx.managerA), {} as never)).data.find((o) => o.id === pending.id)!;
      expect(past).toMatchObject({ status: 'staff_accepted', awaitingManagerConfirmation: false, canConfirm: false, closedReason: 'confirmation_deadline_passed' });
      mine = (await offerService.listMine(staffCtxOf(fx, staff))).find((o) => o.id === pending.id)!;
      expect(mine.presentation).toMatchObject({ state: 'rejected', closedReason: 'confirmation_deadline_passed', canAccept: false });

      await runDeadlineCycle();
      const after = (await offerService.list(ctxOf(fx.managerA), {} as never)).data.find((o) => o.id === pending.id)!;
      expect(after).toMatchObject({ status: 'manager_rejected', awaitingManagerConfirmation: false, canConfirm: false, closedReason: 'confirmation_deadline_passed' });
      mine = (await offerService.listMine(staffCtxOf(fx, staff))).find((o) => o.id === pending.id)!;
      expect(mine).toMatchObject({ closedReason: 'confirmation_deadline_passed', canAccept: false });
      expect(mine.presentation.state).toBe('rejected');
    });

    it('P2: venue-offer pipeline: terminalSource, summary.withdrawnAtDeadline, tableStatus', async () => {
      const fx = await seedFixture('dlPipe');
      const vm = await factory.createVenueManager(fx.organisation, { owner: fx.managerA, venueIds: [fx.venueId] });
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx, { requestedBy: vm.userId });
      const offer = await sendAndAccept(fx, shift, staff);
      await setDeadline(fx, offer, -60_000);
      await runDeadlineCycle();
      const pipe = await pipelineService.get(ctxOf(fx.managerA), shift.id);
      const row = pipe.staff.find((r: { offerId: string }) => r.offerId === offer.id)!;
      expect(row).toMatchObject({ stage: 'rejected', closedReason: 'confirmation_deadline_passed', awaitingManagerConfirmation: false, terminalSource: 'Not confirmed before the approval deadline' });
      expect(pipe.summary.withdrawnAtDeadline).toBe(1);
      expect(pipe.tableStatus).toBe('1 not confirmed in time');
    });
  });

  // ===================================================================
  // Z1. Nothing in this suite was ever confirmed by the system
  // ===================================================================
  it('Z1 (T-Z1): zero manager_confirmed offers without a human confirmed_by in every organisation this suite created', async () => {
    for (const organisationId of organisations) {
      const [{ n }] = await adminDataSource.manager.query(
        `SELECT count(*)::int AS n FROM core.job_offer WHERE organisation_id = $1 AND status = 'manager_confirmed' AND (confirmed_by IS NULL) AND manager_confirmed_at >= $2`,
        [organisationId, suiteStart],
      );
      expect(n).toBe(0);
    }
  });
});
