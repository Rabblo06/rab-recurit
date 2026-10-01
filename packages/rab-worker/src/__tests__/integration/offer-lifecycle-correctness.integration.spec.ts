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
import { runOfferExpiryCycle } from '../../queues/rab-offers/offer-expiry.job';
import { runReplacementStaffCycle } from '../../queues/rab-offers/replacement-staff.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase 6 — staff response / offer expiry correctness. Real Postgres, RLS
 * on, no mocks. Covers: the atomic accept/decline/expiry claims (including
 * the `staffAccept()` lazy-expiry path now sharing the SAME canonical
 * claim as the worker), every pairwise race (accept-vs-expire,
 * decline-vs-expire, accept-vs-decline, N-way duplicate requests),
 * last-vacancy and multi-vacancy capacity safety, workspace-inheritance
 * integrity (including the composite-FK proof), normal Manager-A-vs-
 * Manager-B isolation, the Phase 5.5 same-workspace defence-in-depth
 * fixture, staff IDOR, and cancellation/replacement integration.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

describeIfDb('offer lifecycle correctness (integration)', () => {
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

  async function seedOpenShift(fx: Fixture, opts?: { startsAt?: Date; endsAt?: Date; requiredCount?: number; autoConfirm?: boolean }): Promise<Shift> {
    const startsAt = opts?.startsAt ?? new Date(Date.now() + 3 * 3600 * 1000);
    const endsAt = opts?.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);
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
        // A real ManagerVenue-request-approve flow is a whole separate feature; setting `requestedBy` directly here
        // reproduces its ONE relevant effect (`staffAccept`'s existing `autoConfirm` branch) without reimplementing
        // Venue-Manager-request submission just to reach it — see offer.service.ts's own doc comment on that branch.
        requestedBy: opts?.autoConfirm ? fx.managerA.userId : undefined,
        workspaceId: fx.managerA.workspaceId!,
      }),
    );
  }

  async function sendOfferAndBackdate(fx: Fixture, shiftId: string, staffProfileId: string, expiresAt: Date): Promise<JobOffer> {
    const offer = await offerService.send(ctxOf(fx.managerA), shiftId, { staffProfileId });
    await withContext(ctxOf(fx.managerA), (m) => m.update(JobOffer, offer.id, { expiresAt }));
    return withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
  }

  async function countAudit(fx: Fixture, action: string, entityId: string): Promise<number> {
    const rows = await withContext(ctxOf(fx.managerA), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.audit_log WHERE action = $1 AND entity_id = $2`, [action, entityId]));
    return Number(rows[0]!.count);
  }

  /**
   * A terminal-state re-transition attempt (e.g. re-accepting an already
   * DECLINED/EXPIRED/WITHDRAWN/STAFF_ACCEPTED offer) is safely rejected two
   * different ways depending on WHICH guard fires first: `assertTransition`'s
   * own in-memory pre-check throws `InvalidTransitionError` (CLAUDE.md: 409)
   * for a status objectively never reachable from the current one regardless
   * of timing, while the atomic DB claim throws `ConflictException` for a
   * status that WAS reachable a moment ago but lost a real race. Both are
   * the same "safely rejected, no side effects" outcome; a caller of the
   * service proving "this cannot succeed" should accept either.
   */
  function expectSafeRejection(error: unknown): void {
    expect(error instanceof ConflictException || error instanceof InvalidTransitionError).toBe(true);
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
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  // ===================================================================
  // A. Workspace architecture
  // ===================================================================
  describe('A. workspace architecture', () => {
    it('A1-A5: Manager A/B own separate workspaces; Offer A inherits Assignment A inherits Shift A workspace', async () => {
      const fx = await seedNormalFixture('wsArch');
      expect(fx.managerA.workspaceId).not.toBe(fx.managerB.workspaceId);
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      const assignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offer.shiftAssignmentId }));
      expect(assignment.workspaceId).toBe(shift.workspaceId);
      expect(offer.workspaceId).toBe(assignment.workspaceId);
    });

    it('A6-A8: Manager B cannot list/mutate Offer A or send against Shift A (normal, separate-workspace topology)', async () => {
      const fx = await seedNormalFixture('wsArchDeny');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });

      const listed = await offerService.list(ctxOf(fx.managerB));
      expect(listed.data.some((o) => o.id === offer.id)).toBe(false);
      await expect(offerService.withdraw(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      const staff2 = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'a8' });
      await expect(offerService.send(ctxOf(fx.managerB), shift.id, { staffProfileId: staff2.profileId! })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('A30: a cross-workspace assignment/offer relationship cannot be inserted, even by direct SQL — composite FK integrity', async () => {
      const fxA = await seedNormalFixture('compositeFkA');
      const fxB = await seedNormalFixture('compositeFkB');
      const shiftA = await seedOpenShift(fxA);
      // Attempt to insert a JobOffer whose workspace_id belongs to Org/Workspace B while its shift_assignment_id
      // belongs to Org/Workspace A's shift — the composite FK (shift_assignment_id, workspace_id) -> shift_assignment(id, workspace_id)
      // must reject this outright, regardless of RLS (using the owner connection, which bypasses RLS but NOT foreign keys).
      const staffA = await factory.createStaff(fxA.organisation, { owner: fxA.managerA });
      const offerA = await offerService.send(ctxOf(fxA.managerA), shiftA.id, { staffProfileId: staffA.profileId! });
      const assignmentA = await withContext(ctxOf(fxA.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { id: offerA.shiftAssignmentId }));

      await expect(
        adminDataSource.manager.query(
          `INSERT INTO core.job_offer (organisation_id, shift_assignment_id, staff_profile_id, status, sent_at, expires_at, estimated_pay_pence, workspace_id)
             VALUES ($1, $2, $3, 'pending', now(), now() + interval '1 day', 1000, $4)`,
          [fxA.organisation.id, assignmentA.id, staffA.profileId, fxB.managerB.workspaceId],
        ),
      ).rejects.toThrow();
    });
  });

  // ===================================================================
  // B. Phase 5.5 defence in depth
  // ===================================================================
  describe('B. Phase 5.5 same-workspace defence in depth', () => {
    it('B9-B12: Manager B (forced same workspace, different user) still cannot confirm/reject/withdraw Offer A; Manager A retains access', async () => {
      const fx = await seedSameWorkspaceFixture('p55Defence');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);

      await expect(offerService.managerConfirm(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.managerReject(ctxOf(fx.managerB), offer.id, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.withdraw(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);

      const confirmed = await offerService.managerConfirm(ctxOf(fx.managerA), offer.id);
      expect(confirmed.status).toBe(OfferStatus.MANAGER_CONFIRMED);
    });
  });

  // ===================================================================
  // C. Staff IDOR
  // ===================================================================
  describe('C. staff IDOR', () => {
    it('C13-C17: Staff A can accept their own offer; Staff B cannot accept/decline it; a guessed UUID and client-supplied identity fields never bypass ownership', async () => {
      const fx = await seedNormalFixture('staffIdor');
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'staffA' });
      const staffB = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'staffB' });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staffA.profileId! });

      await expect(offerService.staffAccept(staffCtxOf(fx, staffB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.decline(staffCtxOf(fx, staffB), offer.id, {})).rejects.toBeInstanceOf(NotFoundException);

      // A guessed/enumerated random UUID behaves identically to a real-but-foreign offer id — no existence signal leaked.
      await expect(offerService.staffAccept(staffCtxOf(fx, staffB), randomUUID())).rejects.toBeInstanceOf(NotFoundException);

      // Identity is derived server-side from ctx.userId -> StaffProfile; there is no field on the accept/decline call
      // surface for a client to supply staffProfileId/organisationId/workspaceId at all (the methods take only an id) —
      // proven directly: staffAccept's own StaffProfile resolution ignores anything but ctx.userId.
      const accepted = await offerService.staffAccept(staffCtxOf(fx, staffA), offer.id);
      expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED);
    });
  });

  // ===================================================================
  // D. Normal transitions
  // ===================================================================
  describe('D. normal transitions', () => {
    it('D18-D24: pending->accepted, pending->declined, worker-expired, and every terminal state rejects a late accept', async () => {
      const fx = await seedNormalFixture('normalD');
      const staffAccept = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dAccept' });
      const shiftAccept = await seedOpenShift(fx);
      const offerAccept = await offerService.send(ctxOf(fx.managerA), shiftAccept.id, { staffProfileId: staffAccept.profileId! });
      const accepted = await offerService.staffAccept(staffCtxOf(fx, staffAccept), offerAccept.id);
      expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED);
      await offerService.staffAccept(staffCtxOf(fx, staffAccept), offerAccept.id).then(
        () => { throw new Error('expected re-accept to be rejected'); },
        expectSafeRejection,
      ); // accepted cannot re-accept / cannot expire

      const staffDecline = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dDecline' });
      const shiftDecline = await seedOpenShift(fx);
      const offerDecline = await offerService.send(ctxOf(fx.managerA), shiftDecline.id, { staffProfileId: staffDecline.profileId! });
      const declined = await offerService.decline(staffCtxOf(fx, staffDecline), offerDecline.id, { reason: 'busy' });
      expect(declined.status).toBe(OfferStatus.DECLINED);
      await offerService.staffAccept(staffCtxOf(fx, staffDecline), offerDecline.id).then(
        () => { throw new Error('expected accept-after-decline to be rejected'); },
        expectSafeRejection,
      ); // declined cannot accept, cannot expire

      const staffExpire = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dExpire' });
      const shiftExpire = await seedOpenShift(fx);
      const offerExpire = await sendOfferAndBackdate(fx, shiftExpire.id, staffExpire.profileId!, new Date(Date.now() - 60_000));
      const result = await runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect(result.expired).toBeGreaterThanOrEqual(1);
      const finalExpired = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offerExpire.id }));
      expect(finalExpired.status).toBe(OfferStatus.EXPIRED);
      await offerService.staffAccept(staffCtxOf(fx, staffExpire), offerExpire.id).then(
        () => { throw new Error('expected accept-after-expiry to be rejected'); },
        expectSafeRejection,
      ); // expired cannot accept

      const staffWithdraw = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dWithdraw' });
      const shiftWithdraw = await seedOpenShift(fx);
      const offerWithdraw = await offerService.send(ctxOf(fx.managerA), shiftWithdraw.id, { staffProfileId: staffWithdraw.profileId! });
      await offerService.withdraw(ctxOf(fx.managerA), offerWithdraw.id);
      await offerService.staffAccept(staffCtxOf(fx, staffWithdraw), offerWithdraw.id).then(
        () => { throw new Error('expected accept-after-withdraw to be rejected'); },
        expectSafeRejection,
      ); // withdrawn cannot accept
    });
  });

  // ===================================================================
  // E. Expiry boundary — database time is authoritative
  // ===================================================================
  describe('E. expiry boundary (DB time authoritative)', () => {
    it('E25/E28: just before expiresAt is still acceptable, regardless of what a client clock claims', async () => {
      const fx = await seedNormalFixture('expiryBoundary');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      // 5 seconds in the future — well within the atomic claim's `expires_at > now()` window at call time.
      const offer = await sendOfferAndBackdate(fx, shift.id, staff.profileId!, new Date(Date.now() + 5_000));
      const accepted = await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
      expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED);
    });

    it('E27: after expiresAt (by real DB time) is expired, and the lazy-accept path claims it exactly like the worker would', async () => {
      const fx = await seedNormalFixture('expiryAfter');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendOfferAndBackdate(fx, shift.id, staff.profileId!, new Date(Date.now() - 5_000));
      await expect(offerService.staffAccept(staffCtxOf(fx, staff), offer.id)).rejects.toBeInstanceOf(ConflictException);
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.EXPIRED);
      expect(await countAudit(fx, 'offer.expired', offer.id)).toBe(1);
    });
  });

  // ===================================================================
  // F. Concurrency — the core of Phase 6
  // ===================================================================
  describe('F. concurrency', () => {
    it('F29: accept vs worker-expire on an already-past-deadline offer — exactly one side records the expiry, never both, never an accepted-with-expiry-side-effects contradiction', async () => {
      const fx = await seedNormalFixture('acceptVsExpire');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendOfferAndBackdate(fx, shift.id, staff.profileId!, new Date(Date.now() - 2_000));

      const results = await raceAndReport([
        () => offerService.staffAccept(staffCtxOf(fx, staff), offer.id),
        () => runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService),
      ]);
      void results;

      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(final.status).toBe(OfferStatus.EXPIRED); // deterministic: the deadline had already passed for both sides
      const totalExpiryAudits = (await countAudit(fx, 'offer.expired', offer.id)) + (await countAudit(fx, 'offer.expired_by_worker', offer.id));
      expect(totalExpiryAudits).toBe(1); // exactly one side ever recorded it, regardless of which
    });

    it('F30: decline vs worker-expire — exactly one wins, never double side effects', async () => {
      const fx = await seedNormalFixture('declineVsExpire');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendOfferAndBackdate(fx, shift.id, staff.profileId!, new Date(Date.now() - 2_000));

      await raceAndReport([
        () => offerService.decline(staffCtxOf(fx, staff), offer.id, {}),
        () => runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService),
      ]);

      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect([OfferStatus.DECLINED, OfferStatus.EXPIRED]).toContain(final.status);
      const declineAudits = await countAudit(fx, 'offer.declined', offer.id);
      const expiryAudits = (await countAudit(fx, 'offer.expired', offer.id)) + (await countAudit(fx, 'offer.expired_by_worker', offer.id));
      expect(declineAudits + expiryAudits).toBe(1); // exactly one logical transition ever recorded
    });

    it('F31: accept vs decline (two devices) — exactly one wins', async () => {
      const fx = await seedNormalFixture('acceptVsDecline');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });

      const results = await raceAndReport([() => offerService.staffAccept(staffCtxOf(fx, staff), offer.id), () => offerService.decline(staffCtxOf(fx, staff), offer.id, {})]);
      const succeeded = results.filter((r) => r.ok);
      expect(succeeded).toHaveLength(1);
      const final = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect([OfferStatus.STAFF_ACCEPTED, OfferStatus.DECLINED]).toContain(final.status);
    });

    it('F32: five simultaneous accept requests for the SAME offer — exactly one logical transition', async () => {
      const fx = await seedNormalFixture('fiveAccepts');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });

      const results = await raceAndReport(Array.from({ length: 5 }, () => () => offerService.staffAccept(staffCtxOf(fx, staff), offer.id)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(4);
      expect(await countAudit(fx, 'offer.accepted', offer.id)).toBe(1);
    });

    it('F33: five simultaneous decline requests for the SAME offer — exactly one decline, one audit', async () => {
      const fx = await seedNormalFixture('fiveDeclines');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });

      const results = await raceAndReport(Array.from({ length: 5 }, () => () => offerService.decline(staffCtxOf(fx, staff), offer.id, { reason: 'race' })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await countAudit(fx, 'offer.declined', offer.id)).toBe(1);
    });

    it('F34: five simultaneous worker-expiry cycles for the same backlog — one expiry per offer, never duplicated', async () => {
      const fx = await seedNormalFixture('fiveExpiries');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendOfferAndBackdate(fx, shift.id, staff.profileId!, new Date(Date.now() - 2_000));

      const results = await raceAndReport(Array.from({ length: 5 }, () => () => runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService)));
      const totalExpiredAcrossAllCycles = results.reduce((sum, r) => (r.ok ? sum + (r.value as { expired: number }).expired : sum), 0);
      expect(totalExpiredAcrossAllCycles).toBe(1);
      expect(await countAudit(fx, 'offer.expired_by_worker', offer.id)).toBe(1);
    });
  });

  // ===================================================================
  // G. Capacity — last vacancy and multi-vacancy
  // ===================================================================
  describe('G. capacity concurrency', () => {
    it('G35/G36: one vacancy, five staff accepting an auto-confirm shift simultaneously — exactly one seat, four safe SHIFT_FULL conflicts', async () => {
      const fx = await seedNormalFixture('lastVacancy');
      const shift = await seedOpenShift(fx, { requiredCount: 1, autoConfirm: true });
      const staffMembers = await Promise.all(Array.from({ length: 5 }, (_, i) => factory.createStaff(fx.organisation, { owner: fx.managerA, label: `lv${i}` })));
      const offers: JobOffer[] = [];
      for (const s of staffMembers) offers.push(await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: s.profileId! }));

      const results = await raceAndReport(staffMembers.map((s, i) => () => offerService.staffAccept(staffCtxOf(fx, s), offers[i]!.id)));
      const succeeded = results.filter((r) => r.ok);
      expect(succeeded).toHaveLength(1);
      for (const failed of results.filter((r) => !r.ok)) expect(failed.error).toBeInstanceOf(ConflictException);

      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1);
      expect(finalShift.status).toBe(ShiftStatus.FULLY_FILLED);
      const confirmedCount = await withContext(ctxOf(fx.managerA), (m) =>
        m.count(ShiftAssignment, { where: { shiftId: shift.id, status: ShiftAssignmentStatus.CONFIRMED } }),
      );
      expect(confirmedCount).toBe(1);
      // The 4 losing attempts must have rolled back their own claim entirely (never a stranded offer=STAFF_ACCEPTED
      // with assignment=OFFERED forever) — each loser's offer/assignment is back at PENDING/OFFERED, still usable.
      const pendingCount = await withContext(ctxOf(fx.managerA), (m) =>
        m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer o JOIN core.shift_assignment sa ON sa.id = o.shift_assignment_id WHERE sa.shift_id = $1 AND o.status = 'pending'`, [shift.id]),
      );
      expect(Number(pendingCount[0]!.count)).toBe(4);
    });

    it('G37/G38: three vacancies, five simultaneous accepts — exactly three seats, filledCount/status consistent', async () => {
      const fx = await seedNormalFixture('multiVacancy');
      const shift = await seedOpenShift(fx, { requiredCount: 3, autoConfirm: true });
      const staffMembers = await Promise.all(Array.from({ length: 5 }, (_, i) => factory.createStaff(fx.organisation, { owner: fx.managerA, label: `mv${i}` })));
      const offers: JobOffer[] = [];
      for (const s of staffMembers) offers.push(await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: s.profileId! }));

      const results = await raceAndReport(staffMembers.map((s, i) => () => offerService.staffAccept(staffCtxOf(fx, s), offers[i]!.id)));
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(results.filter((r) => !r.ok)).toHaveLength(2);

      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(3);
      expect(finalShift.status).toBe(ShiftStatus.FULLY_FILLED);
      const confirmedCount = await withContext(ctxOf(fx.managerA), (m) =>
        m.count(ShiftAssignment, { where: { shiftId: shift.id, status: ShiftAssignmentStatus.CONFIRMED } }),
      );
      expect(confirmedCount).toBe(3);
    });

    it('G-manual-flow: the two-step (non-auto-confirm) equivalent — five STAFF_ACCEPTED offers, manager confirms all five concurrently, exactly one vacancy is honoured', async () => {
      const fx = await seedNormalFixture('manualFlowCapacity');
      const shift = await seedOpenShift(fx, { requiredCount: 1, autoConfirm: false });
      const staffMembers = await Promise.all(Array.from({ length: 5 }, (_, i) => factory.createStaff(fx.organisation, { owner: fx.managerA, label: `mf${i}` })));
      const offers: JobOffer[] = [];
      for (const s of staffMembers) offers.push(await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: s.profileId! }));
      for (let i = 0; i < staffMembers.length; i++) {
        const accepted = await offerService.staffAccept(staffCtxOf(fx, staffMembers[i]!), offers[i]!.id);
        expect(accepted.status).toBe(OfferStatus.STAFF_ACCEPTED); // two-step flow: accept alone never consumes the seat
      }

      const results = await raceAndReport(offers.map((o) => () => offerService.managerConfirm(ctxOf(fx.managerA), o.id)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const finalShift = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(Shift, { id: shift.id }));
      expect(finalShift.filledCount).toBe(1);
    });
  });

  // ===================================================================
  // H. Cancellation integration (Phase 5 preserved)
  // ===================================================================
  describe('H. cancellation integration', () => {
    it('H39: cancel wins before accept — acceptance is blocked', async () => {
      const fx = await seedNormalFixture('cancelBeforeAccept');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      await schedulingService.cancel(ctxOf(fx.managerA), shift.id);
      await expect(offerService.staffAccept(staffCtxOf(fx, staff), offer.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('H40: accept wins before cancel — cancellation still succeeds (Phase 5 reconciliation applies)', async () => {
      const fx = await seedNormalFixture('acceptBeforeCancel');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
      const cancelled = await schedulingService.cancel(ctxOf(fx.managerA), shift.id);
      expect(cancelled.status).toBe(ShiftStatus.CANCELLED);
    });

    it('H41: manager confirm on a cancelled shift is blocked', async () => {
      const fx = await seedNormalFixture('confirmOnCancelled');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staff), offer.id);
      await schedulingService.cancel(ctxOf(fx.managerA), shift.id);
      await expect(offerService.managerConfirm(ctxOf(fx.managerA), offer.id)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ===================================================================
  // J. Replacement integration (Phase 4 preserved)
  // ===================================================================
  describe('J. replacement integration', () => {
    it('J46/J48/J49/J50: successful decline creates at most one replacement request, in Workspace A only, invisible to Manager B; a CAS loser creates none', async () => {
      const fx = await seedNormalFixture('replIntegration');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });
      await offerService.decline(staffCtxOf(fx, staff), offer.id, { reason: 'no longer available' });

      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const requests = await withContext(ctxOf(fx.managerA), (m) => m.find(ReplacementRequest, { where: { shiftId: shift.id } }));
      expect(requests.length).toBeLessThanOrEqual(1);
      if (requests.length === 1) {
        expect(requests[0]!.workspaceId).toBe(fx.managerA.workspaceId);
        const seenByB = await withContext(ctxOf(fx.managerB), (m) => m.findOne(ReplacementRequest, { where: { id: requests[0]!.id } }));
        expect(seenByB).toBeNull();
      }
      // Running the discovery cycle again must never duplicate it (the real UNIQUE constraint + ON CONFLICT is the guard).
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const requestsAfterSecondRun = await withContext(ctxOf(fx.managerA), (m) => m.find(ReplacementRequest, { where: { shiftId: shift.id } }));
      expect(requestsAfterSecondRun).toHaveLength(requests.length);
    });

    it('J47: successful worker-expiry also creates at most one replacement request', async () => {
      const fx = await seedNormalFixture('replExpiry');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await sendOfferAndBackdate(fx, shift.id, staff.profileId!, new Date(Date.now() - 2_000));
      await runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService);
      await runReplacementStaffCycle(adminDataSource, tenantContext, notificationService, auditService);
      const requests = await withContext(ctxOf(fx.managerA), (m) => m.find(ReplacementRequest, { where: { declinedOfferId: offer.id } }));
      expect(requests.length).toBeLessThanOrEqual(1);
    });
  });

  // ===================================================================
  // K. Audit / notification exactly once
  // ===================================================================
  describe('K. audit and notification exactly once', () => {
    it('K51/K52/K53: one acceptance audit, one decline audit, one expiry audit — no duplicates from a normal single call', async () => {
      const fx = await seedNormalFixture('auditOnce');
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'auditAccept' });
      const shiftA = await seedOpenShift(fx);
      const offerA = await offerService.send(ctxOf(fx.managerA), shiftA.id, { staffProfileId: staffA.profileId! });
      await offerService.staffAccept(staffCtxOf(fx, staffA), offerA.id);
      expect(await countAudit(fx, 'offer.accepted', offerA.id)).toBe(1);

      const staffD = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'auditDecline' });
      const shiftD = await seedOpenShift(fx);
      const offerD = await offerService.send(ctxOf(fx.managerA), shiftD.id, { staffProfileId: staffD.profileId! });
      await offerService.decline(staffCtxOf(fx, staffD), offerD.id, { reason: 'busy' });
      expect(await countAudit(fx, 'offer.declined', offerD.id)).toBe(1);

      const staffE = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'auditExpire' });
      const shiftE = await seedOpenShift(fx);
      const offerE = await sendOfferAndBackdate(fx, shiftE.id, staffE.profileId!, new Date(Date.now() - 2_000));
      await runOfferExpiryCycle(adminDataSource, tenantContext, notificationService, auditService);
      expect(await countAudit(fx, 'offer.expired_by_worker', offerE.id)).toBe(1);
    });

    it('K55: notification is emitted exactly once per winning transition even under 5-way concurrency', async () => {
      const fx = await seedNormalFixture('notifyOnce');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });

      await raceAndReport(Array.from({ length: 5 }, () => () => offerService.staffAccept(staffCtxOf(fx, staff), offer.id)));
      const notifications = await withContext(ctxOf(fx.managerA), (m) =>
        m.find(Notification, { where: { userId: fx.managerA.userId, relatedEntityType: 'offer', relatedEntityId: offer.id, type: 'offer_accepted' } }),
      );
      expect(notifications).toHaveLength(1);
    });
  });

  // ===================================================================
  // L. Worker / RLS
  // ===================================================================
  describe('L. worker workspace binding and RLS', () => {
    it('L57/L58: wrong workspace context and no tenant context at all cannot mutate Offer A directly', async () => {
      const fx = await seedNormalFixture('workerRls');
      const staff = await factory.createStaff(fx.organisation, { owner: fx.managerA });
      const shift = await seedOpenShift(fx);
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staff.profileId! });

      // `manager.query()` returns `[rows, rowCount]` for an UPDATE ... RETURNING —
      // destructure the rows out before asserting on how many were affected.
      const [wrongWorkspaceRows] = await withContext({ organisationId: fx.organisation.id, workspaceId: fx.managerB.workspaceId, userId: fx.managerB.userId }, (m) =>
        m.query<[Array<{ id: string }>, number]>(`UPDATE core.job_offer SET status = 'withdrawn' WHERE id = $1 RETURNING id`, [offer.id]),
      );
      expect(wrongWorkspaceRows).toHaveLength(0);

      const [noContextRows] = await dataSource.transaction(async (m) => {
        await m.query(`SELECT set_config('rab.organisation_id', '', true)`);
        await m.query(`SELECT set_config('rab.workspace_id', '', true)`);
        await m.query(`SELECT set_config('rab.user_id', '', true)`);
        return m.query<[Array<{ id: string }>, number]>(`UPDATE core.job_offer SET status = 'withdrawn' WHERE id = $1 RETURNING id`, [offer.id]);
      });
      expect(noContextRows).toHaveLength(0);

      const stillPending = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(stillPending.status).toBe(OfferStatus.PENDING);
    });

    it('L34/L35 (query shape): expiry discovery is bounded under the actual runtime RLS context', async () => {
      const fx = await seedNormalFixture('scopedPlan');
      // Small disposable tables may legitimately use a sequential scan. Test
      // the real scoped query/limit, not a specific cost-based index choice.
      const plan = await withContext(ctxOf(fx.managerA), async manager => {
        const [role] = await manager.query('SELECT current_user AS name');
        expect(role.name).toBe('rab_app');
        const explain = await manager.query(`EXPLAIN (FORMAT JSON)
          SELECT id AS offer_id, organisation_id, workspace_id FROM core.job_offer
          WHERE status='pending' AND expires_at < now() ORDER BY expires_at ASC LIMIT 500`);
        return explain[0]['QUERY PLAN'][0].Plan;
      });
      expect(plan['Node Type']).toBe('Limit');
      expect(plan['Plan Rows']).toBeLessThanOrEqual(500);
      expect(JSON.stringify(plan)).toContain('workspace_id');
    });
  });
});
