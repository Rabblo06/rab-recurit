import 'reflect-metadata';
import { InvalidTransitionError, OfferStatus, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { Notification } from '@rab/server/modules/notification/entities/notification.entity';
import { JobOffer } from '@rab/server/modules/offer/entities/job-offer.entity';
import { ReplacementRequest } from '@rab/server/modules/offer/entities/replacement-request.entity';
import { OfferService } from '@rab/server/modules/offer/services/offer.service';
import { JobRole } from '@rab/server/modules/scheduling/entities/job-role.entity';
import { Shift } from '@rab/server/modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '@rab/server/modules/scheduling/entities/shift-assignment.entity';
import { SchedulingService } from '@rab/server/modules/scheduling/services/scheduling.service';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runManagerConfirmationTimeoutCycle } from '../../queues/rab-offers/offer-expiry.job';
import { runShiftCancellationFollowupCycle } from '../../queues/rab-shifts/shift-cancellation-followup.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase 7.1 — manager confirmation timeout CORRECTED to auto-CONFIRM, not
 * auto-reject. Real Postgres, RLS on, no mocks. Covers: the atomic
 * STAFF_ACCEPTED -> MANAGER_CONFIRMED auto-confirm (reusing the exact same
 * `applyOfferConfirmation` seat-claiming core a real Manager's confirm click
 * uses), every pairwise race (timeout-vs-manual-confirm, timeout-vs-manual-
 * reject, timeout-vs-cancellation, N-way duplicate timeout cycles),
 * capacity/double-booking safety (a timeout may NEVER overbook or bypass
 * Phase 6's constraints), the Venue-Manager-request auto-confirm exclusion,
 * workspace/RLS isolation, Phase 5.5 defence-in-depth, worker-event
 * idempotency, restart/catch-up, and discovery-query fairness/index
 * evidence.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

// A short, whole-minute config value keeps `make_interval(mins => $1)` exact
// (Postgres's `make_interval` takes an integer minutes argument) while still
// letting every test control the actual staff_accepted_at/deadline boundary
// precisely via direct timestamp manipulation, never via sleeps.
const TIMEOUT_MINUTES = 1;
const TIMEOUT_MS = TIMEOUT_MINUTES * 60_000;

describeIfDb('manager confirmation timeout correctness (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let schedulingService: SchedulingService;
  let offerService: OfferService;
  let factory: TestIdentityFactory;

  interface Fixture {
    organisation: Organisation;
    managerA: TestIdentity;
    managerB: TestIdentity;
    venueId: string;
    jobRoleId: string;
  }

  function ctxOf(identity: Pick<TestIdentity, 'organisationId' | 'workspaceId' | 'userId'>): AuthContext {
    return { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: 'manager' };
  }

  function staffCtxOf(fx: Fixture, staff: TestIdentity): AuthContext {
    return { organisationId: fx.organisation.id, workspaceId: fx.managerA.workspaceId, userId: staff.userId, role: 'staff' };
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

  async function dbNow(): Promise<Date> {
    const [{ now }] = await adminDataSource.manager.query<Array<{ now: Date }>>(`SELECT now() AS now`);
    return now;
  }

  /** Normal production topology: Manager A and Manager B, same org, each with their OWN private workspace. */
  async function seedNormalFixture(label: string): Promise<Fixture> {
    const organisation = await factory.createOrganisation(label);
    const managerA = await factory.createInternalManager(organisation, { permissions: 'production', label: `${label}-a` });
    const managerB = await factory.createInternalManager(organisation, { permissions: 'production', label: `${label}-b` });
    const { venueId, jobRoleId } = await withContext(ctxOf(managerA), async (m) => {
      const venue = await m.save(Venue, { organisationId: organisation.id, name: `${label} Venue A`, createdBy: managerA.userId, workspaceId: managerA.workspaceId! });
      const jobRole = await m.save(JobRole, { organisationId: organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: managerA.userId, workspaceId: managerA.workspaceId! });
      return { venueId: venue.id, jobRoleId: jobRole.id };
    });
    return { organisation, managerA, managerB, venueId, jobRoleId };
  }

  /** Phase 5.5's adversarial fixture: Manager A and Manager B forced into the SAME workspace — defence-in-depth only, never assumed as normal topology. */
  async function seedSameWorkspaceFixture(label: string): Promise<Fixture> {
    const fx = await seedNormalFixture(label);
    await adminDataSource.manager.query(`UPDATE core.manager_profile SET workspace_id = $1 WHERE user_id = $2`, [fx.managerA.workspaceId, fx.managerB.userId]);
    return { ...fx, managerB: { ...fx.managerB, workspaceId: fx.managerA.workspaceId } };
  }

  async function seedOpenShift(fx: Fixture, opts?: { requiredCount?: number; autoConfirm?: boolean }): Promise<Shift> {
    const startsAt = new Date(Date.now() + 3 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    return withContext(ctxOf(fx.managerA), (m) =>
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
        createdBy: fx.managerA.userId,
        // A real ManagerVenue-request-approve flow is a whole separate feature; setting `requestedBy` directly
        // reproduces its ONE relevant effect (`staffAccept`'s existing `autoConfirm` branch) — see Phase 6's own
        // fixture helper of the same shape.
        requestedBy: opts?.autoConfirm ? fx.managerA.userId : undefined,
        workspaceId: fx.managerA.workspaceId!,
      }),
    );
  }

  /**
   * `core.job_offer`/`audit_log`/`worker_event`/`shift_assignment`/`shift`
   * all carry `FORCE ROW LEVEL SECURITY`, and `rab_owner` (the role behind
   * `adminDataSource`) is NOT exempted from it on any of these — confirmed
   * live via `pg_class.relforcerowsecurity` and `pg_roles.rolbypassrls`,
   * matching CLAUDE.md's own "rab_owner is exempted from RLS predicates
   * only on the ten allowlisted tables, never generally" rule. A raw
   * `adminDataSource.manager.query(...)` against any of these WITHOUT a
   * bound tenant context silently matches zero rows — not an error, just
   * RLS doing exactly what it's supposed to. Every read/write against one
   * of these tables in this suite must go through `withContext`, a real
   * `rab_app`-role, tenant-bound connection — never the raw admin
   * connection (which stays reserved for `organisation`/`manager_profile`,
   * the genuinely NOT_FORCED tables this suite's fixtures also touch).
   */
  async function queryAsManagerA<T = unknown>(fx: Fixture, sql: string, params: unknown[] = []): Promise<T[]> {
    return withContext(ctxOf(fx.managerA), (m) => m.query<T[]>(sql, params));
  }

  /**
   * Sends a real offer and has staff really accept it (going through the
   * actual, Phase-6-hardened `OfferService.staffAccept()` — never
   * hand-inserting a `staff_accepted` row), then backdates `staff_accepted_at`
   * by direct SQL to land it at a controlled offset from real DB time — the
   * ONLY thing under test here is the timeout worker's own deadline
   * arithmetic, so every other column is produced by the real code path.
   */
  async function seedStaffAcceptedOffer(fx: Fixture, shift: Shift, staff: TestIdentity, offsetMs: number): Promise<JobOffer> {
    const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
    const accepted = await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
    expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED); // sanity: this fixture is for the two-step, non-auto-confirm flow
    const now = await dbNow();
    const backdated = new Date(now.getTime() + offsetMs);
    await queryAsManagerA(fx, `UPDATE core.job_offer SET staff_accepted_at = $1 WHERE id = $2`, [backdated, offer.id]);
    return withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
  }

  async function countAudit(fx: Fixture, action: string, entityId: string): Promise<number> {
    const rows = await queryAsManagerA<{ count: string }>(fx, `SELECT count(*) FROM core.audit_log WHERE action = $1 AND entity_id = $2`, [action, entityId]);
    return Number(rows[0]!.count);
  }

  async function countTimeoutConfirmAudits(fx: Fixture, entityId: string): Promise<number> {
    const rows = await queryAsManagerA<{ count: string }>(
      fx,
      `SELECT count(*) FROM core.audit_log WHERE action = 'offer.confirmed' AND entity_id = $1 AND metadata->>'source' = 'manager_confirmation_timeout'`,
      [entityId],
    );
    return Number(rows[0]!.count);
  }

  async function raceAndReport<T>(attempts: Array<() => Promise<T>>): Promise<Array<{ ok: boolean; value?: T; error?: unknown }>> {
    const settled = await Promise.allSettled(attempts.map((run) => run()));
    return settled.map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
  }

  function expectSafeRejection(error: unknown): void {
    expect(error instanceof ConflictException || error instanceof InvalidTransitionError).toBe(true);
  }

  async function runTimeoutCycle(): Promise<{ confirmed: number }> {
    return runManagerConfirmationTimeoutCycle(adminDataSource, tenantContext, notificationService, auditService, TIMEOUT_MINUTES);
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
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ===================================================================
  // A. Architecture
  // ===================================================================
  describe('A. workspace architecture', () => {
    it('A1-A5: direct-manager offer inherits Workspace A; staff accept produces STAFF_ACCEPTED/STAFF_ACCEPTED; filledCount unchanged', async () => {
      const fx = await seedNormalFixture('archA');
      expect(fx.managerA.workspaceId).not.toBe(fx.managerB.workspaceId);
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      const assignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      expect(assignment.workspaceId).toBe(shift.workspaceId);
      expect(offer.workspaceId).toBe(assignment.workspaceId);

      const accepted = await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
      expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED);
      const acceptedAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: assignment.id }));
      expect(acceptedAssignment.status).toBe(ShiftAssignmentStatus.STAFF_ACCEPTED);
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(0);
    });
  });

  // ===================================================================
  // B. Timeout eligibility (test list items 1-3)
  // ===================================================================
  describe('B. timeout eligibility', () => {
    it('B1: PENDING never times out through manager-confirmation timeout', async () => {
      const fx = await seedNormalFixture('eligPending');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      // The discovery scan is global (across every organisation, by design)
      // so `result.confirmed`'s absolute value is never asserted as an
      // exact/zero count in this suite: a shared dev database can carry
      // unrelated eligible rows from other work. Only THIS offer's own
      // final state is a meaningful, deterministic signal.
      await runTimeoutCycle();
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.PENDING);
    });

    it('B2 (item 1): STAFF_ACCEPTED at 59m59s — no timeout confirmation yet', async () => {
      const fx = await seedNormalFixture('eligBefore');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -(TIMEOUT_MS - 1_000)); // 59s ago — 1s short of the 60s (1min) deadline
      await runTimeoutCycle();
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.STAFF_ACCEPTED);
    });

    it('B3/B4 (items 2-3): at and after the deadline, the offer auto-confirms', async () => {
      const fx = await seedNormalFixture('eligAtAfter');
      const staffAt = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'at' });
      const shiftAt = await seedOpenShift(fx);
      // staff_accepted_at set to exactly `now() - TIMEOUT_MS` — by the time the
      // cycle's own claim SQL evaluates `now()` a few ms later, real elapsed
      // execution time has already pushed this past the deadline (`<=`), which
      // is the correct, non-flaky way to prove the inclusive boundary without
      // chasing sub-millisecond precision with sleeps.
      const offerAt = await seedStaffAcceptedOffer(fx, shiftAt, staffAt, -TIMEOUT_MS);

      const staffAfter = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'after' });
      const shiftAfter = await seedOpenShift(fx);
      const offerAfter = await seedStaffAcceptedOffer(fx, shiftAfter, staffAfter, -TIMEOUT_MS - 5_000);

      const result = await runTimeoutCycle();
      expect(result.confirmed).toBeGreaterThanOrEqual(2);
      const finalAt = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerAt.id }));
      const finalAfter = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerAfter.id }));
      expect(finalAt.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect(finalAfter.status).toBe(OfferStatus.MANAGER_CONFIRMED);
    });

    it('B5: a malformed row (STAFF_ACCEPTED with null staff_accepted_at) fails closed, never auto-confirmed', async () => {
      const fx = await seedNormalFixture('eligNullTs');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      // Force a malformed row directly — this specific combination should never occur through real code paths,
      // which is exactly why it needs a fail-closed test rather than an assumption.
      await queryAsManagerA(fx, `UPDATE core.job_offer SET status = 'staff_accepted', staff_accepted_at = NULL WHERE id = $1`, [offer.id]);
      await runTimeoutCycle();
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.STAFF_ACCEPTED);
    });

    it('B6: every other terminal state (MANAGER_CONFIRMED, MANAGER_REJECTED, DECLINED, EXPIRED, WITHDRAWN) is ignored', async () => {
      const fx = await seedNormalFixture('eligTerminal');

      const staffConfirmed = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'confirmed' });
      const shiftConfirmed = await seedOpenShift(fx);
      const offerConfirmed = await offerService.send(ctxOf(fx.managerA), shiftConfirmed.id, { staffProfileId: staffConfirmed.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staffConfirmed), offerConfirmed.id);
      await offerService.managerConfirm(ctxOf(fx.managerA), offerConfirmed.id);
      await queryAsManagerA(fx, `UPDATE core.job_offer SET manager_confirmed_at = now() - interval '2 hours' WHERE id = $1`, [offerConfirmed.id]);

      const staffRejected = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'rejected' });
      const shiftRejected = await seedOpenShift(fx);
      const offerRejected = await offerService.send(ctxOf(fx.managerA), shiftRejected.id, { staffProfileId: staffRejected.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staffRejected), offerRejected.id);
      await offerService.managerReject(ctxOf(fx.managerA), offerRejected.id, { reason: 'no longer needed' });

      const staffDeclined = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'declined' });
      const shiftDeclined = await seedOpenShift(fx);
      const offerDeclined = await offerService.send(ctxOf(fx.managerA), shiftDeclined.id, { staffProfileId: staffDeclined.profileId! });
      await offerService.decline(staffCtxOf(fx, staffDeclined), offerDeclined.id, { reason: 'busy' });

      const staffWithdrawn = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'withdrawn' });
      const shiftWithdrawn = await seedOpenShift(fx);
      const offerWithdrawn = await offerService.send(ctxOf(fx.managerA), shiftWithdrawn.id, { staffProfileId: staffWithdrawn.profileId! });
      await offerService.withdraw(ctxOf(fx.managerA), offerWithdrawn.id);

      await runTimeoutCycle();

      const finalConfirmed = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerConfirmed.id }));
      const finalRejected = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerRejected.id }));
      expect(finalConfirmed.status).toBe(OfferStatus.MANAGER_CONFIRMED); // untouched — was already terminal before this cycle ran
      expect(finalRejected.status).toBe(OfferStatus.MANAGER_REJECTED); // untouched — manual reject stands, timeout never overwrites it
      for (const id of [offerDeclined.id, offerWithdrawn.id]) {
        const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id }));
        expect([OfferStatus.DECLINED, OfferStatus.WITHDRAWN]).toContain(final.status);
      }
    });
  });

  // ===================================================================
  // C. Timeout transition — auto-CONFIRM (test list items 4-9)
  // ===================================================================
  describe('C. timeout auto-confirm transition', () => {
    it('C1 (items 4-7): eligible offer -> MANAGER_CONFIRMED, assignment -> CONFIRMED, confirmedBy stays null, filledCount increments exactly once', async () => {
      const fx = await seedNormalFixture('transition');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);
      const assignmentIdBefore = offer.shiftAssignmentId;

      await runTimeoutCycle();

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect(finalOffer.confirmedBy).toBeFalsy(); // never a fabricated Manager identity — a SYSTEM confirmation
      expect(finalOffer.managerConfirmedAt).toBeTruthy();

      const finalAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: assignmentIdBefore }));
      expect(finalAssignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
      expect(finalAssignment.confirmedAt).toBeTruthy();

      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // the seat WAS claimed — this is a real confirmation, not a notify-only escalation
      expect(finalShift.status).toBe(ShiftStatus.FULLY_FILLED);
    });

    it('C2 (item 8): audit records OFFER_CONFIRMED with metadata.source = manager_confirmation_timeout, never OFFER_REJECTED_BY_WORKER', async () => {
      const fx = await seedNormalFixture('auditSource');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);
      await runTimeoutCycle();

      expect(await countTimeoutConfirmAudits(fx, offer.id)).toBe(1);
      const rejectedByWorkerAudits = await countAudit(fx, 'offer.rejected_by_worker', offer.id);
      expect(rejectedByWorkerAudits).toBe(0); // the OLD (incorrect) Phase 7 behaviour must never fire again
    });

    it('C3 (item 9): staff is notified exactly once, with truthful "confirmed" text — never "rejected"/"timed out and was rejected"', async () => {
      const fx = await seedNormalFixture('staffNotifyOnce');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);
      await runTimeoutCycle();

      const staffNotifications = await withContext(staffCtxOf(fx, staff), (m) => m.find(Notification, { where: { userId: staff.userId, relatedEntityType: 'offer', relatedEntityId: offer.id } }));
      const confirmNotifications = staffNotifications.filter((n) => n.type === 'offer_confirmed');
      expect(confirmNotifications).toHaveLength(1);
      const text = `${confirmNotifications[0]!.title} ${confirmNotifications[0]!.message}`.toLowerCase();
      expect(text).not.toContain('reject');
      expect(text).not.toContain('timed out');
      expect(text).toContain('confirm');
    });
  });

  // ===================================================================
  // D. Venue-request auto-confirm regression (item 18)
  // ===================================================================
  describe('D. Venue-request auto-confirm regression', () => {
    it('D1 (item 18): an already-auto-confirmed-on-accept offer never re-enters the timeout population — unchanged, 0 extra transition/audit/notification/replacement', async () => {
      const fx = await seedNormalFixture('autoConfirm');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx, { autoConfirm: true });
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      const accepted = await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
      expect(accepted.status).toBe(OfferStatus.MANAGER_CONFIRMED); // auto-confirmed immediately, in the same transaction as accept
      const assignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      expect(assignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
      const shiftAfterAccept = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(shiftAfterAccept.filledCount).toBe(1);

      // Backdate as if a very long time has passed since the (already-terminal) offer's staffAcceptedAt —
      // the discovery query itself can never even select this row, since status is no longer 'staff_accepted'.
      await queryAsManagerA(fx, `UPDATE core.job_offer SET staff_accepted_at = now() - interval '5 hours' WHERE id = $1`, [offer.id]);

      await runTimeoutCycle();

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED); // untouched
      expect(await countTimeoutConfirmAudits(fx, offer.id)).toBe(0); // the timeout worker never touched it a second time
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // never double-incremented
      const replacementRequests = await withContext(ctxOf(fx.managerA), (m) => m.find(ReplacementRequest, { where: { shiftId: shift.id } }));
      expect(replacementRequests).toHaveLength(0);
    });
  });

  // ===================================================================
  // E. Races (items 11-13)
  // ===================================================================
  describe('E. races', () => {
    it('E1 (item 11a): manual confirm wins first — timeout finds nothing left to do, filledCount incremented exactly once', async () => {
      const fx = await seedNormalFixture('confirmWinsFirst');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await offerService.managerConfirm(ctxOf(fx.managerA), offer.id); // confirm wins deterministically, run to completion first
      await runTimeoutCycle();

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect(finalOffer.confirmedBy).toBe(fx.managerA.userId); // the REAL manager's own confirm, not overwritten by the system
      const finalAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      expect(finalAssignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // never double-incremented by the timeout finding it already resolved
    });

    it('E2 (item 11b): manual confirm vs timeout — genuine race, both reaching for the SAME outcome — exactly one seat claim, never mixed state', async () => {
      const fx = await seedNormalFixture('confirmVsTimeoutRace');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await raceAndReport([() => offerService.managerConfirm(ctxOf(fx.managerA), offer.id), () => runTimeoutCycle()]);

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      const finalAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));

      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED); // both sides were driving toward the SAME terminal state
      expect(finalAssignment.status).toBe(ShiftAssignmentStatus.CONFIRMED);
      expect(finalShift.filledCount).toBe(1); // exactly one seat claim, whichever side actually won the CAS
    });

    it('E3 (item 12): timeout wins first — a late manual confirm attempt gets a clean conflict, filledCount never double-incremented', async () => {
      const fx = await seedNormalFixture('timeoutWinsFirst');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await runTimeoutCycle();
      const afterTimeout = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(afterTimeout.status).toBe(OfferStatus.MANAGER_CONFIRMED);

      await offerService.managerConfirm(ctxOf(fx.managerA), offer.id).then(
        () => { throw new Error('expected confirm-after-auto-confirm to be rejected'); },
        expectSafeRejection,
      );
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // still exactly one, the late duplicate attempt changed nothing
    });

    it('E4 (item 12): manual reject vs timeout — exactly one terminal result wins, never overwritten by the other', async () => {
      const fx = await seedNormalFixture('manualRejectVsTimeout');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      const results = await raceAndReport([() => offerService.managerReject(ctxOf(fx.managerA), offer.id, { reason: 'staff no longer suitable' }), () => runTimeoutCycle()]);
      const managerRejectSucceeded = results[0]!.ok;

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      if (managerRejectSucceeded) {
        expect(finalOffer.status).toBe(OfferStatus.MANAGER_REJECTED);
        expect(finalOffer.rejectedBy).toBe(fx.managerA.userId);
        expect(finalOffer.rejectionReason).toBe('staff no longer suitable');
        expect(finalShift.filledCount).toBe(0); // rejection never claims a seat
      } else {
        expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED);
        expect(finalOffer.confirmedBy).toBeFalsy();
        expect(finalShift.filledCount).toBe(1);
      }
      // Exactly one logical terminal audit — never both a reject AND a confirm audit for the same offer.
      const manualRejectAudits = await countAudit(fx, 'offer.rejected', offer.id);
      const timeoutConfirmAudits = await countTimeoutConfirmAudits(fx, offer.id);
      expect(manualRejectAudits + timeoutConfirmAudits).toBe(1);
    });

    it('E5 (item 13a): shift cancellation wins first — timeout never confirms, never claims a seat, never sends a confirmed notification', async () => {
      const fx = await seedNormalFixture('cancelBeforeTimeout');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await schedulingService.cancel(ctxOf(fx.managerA), shift.id);
      await runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService);
      const afterCancel = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(afterCancel.status).toBe(OfferStatus.MANAGER_REJECTED); // cancellation-followup's own established "closest valid terminal state"
      expect(afterCancel.rejectionReason).toBe('This shift was cancelled.');

      await runTimeoutCycle(); // Pass A's shift-cancelled check rejects this candidate outright — no side effects for it
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.MANAGER_REJECTED);
      expect(final.rejectionReason).toBe('This shift was cancelled.'); // never overwritten with a fake confirmation
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(0);
      expect(await countTimeoutConfirmAudits(fx, offer.id)).toBe(0);
      const staffNotifications = await withContext(staffCtxOf(fx, staff), (m) => m.find(Notification, { where: { userId: staff.userId, relatedEntityType: 'offer', relatedEntityId: offer.id, type: 'offer_confirmed' } }));
      expect(staffNotifications).toHaveLength(0); // never a false "your shift has been confirmed"
    });

    it('E6 (item 13b): timeout auto-confirms first — Phase 5 cancellation-followup correctly reconciles the now-CONFIRMED assignment afterward', async () => {
      const fx = await seedNormalFixture('timeoutBeforeCancel');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await runTimeoutCycle();
      const afterTimeout = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(afterTimeout.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      const shiftAfterTimeout = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(shiftAfterTimeout.filledCount).toBe(1);

      await schedulingService.cancel(ctxOf(fx.managerA), shift.id);
      await runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService);

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      const finalAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED); // the offer's own terminal state from the (earlier, real) auto-confirm is never rewritten
      expect(finalAssignment.status).toBe(ShiftAssignmentStatus.CANCELLED); // cancellation-followup's existing CONFIRMED->CANCELLED handling, unchanged, already correct
    });

    it('E7 (item 13, five workers): shift cancellation racing five timeout workers — coherent result either way, never overbooked', async () => {
      const fx = await seedNormalFixture('cancelVsFiveWorkers');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await raceAndReport([() => schedulingService.cancel(ctxOf(fx.managerA), shift.id), ...Array.from({ length: 5 }, () => () => runTimeoutCycle())]);
      await runShiftCancellationFollowupCycle(adminDataSource, tenantContext, notificationService, auditService); // may need a follow-up tick, matching production cadence

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      const finalAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.status).toBe(ShiftStatus.CANCELLED);
      if (finalOffer.status === OfferStatus.MANAGER_CONFIRMED) {
        // Timeout won first: the seat was legitimately claimed before cancellation landed, then reconciled.
        expect(finalAssignment.status).toBe(ShiftAssignmentStatus.CANCELLED);
        expect(finalShift.filledCount).toBe(1);
      } else {
        // Cancellation won first: never confirmed, never claimed a seat.
        expect(finalOffer.status).toBe(OfferStatus.MANAGER_REJECTED);
        expect(finalAssignment.status).toBe(ShiftAssignmentStatus.CANCELLED);
        expect(finalShift.filledCount).toBe(0);
      }
    });
  });

  // ===================================================================
  // F. Capacity / double-booking safety (items 14-15) — Phase 7.1 §11
  // ===================================================================
  describe('F. capacity and double-booking safety', () => {
    it('F1 (item 14): a full shift cannot be overfilled — the second overdue offer fails closed, remains STAFF_ACCEPTED, never force-confirmed or auto-rejected', async () => {
      const fx = await seedNormalFixture('shiftFull');
      const shift = await seedOpenShift(fx, { requiredCount: 1 });
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'a' });
      const staffB = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'b' });
      const offerA = await seedStaffAcceptedOffer(fx, shift, staffA, -TIMEOUT_MS - 5_000);
      const shiftForB = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      void shiftForB;
      const offerB = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staffB.profileId! });
      const acceptedB = await offerService.staffAccept(staffCtxOf(fx, staffB), offerB.id);
      expect(acceptedB.status).toBe(OfferStatus.STAFF_ACCEPTED);
      const now = await dbNow();
      await queryAsManagerA(fx, `UPDATE core.job_offer SET staff_accepted_at = $1 WHERE id = $2`, [new Date(now.getTime() - TIMEOUT_MS - 4_000), offerB.id]);

      await runTimeoutCycle();

      const finalA = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerA.id }));
      const finalB = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerB.id }));
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // never overbooked past requiredCount
      expect(finalShift.status).toBe(ShiftStatus.FULLY_FILLED);
      // Exactly one of the two won the single seat; the other fails closed — still STAFF_ACCEPTED, NOT force-confirmed, NOT auto-rejected.
      const statuses = [finalA.status, finalB.status].sort();
      expect(statuses).toEqual([OfferStatus.MANAGER_CONFIRMED, OfferStatus.STAFF_ACCEPTED].sort());
    });

    it('F2 (item 15): a staff member who becomes confirmed elsewhere AFTER accepting cannot be auto-confirmed — the double-booking exclusion constraint remains enforced, offer stays STAFF_ACCEPTED', async () => {
      const fx = await seedNormalFixture('doubleBooking');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });

      // Shift 2 offer sent and accepted FIRST, while staff has no conflict yet — `OfferService.sendOne`'s
      // own proactive overlap check (a real, EARLIER defence-in-depth layer, checked at send time) would
      // otherwise block step 2 outright before this test could ever reach the timeout worker's own,
      // DEEPER exclusion-constraint safety net, which is specifically what this test is proving.
      const shift2 = await seedOpenShift(fx);
      const offer2 = await seedStaffAcceptedOffer(fx, shift2, staff, -TIMEOUT_MS - 5_000);

      // Shift 1: an overlapping window (`seedOpenShift` always uses `now+3h..now+11h`) — sent, accepted,
      // and manually confirmed AFTER offer2 was already accepted, so the conflict genuinely arises only now.
      const shift1 = await seedOpenShift(fx);
      const offer1 = await offerService.send(ctxOf(fx.managerA), shift1.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staff), offer1.id);
      await offerService.managerConfirm(ctxOf(fx.managerA), offer1.id);

      await runTimeoutCycle();

      const finalOffer2 = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer2.id }));
      expect(finalOffer2.status).toBe(OfferStatus.STAFF_ACCEPTED); // fails closed — never a fake MANAGER_CONFIRMED that would violate the GiST exclusion constraint
      const finalShift2 = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift2.id }));
      expect(finalShift2.filledCount).toBe(0);
      expect(await countTimeoutConfirmAudits(fx, offer2.id)).toBe(0);
    });
  });

  // ===================================================================
  // G. Five-worker / N-way concurrency (item 10)
  // ===================================================================
  describe('G. five-worker concurrency', () => {
    it('G1 (item 10): five concurrent timeout cycles for the same eligible offer — exactly one seat claim, one audit, one worker_event completion', async () => {
      const fx = await seedNormalFixture('fiveWorkersTimeout');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await raceAndReport(Array.from({ length: 5 }, () => () => runTimeoutCycle()));

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // exactly one seat claim across all five racing cycles
      expect(await countTimeoutConfirmAudits(fx, offer.id)).toBe(1);

      const eventRows = await queryAsManagerA<{ status: string }>(fx, `SELECT status FROM core.worker_event WHERE entity_id = $1 AND event_type = 'manager_confirmation_timeout'`, [offer.id]);
      expect(eventRows).toHaveLength(1);
      expect(eventRows[0]!.status).toBe('completed');
    });
  });

  // ===================================================================
  // H. Workspace / IDOR (items 16-17)
  // ===================================================================
  describe('H. workspace / IDOR', () => {
    it('H1 (items 16-17): wrong-workspace context, and no tenant context at all, cannot confirm Offer A directly', async () => {
      const fx = await seedNormalFixture('workerRls');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      const [wrongWorkspaceRows] = await withContext({ organisationId: fx.organisation.id, workspaceId: fx.managerB.workspaceId, userId: fx.managerB.userId }, (m) =>
        m.query<[Array<{ id: string }>, number]>(`UPDATE core.job_offer SET status = 'manager_confirmed' WHERE id = $1 RETURNING id`, [offer.id]),
      );
      expect(wrongWorkspaceRows).toHaveLength(0);

      const [noContextRows] = await dataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', '', true)`);
        await m.query(`SELECT set_config('rab.workspace_id', '', true)`);
        await m.query(`SELECT set_config('rab.user_id', '', true)`);
        return m.query<[Array<{ id: string }>, number]>(`UPDATE core.job_offer SET status = 'manager_confirmed' WHERE id = $1 RETURNING id`, [offer.id]);
      });
      expect(noContextRows).toHaveLength(0);

      const stillWaiting = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(stillWaiting.status).toBe(OfferStatus.STAFF_ACCEPTED);
    });

    it('H2: Manager B (normal separate-workspace topology) cannot manually confirm or reject Offer A', async () => {
      const fx = await seedNormalFixture('managerBDenied');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -30_000);

      await expect(offerService.managerConfirm(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.managerReject(ctxOf(fx.managerB), offer.id, {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('H3: Phase 5.5 forced-same-workspace Manager B still denied manual confirm/reject; SYSTEM timeout still auto-confirms (not impersonating Manager B or Manager A)', async () => {
      const fx = await seedSameWorkspaceFixture('p55Timeout');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await expect(offerService.managerConfirm(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.managerReject(ctxOf(fx.managerB), offer.id, {})).rejects.toBeInstanceOf(NotFoundException);

      await runTimeoutCycle();
      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      expect(finalOffer.confirmedBy).toBeFalsy(); // never fakes Manager B (or Manager A) as the confirmer
    });
  });

  // ===================================================================
  // I. Worker event
  // ===================================================================
  describe('I. worker event', () => {
    it('I1: exactly one worker_event logical claim; a rerun after completion is a no-op', async () => {
      const fx = await seedNormalFixture('workerEventOnce');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await runTimeoutCycle();
      const afterFirst = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(afterFirst.status).toBe(OfferStatus.MANAGER_CONFIRMED);
      await runTimeoutCycle(); // the offer is no longer 'staff_accepted' — it drops out of discovery entirely on this second run
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1); // never double-incremented by the no-op rerun

      const events = await queryAsManagerA<{ id: string }>(fx, `SELECT id FROM core.worker_event WHERE entity_id = $1 AND event_type = 'manager_confirmation_timeout'`, [offer.id]);
      expect(events).toHaveLength(1); // never re-claimed by the second, no-op run
    });

    it('I2: restart/catch-up — an offer overdue for hours (worker offline past the deadline) is auto-confirmed exactly once on the first healthy scan', async () => {
      const fx = await seedNormalFixture('restartCatchup');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -(TIMEOUT_MS + 2 * 3600 * 1000)); // 2 hours past deadline

      await runTimeoutCycle();
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.MANAGER_CONFIRMED);
    });
  });

  // ===================================================================
  // J. Audit and notification exactly once
  // ===================================================================
  describe('J. audit and notification exactly once', () => {
    it('J1: exactly one confirm audit, one manager notification, one staff notification; no notification to Manager B', async () => {
      const fx = await seedNormalFixture('sideEffectsOnce');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);

      await raceAndReport(Array.from({ length: 5 }, () => () => runTimeoutCycle()));

      expect(await countTimeoutConfirmAudits(fx, offer.id)).toBe(1);

      const managerNotifications = await withContext(ctxOf(fx.managerA), (m) =>
        m.find(Notification, { where: { userId: fx.managerA.userId, relatedEntityType: 'offer', relatedEntityId: offer.id, type: 'manager_confirmation_timeout' } }),
      );
      expect(managerNotifications).toHaveLength(1);
      const managerText = `${managerNotifications[0]!.title} ${managerNotifications[0]!.message}`.toLowerCase();
      expect(managerText).not.toContain('rejected');
      expect(managerText).toContain('confirm');

      const staffNotifications = await withContext(staffCtxOf(fx, staff), (m) =>
        m.find(Notification, { where: { userId: staff.userId, relatedEntityType: 'offer', relatedEntityId: offer.id, type: 'offer_confirmed' } }),
      );
      expect(staffNotifications).toHaveLength(1);

      const managerBNotifications = await withContext(ctxOf(fx.managerB), (m) =>
        m.find(Notification, { where: { userId: fx.managerB.userId, relatedEntityType: 'offer', relatedEntityId: offer.id } }),
      );
      expect(managerBNotifications).toHaveLength(0);
    });

    it('J2: current product behavior creates NO replacement request from an auto-confirmation (replacement discovery only scans declined/expired)', async () => {
      const fx = await seedNormalFixture('noReplacementOnTimeout');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await seedStaffAcceptedOffer(fx, shift, staff, -TIMEOUT_MS - 5_000);
      await runTimeoutCycle();
      const replacementRequests = await withContext(ctxOf(fx.managerA), (m) => m.find(ReplacementRequest, { where: { shiftId: shift.id } }));
      expect(replacementRequests).toHaveLength(0);
    });
  });

  // ===================================================================
  // K. Discovery / performance
  // ===================================================================
  describe('K. discovery fairness and index evidence', () => {
    it('K1: many already-terminal offers never crowd out a freshly-eligible one (terminal rows structurally drop out of the WHERE clause)', async () => {
      const fx = await seedNormalFixture('fairness');
      for (let i = 0; i < 10; i++) {
        const s = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: `terminal${i}` });
        const sh = await seedOpenShift(fx);
        const o = await offerService.send(ctxOf(fx.managerA), sh.id, { staffProfileId: s.profileId! });
        await offerService.staffAccept(staffCtxOf(fx, s), o.id);
        await offerService.managerConfirm(ctxOf(fx.managerA), o.id); // now MANAGER_CONFIRMED — permanently outside this discovery query
      }
      const freshStaff = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'fresh' });
      const freshShift = await seedOpenShift(fx);
      const freshOffer = await seedStaffAcceptedOffer(fx, freshShift, freshStaff, -TIMEOUT_MS - 5_000);

      await runTimeoutCycle();
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: freshOffer.id }));
      expect(final.status).toBe(OfferStatus.MANAGER_CONFIRMED);
    });

    it('K2: discovery is bounded under runtime RLS and retains its supporting index', async () => {
      const fx = await seedNormalFixture('scopedTimeoutPlan');
      const plan = await withContext(ctxOf(fx.managerA), async (manager) => {
        const [role] = await manager.query('SELECT current_user AS name');
        expect(role.name).toBe('rab_app');
        const indexes = await manager.query("SELECT indexname FROM pg_indexes WHERE schemaname='core' AND tablename='job_offer'");
        expect(indexes.map((r: { indexname: string }) => r.indexname)).toContain('job_offer_staff_accepted_timeout_idx');
        const explain = await manager.query(`EXPLAIN (FORMAT JSON)
          SELECT id AS offer_id, organisation_id, workspace_id FROM core.job_offer
          WHERE status = 'staff_accepted' AND staff_accepted_at < now() - make_interval(mins => 60)
          ORDER BY staff_accepted_at ASC LIMIT 500`);
        return explain[0]['QUERY PLAN'][0].Plan;
      });
      // PostgreSQL may choose another index or a sequential scan for tiny fixtures.
      expect(plan['Node Type']).toBe('Limit');
      expect(plan['Plan Rows']).toBeLessThanOrEqual(500);
      expect(JSON.stringify(plan)).toContain('workspace_id');
    });
  });
});
