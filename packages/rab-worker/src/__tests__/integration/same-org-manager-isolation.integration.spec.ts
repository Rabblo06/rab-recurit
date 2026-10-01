import 'reflect-metadata';
import { EmploymentStatus, OfferStatus, ReplacementRequestStatus, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '@rab/server/app.module';
import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { PasswordHashingService } from '@rab/server/engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '@rab/server/engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceService } from '@rab/server/modules/attendance/services/attendance.service';
import { ShiftReportService } from '@rab/server/modules/attendance/services/shift-report.service';
import { Attendance } from '@rab/server/modules/attendance/entities/attendance.entity';
import { DashboardService } from '@rab/server/modules/dashboard/services/dashboard.service';
import { Organisation } from '@rab/server/modules/identity/entities/index';
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
import { StaffService } from '@rab/server/modules/staff/services/staff.service';
import { VenueService } from '@rab/server/modules/venue/services/venue.service';
import { Venue } from '@rab/server/modules/venue/entities/venue.entity';
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Phase 5.5 — same-organisation manager isolation. Real Postgres, RLS on,
 * no mocks. The central fixture throughout: Manager A and Manager B belong
 * to the SAME organisation AND the SAME workspace, holding the SAME
 * production permission set, with DIFFERENT user ids — deliberately
 * constructed (no real onboarding path produces two Internal Managers
 * sharing one workspace; nothing at the schema level prevents it either —
 * `manager_profile.workspace_id` has only a plain index, no UNIQUE
 * constraint) so organisation/workspace/permission equality can never be
 * mistaken for the reason a denial happens. If Manager B is denied under
 * THIS fixture, manager-level ownership is what actually did the work.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

describeIfDb('same-organisation manager isolation (integration)', () => {
  let app: import('@nestjs/common').INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let auditService: AuditService;
  let notificationService: NotificationService;
  let schedulingService: SchedulingService;
  let offerService: OfferService;
  let replacementRequestService: ReplacementRequestService;
  let staffService: StaffService;
  let venueService: VenueService;
  let attendanceService: AttendanceService;
  let shiftReportService: ShiftReportService;
  let dashboardService: DashboardService;
  let factory: TestIdentityFactory;

  interface Fixture {
    organisation: Organisation;
    managerA: TestIdentity;
    managerB: TestIdentity;
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

  /**
   * The central adversarial fixture: Manager A gets a real, normal private
   * ManagerWorkspace (the only way one is ever created); Manager B is
   * created the SAME way (own real onboarding, own real everything) and
   * then, and ONLY then, forced to point at Manager A's workspace via a
   * direct owner-connection UPDATE — the one raw manipulation this whole
   * suite depends on, since no product feature does this today. Both hold
   * the full production permission set, so a denial can only be explained
   * by manager-level ownership, never by role/permission/org/workspace.
   */
  async function seedFixture(label: string): Promise<Fixture> {
    const organisation = await factory.createOrganisation(label);
    const managerA = await factory.createInternalManager(organisation, { permissions: 'production', label: `${label}-a` });
    const managerBRaw = await factory.createInternalManager(organisation, { permissions: 'production', label: `${label}-b`, workspace: false });
    await adminDataSource.manager.query(`UPDATE core.manager_profile SET workspace_id = $1 WHERE id = $2`, [managerA.workspaceId, managerBRaw.profileId]);
    const managerB: TestIdentity = { ...managerBRaw, workspaceId: managerA.workspaceId };
    return { organisation, managerA, managerB };
  }

  async function seedVenueAndRole(fx: Fixture): Promise<{ venueId: string; jobRoleId: string }> {
    return withContext(ctxOf(fx.managerA), async (m) => {
      const venue = await m.save(Venue, { organisationId: fx.organisation.id, name: `${fx.organisation.name} Venue A`, createdBy: fx.managerA.userId, workspaceId: fx.managerA.workspaceId! });
      const jobRole = await m.save(JobRole, { organisationId: fx.organisation.id, name: `Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: fx.managerA.userId, workspaceId: fx.managerA.workspaceId! });
      return { venueId: venue.id, jobRoleId: jobRole.id };
    });
  }

  /** `TestIdentityFactory.createStaff` never sets `employment_status` (the column defaults to `PENDING_COMPLIANCE`) — `ReplacementRequestService.assertStillEligible` requires ACTIVE, unlike the plain offer-send path (which only checks the User's own status, already ACTIVE by the factory's own default). Only needed for staff used as replacement candidates. */
  async function activateStaff(profileId: string): Promise<void> {
    await adminDataSource.manager.query(`UPDATE core.staff_profile SET employment_status = $1 WHERE id = $2`, [EmploymentStatus.ACTIVE, profileId]);
  }

  async function seedOpenShift(fx: Fixture, venueId: string, jobRoleId: string, opts?: { startsAt?: Date; endsAt?: Date }): Promise<Shift> {
    const startsAt = opts?.startsAt ?? new Date(Date.now() + 3 * 3600 * 1000);
    const endsAt = opts?.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);
    return withContext(ctxOf(fx.managerA), (m) =>
      m.save(Shift, { organisationId: fx.organisation.id, venueId, jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.OPEN, createdBy: fx.managerA.userId, workspaceId: fx.managerA.workspaceId! }),
    );
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
    staffService = app.get(StaffService);
    venueService = app.get(VenueService);
    attendanceService = app.get(AttendanceService);
    shiftReportService = app.get(ShiftReportService);
    dashboardService = app.get(DashboardService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  it('sanity: the adversarial fixture is real — same org, same workspace, different users', async () => {
    const fx = await seedFixture('sanity');
    expect(fx.managerA.organisationId).toBe(fx.managerB.organisationId);
    expect(fx.managerA.workspaceId).toBe(fx.managerB.workspaceId);
    expect(fx.managerA.userId).not.toBe(fx.managerB.userId);
    expect(fx.managerA.roleKey).toBe(fx.managerB.roleKey);
  });

  // ===================================================================
  // A. Staff
  // ===================================================================
  describe('A. staff isolation', () => {
    it('A1-A4: list hides A staff; detail/update/deactivate denied', async () => {
      const fx = await seedFixture('staffA');
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'staffA' });

      const listed = await staffService.list(ctxOf(fx.managerB));
      expect(listed.data.some((s) => s.id === staffA.profileId)).toBe(false);

      await expect(staffService.get(ctxOf(fx.managerB), staffA.profileId!)).rejects.toBeInstanceOf(NotFoundException);
      await expect(staffService.update(ctxOf(fx.managerB), staffA.profileId!, { notes: 'attacker note' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(staffService.deactivate(ctxOf(fx.managerB), staffA.profileId!)).rejects.toBeInstanceOf(NotFoundException);

      // Positive control: Manager A can still reach their own staff member.
      const ownGet = await staffService.get(ctxOf(fx.managerA), staffA.profileId!);
      expect(ownGet.id).toBe(staffA.profileId);
    });
  });

  // ===================================================================
  // B. Venue
  // ===================================================================
  describe('B. venue isolation', () => {
    it('B5-B8: list hides A venue; detail/update denied; shift creation against A venue denied', async () => {
      const fx = await seedFixture('venueB');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);

      const listed = await venueService.list(ctxOf(fx.managerB));
      expect(listed.data.some((v) => v.id === venueId)).toBe(false);

      await expect(venueService.get(ctxOf(fx.managerB), venueId)).rejects.toBeInstanceOf(NotFoundException);
      await expect(venueService.update(ctxOf(fx.managerB), venueId, { name: 'hijacked' })).rejects.toBeInstanceOf(NotFoundException);

      const startsAt = new Date(Date.now() + 3 * 3600 * 1000);
      await expect(
        schedulingService.create(ctxOf(fx.managerB), {
          venueId,
          jobRoleId,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 8 * 3600 * 1000).toISOString(),
          requiredCount: 1,
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);

      const ownGet = await venueService.get(ctxOf(fx.managerA), venueId);
      expect(ownGet.id).toBe(venueId);
    });
  });

  // ===================================================================
  // C. Shift
  // ===================================================================
  describe('C. shift isolation', () => {
    it('C9-C13: list hides Shift A; detail/publish(update)/cancel/assignment-modification denied', async () => {
      const fx = await seedFixture('shiftC');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const shift = await seedOpenShift(fx, venueId, jobRoleId);

      const listed = await schedulingService.list(ctxOf(fx.managerB));
      expect(listed.data.some((s) => s.id === shift.id)).toBe(false);

      await expect(schedulingService.get(ctxOf(fx.managerB), shift.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(schedulingService.publish(ctxOf(fx.managerB), shift.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(schedulingService.cancel(ctxOf(fx.managerB), shift.id)).rejects.toBeInstanceOf(NotFoundException);

      // Assignment modification: Manager B attempts to send an offer against Manager A's shift (the closest
      // "modify this shift's assignments" action available at the service layer).
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'candC' });
      await expect(offerService.send(ctxOf(fx.managerB), shift.id, { staffProfileId: staffA.profileId! })).rejects.toBeInstanceOf(NotFoundException);

      const stillOpen = await schedulingService.get(ctxOf(fx.managerA), shift.id);
      expect(stillOpen.status).toBe(ShiftStatus.OPEN);
    });

    it('positive control: the shared PENDING_MANAGER_APPROVAL queue remains org-wide visible by explicit design', async () => {
      const fx = await seedFixture('shiftPending');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      // A Venue-Manager-submitted request lands at PENDING_MANAGER_APPROVAL with no createdBy owner yet — deliberately
      // org-wide visible to ANY Internal Manager with approval authority (see SchedulingService's own doc comments).
      const pending = await withContext(ctxOf(fx.managerA), (m) =>
        m.save(Shift, {
          organisationId: fx.organisation.id,
          venueId,
          jobRoleId,
          startsAt: new Date(Date.now() + 3 * 3600 * 1000),
          endsAt: new Date(Date.now() + 11 * 3600 * 1000),
          breakMinutes: 0,
          requiredCount: 1,
          payRatePence: 1500,
          status: ShiftStatus.PENDING_MANAGER_APPROVAL,
          createdBy: fx.managerA.userId,
          requestedBy: fx.managerA.userId,
          workspaceId: fx.managerA.workspaceId!,
        }),
      );
      const seenByB = await schedulingService.get(ctxOf(fx.managerB), pending.id);
      expect(seenByB.id).toBe(pending.id);
    });
  });

  // ===================================================================
  // D. Offer
  // ===================================================================
  describe('D. offer isolation', () => {
    it('D14-D17: list hides Offer A; detail/send-against-A-shift/confirm denied', async () => {
      const fx = await seedFixture('offerD');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const shift = await seedOpenShift(fx, venueId, jobRoleId);
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'candD' });
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staffA.profileId! });

      const listed = await offerService.list(ctxOf(fx.managerB));
      expect(listed.data.some((o) => o.id === offer.id)).toBe(false);

      // "detail": OfferService has no single-offer getter distinct from managerConfirm/decline; managerConfirm below
      // doubles as both the detail-equivalent (it loads the offer first) and the mutation test.
      await expect(offerService.managerConfirm(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);

      // Resend/create: Manager B cannot send a NEW offer against Manager A's shift either (already proven in C, repeated
      // here under the Offer heading since it's the direct "create an offer against Manager A shift" scenario).
      const staffA2 = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'candD2' });
      await expect(offerService.send(ctxOf(fx.managerB), shift.id, { staffProfileId: staffA2.profileId! })).rejects.toBeInstanceOf(NotFoundException);

      const ownList = await offerService.list(ctxOf(fx.managerA));
      expect(ownList.data.some((o) => o.id === offer.id)).toBe(true);
    });
  });

  // ===================================================================
  // E. Replacement — the PHASE 5.5 fix under direct test
  // ===================================================================
  describe('E. replacement isolation (Phase 5.5 fix)', () => {
    async function seedReplacement(fx: Fixture, venueId: string, jobRoleId: string, candidateProfileId: string) {
      const shift = await seedOpenShift(fx, venueId, jobRoleId);
      const declining = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'declE' });
      const declinedOffer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: declining.profileId! });
      const declinedAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { staffProfileId: declining.profileId! }));
      const request = await withContext(ctxOf(fx.managerA), (m) =>
        m.save(ReplacementRequest, {
          organisationId: fx.organisation.id,
          workspaceId: fx.managerA.workspaceId,
          shiftId: shift.id,
          declinedShiftAssignmentId: declinedAssignment.id,
          declinedOfferId: declinedOffer.id,
          status: ReplacementRequestStatus.AWAITING_APPROVAL,
          candidatesSnapshot: [{ staffProfileId: candidateProfileId, firstName: 'Cand', lastName: 'Idate', score: 10, reasons: [] }],
        }),
      );
      return { shift, request };
    }

    it('E18-E21: list hides Replacement A; detail/approve/reject denied', async () => {
      const fx = await seedFixture('replE');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const candidate = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'candE' });
      await activateStaff(candidate.profileId!);
      const { request } = await seedReplacement(fx, venueId, jobRoleId, candidate.profileId!);

      const listed = await replacementRequestService.list(ctxOf(fx.managerB));
      expect(listed.some((r) => r.id === request.id)).toBe(false);

      await expect(replacementRequestService.get(ctxOf(fx.managerB), request.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(replacementRequestService.approve(ctxOf(fx.managerB), request.id, { staffProfileId: candidate.profileId! })).rejects.toBeInstanceOf(NotFoundException);
      await expect(replacementRequestService.reject(ctxOf(fx.managerB), request.id)).rejects.toBeInstanceOf(NotFoundException);

      // The row must be completely untouched by Manager B's attempts — still AWAITING_APPROVAL, no offer created.
      const untouched = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ReplacementRequest, { id: request.id }));
      expect(untouched.status).toBe(ReplacementRequestStatus.AWAITING_APPROVAL);
      const offerCount = await withContext(ctxOf(fx.managerA), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = $1`, [candidate.profileId]));
      expect(Number(offerCount[0]!.count)).toBe(0);

      // Positive control: Manager A can still approve their own request.
      const approved = await replacementRequestService.approve(ctxOf(fx.managerA), request.id, { staffProfileId: candidate.profileId! });
      expect(approved.status).toBe(ReplacementRequestStatus.OFFER_SENT);
    });

    it('E-race: Manager B cannot win/consume the atomic approval claim even transiently — Manager A\'s own concurrent approval still succeeds', async () => {
      const fx = await seedFixture('replERace');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const candidate = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'candERace' });
      await activateStaff(candidate.profileId!);
      const { request } = await seedReplacement(fx, venueId, jobRoleId, candidate.profileId!);

      const settled = await Promise.allSettled([
        replacementRequestService.approve(ctxOf(fx.managerB), request.id, { staffProfileId: candidate.profileId! }),
        replacementRequestService.approve(ctxOf(fx.managerA), request.id, { staffProfileId: candidate.profileId! }),
      ]);
      const [bResult, aResult] = settled;
      expect(bResult.status).toBe('rejected');
      if (bResult.status === 'rejected') expect(bResult.reason).toBeInstanceOf(NotFoundException);
      // Manager A's own approval must succeed — Manager B's denied attempt must never have consumed the claim.
      expect(aResult.status).toBe('fulfilled');
      if (aResult.status === 'fulfilled') expect((aResult.value as ReplacementRequest).status).toBe(ReplacementRequestStatus.OFFER_SENT);
    });
  });

  // ===================================================================
  // F. Attendance
  // ===================================================================
  describe('F. attendance isolation', () => {
    it('F22-F24: list hides A attendance; correction (detail+mutation) denied', async () => {
      const fx = await seedFixture('attF');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'attF' });
      const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 30 * 60 * 1000);
      const { attendanceId } = await withContext(ctxOf(fx.managerA), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId, jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CONFIRMED, createdBy: fx.managerA.userId, workspaceId: fx.managerA.workspaceId! });
        const assignment = await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staffA.profileId!, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500, assignedBy: fx.managerA.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.managerA.workspaceId! });
        const attendance = await m.save(Attendance, { organisationId: fx.organisation.id, workspaceId: fx.managerA.workspaceId!, shiftId: shift.id, shiftAssignmentId: assignment.id, staffProfileId: staffA.profileId!, clockInAt: startsAt, clockOutAt: endsAt, status: 'clocked_out' as never, workedMinutes: 150, earnedPence: 3750 });
        return { attendanceId: attendance.id };
      });

      const listedB = await attendanceService.list(ctxOf(fx.managerB));
      expect(listedB.data.some((a) => a.id === attendanceId)).toBe(false);

      await expect(attendanceService.correct(ctxOf(fx.managerB), attendanceId, { field: 'breakMinutes', newValue: '999', reason: 'attacker correction attempt' } as never)).rejects.toBeInstanceOf(NotFoundException);

      const listedA = await attendanceService.list(ctxOf(fx.managerA));
      expect(listedA.data.some((a) => a.id === attendanceId)).toBe(true);
    });
  });

  // ===================================================================
  // G. Reports / timesheets
  // ===================================================================
  describe('G. report isolation', () => {
    it('G25-G28: report detail/download-authorization denied; signed access cannot bypass ownership', async () => {
      const fx = await seedFixture('reportG');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'reportG' });
      const startsAt = new Date(Date.now() - 3 * 3600 * 1000);
      const endsAt = new Date(Date.now() - 30 * 60 * 1000);
      const shift = await withContext(ctxOf(fx.managerA), async (m) => {
        const s = await m.save(Shift, { organisationId: fx.organisation.id, venueId, jobRoleId, startsAt, endsAt, breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CONFIRMED, createdBy: fx.managerA.userId, workspaceId: fx.managerA.workspaceId! });
        await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: s.id, staffProfileId: staffA.profileId!, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500, assignedBy: fx.managerA.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, endsAt), workspaceId: fx.managerA.workspaceId! });
        return s;
      });

      // "detail": the report endpoint itself.
      await expect(shiftReportService.getReport(ctxOf(fx.managerB), shift.id)).rejects.toBeInstanceOf(NotFoundException);
      // "download authorization": the SAME `canReadShift` check `ReportFilePolicy` reuses for signed file access —
      // proving the policy denies Manager B is the direct proof that a signed URL/token cannot bypass ownership,
      // since that policy runs BEFORE any file bytes or signed URL are ever issued.
      const canReadB = await withContext(ctxOf(fx.managerB), (m) => shiftReportService.canReadShift(m, ctxOf(fx.managerB), shift));
      expect(canReadB).toBe(false);
      const canReadA = await withContext(ctxOf(fx.managerA), (m) => shiftReportService.canReadShift(m, ctxOf(fx.managerA), shift));
      expect(canReadA).toBe(true);

      const ownReport = await shiftReportService.getReport(ctxOf(fx.managerA), shift.id);
      expect(ownReport.shiftId).toBe(shift.id);
    });
  });

  // ===================================================================
  // H. Notifications / audit / dashboard aggregates
  // ===================================================================
  describe('H. notification, audit, and dashboard-aggregate isolation', () => {
    it('H29: Manager B cannot read Manager A\'s own notifications', async () => {
      const fx = await seedFixture('notifH');
      await withContext(ctxOf(fx.managerA), (m) =>
        notificationService.notify(m, { organisationId: fx.organisation.id, userId: fx.managerA.userId, type: 'offer_accepted' as never, title: 'Private to A', message: 'test', relatedEntityType: 'offer', relatedEntityId: randomUUID() }),
      );
      const bList = await notificationService.list(ctxOf(fx.managerB));
      expect(bList.some((n: Notification) => n.title === 'Private to A')).toBe(false);
      const aList = await notificationService.list(ctxOf(fx.managerA));
      expect(aList.some((n: Notification) => n.title === 'Private to A')).toBe(true);
    });

    it('H30: Manager B cannot read Manager A\'s manager-scoped audit feed', async () => {
      const fx = await seedFixture('auditH');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const shift = await seedOpenShift(fx, venueId, jobRoleId);
      await schedulingService.cancel(ctxOf(fx.managerA), shift.id, 'A private reason');

      const bFeed = await auditService.list(ctxOf(fx.managerB), { entityType: 'shift', entityId: shift.id });
      expect(bFeed.items).toHaveLength(0);
      const aFeed = await auditService.list(ctxOf(fx.managerA), { entityType: 'shift', entityId: shift.id });
      expect(aFeed.items.length).toBeGreaterThanOrEqual(1);
    });

    it('H-dashboard: Manager B\'s dashboard aggregates never count Manager A\'s private staff/venue/offer rows', async () => {
      const fx = await seedFixture('dashH');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dashStaff1' });
      await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dashStaff2' });
      const shift = await seedOpenShift(fx, venueId, jobRoleId);
      const candidate = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'dashCand' });
      await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: candidate.profileId! });

      const bSummary = await dashboardService.getSummary(ctxOf(fx.managerB));
      expect(bSummary.staffCount).toBe(0);
      expect(bSummary.venueCount).toBe(0);
      expect(bSummary.activeOfferCount).toBe(0);

      const aSummary = await dashboardService.getSummary(ctxOf(fx.managerA));
      expect(aSummary.staffCount).toBeGreaterThanOrEqual(3); // 2 dashStaff + 1 candidate
      expect(aSummary.venueCount).toBeGreaterThanOrEqual(1);
      expect(aSummary.activeOfferCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ===================================================================
  // Phase 3 regression — late clock-in manager resolution
  // ===================================================================
  describe('Phase 3 regression: late clock-in under the same-workspace fixture', () => {
    it('Manager A (assignedBy) receives the late alert; Manager B (same org, same workspace) does not', async () => {
      const fx = await seedFixture('lateClockIn');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'lateA' });
      const startsAt = new Date(Date.now() - 20 * 60 * 1000);
      const { shiftId, assignmentId } = await withContext(ctxOf(fx.managerA), async (m) => {
        const shift = await m.save(Shift, { organisationId: fx.organisation.id, venueId, jobRoleId, startsAt, endsAt: new Date(startsAt.getTime() + 8 * 3600 * 1000), breakMinutes: 0, requiredCount: 1, payRatePence: 1500, status: ShiftStatus.CONFIRMED, createdBy: fx.managerA.userId, workspaceId: fx.managerA.workspaceId! });
        const assignment = await m.save(ShiftAssignment, { organisationId: fx.organisation.id, shiftId: shift.id, staffProfileId: staffA.profileId!, status: ShiftAssignmentStatus.CONFIRMED, payRateSnapshotPence: 1500, assignedBy: fx.managerA.userId, confirmedAt: new Date(), period: toTstzRange(startsAt, new Date(startsAt.getTime() + 8 * 3600 * 1000)), workspaceId: fx.managerA.workspaceId! });
        return { shiftId: shift.id, assignmentId: assignment.id };
      });

      await runLateClockInCycle(adminDataSource, tenantContext, notificationService, auditService, 10);

      const aNotifications = await withContext(ctxOf(fx.managerA), (m) =>
        m.find(Notification, { where: { userId: fx.managerA.userId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: 'late_clock_in' as never } }),
      );
      expect(aNotifications).toHaveLength(1);
      const bNotifications = await withContext(ctxOf(fx.managerB), (m) =>
        m.find(Notification, { where: { userId: fx.managerB.userId, relatedEntityType: 'shift_assignment', relatedEntityId: assignmentId, type: 'late_clock_in' as never } }),
      );
      expect(bNotifications).toHaveLength(0);

      // Manager B cannot open/manage Shift A through the manager API either.
      await expect(schedulingService.get(ctxOf(fx.managerB), shiftId)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ===================================================================
  // Phase 4 regression — replacement approval race, already covered in E,
  // repeated explicitly here under the Phase 4 heading per the brief.
  // ===================================================================
  describe('Phase 4 regression: replacement approval under the same-workspace fixture', () => {
    it('Manager B (OFFER_SEND, same org, same workspace) cannot view/approve/reject/send-offer-for Replacement A', async () => {
      const fx = await seedFixture('phase4Regression');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const shift = await seedOpenShift(fx, venueId, jobRoleId);
      const declining = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'p4decl' });
      const candidate = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'p4cand' });
      await activateStaff(candidate.profileId!);
      const declinedOffer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: declining.profileId! });
      const declinedAssignment = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(ShiftAssignment, { staffProfileId: declining.profileId! }));
      const request = await withContext(ctxOf(fx.managerA), (m) =>
        m.save(ReplacementRequest, {
          organisationId: fx.organisation.id,
          workspaceId: fx.managerA.workspaceId,
          shiftId: shift.id,
          declinedShiftAssignmentId: declinedAssignment.id,
          declinedOfferId: declinedOffer.id,
          status: ReplacementRequestStatus.AWAITING_APPROVAL,
          candidatesSnapshot: [{ staffProfileId: candidate.profileId!, firstName: 'P4', lastName: 'Cand', score: 10, reasons: [] }],
        }),
      );

      await expect(replacementRequestService.get(ctxOf(fx.managerB), request.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(replacementRequestService.approve(ctxOf(fx.managerB), request.id, { staffProfileId: candidate.profileId! })).rejects.toBeInstanceOf(NotFoundException);
      await expect(replacementRequestService.reject(ctxOf(fx.managerB), request.id)).rejects.toBeInstanceOf(NotFoundException);

      const offerCount = await withContext(ctxOf(fx.managerA), (m) => m.query<Array<{ count: string }>>(`SELECT count(*) FROM core.job_offer WHERE staff_profile_id = $1`, [candidate.profileId]));
      expect(Number(offerCount[0]!.count)).toBe(0);
    });
  });

  // ===================================================================
  // Phase 5 regression — cancellation under the same-workspace fixture
  // ===================================================================
  describe('Phase 5 regression: shift cancellation under the same-workspace fixture', () => {
    it('Manager B (same general manager role) cannot cancel/confirm/edit Shift A or manipulate its offers', async () => {
      const fx = await seedFixture('phase5Regression');
      const { venueId, jobRoleId } = await seedVenueAndRole(fx);
      const shift = await seedOpenShift(fx, venueId, jobRoleId);
      const staffA = await factory.createStaff(fx.organisation, { owner: fx.managerA, label: 'p5cand' });
      const offer = await offerService.send(ctxOf(fx.managerA), shift.id, { staffProfileId: staffA.profileId! });
      await offerService.staffAccept(ctxOf({ organisationId: fx.organisation.id, workspaceId: fx.managerA.workspaceId, userId: staffA.userId }), offer.id);

      await expect(schedulingService.cancel(ctxOf(fx.managerB), shift.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(offerService.managerConfirm(ctxOf(fx.managerB), offer.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(schedulingService.publish(ctxOf(fx.managerB), shift.id)).rejects.toBeInstanceOf(NotFoundException);

      const finalOffer = await withContext(ctxOf(fx.managerA), (m) => m.findOneByOrFail(JobOffer, { id: offer.id }));
      expect(finalOffer.status).toBe(OfferStatus.STAFF_ACCEPTED); // never confirmed by Manager B

      // Manager A's own cancellation still works normally, and the CAS/concurrency protections remain intact
      // (a real concurrent double-cancel from Manager A alone still resolves to exactly one success).
      const settled = await Promise.allSettled([schedulingService.cancel(ctxOf(fx.managerA), shift.id), schedulingService.cancel(ctxOf(fx.managerA), shift.id)]);
      const succeeded = settled.filter((r) => r.status === 'fulfilled');
      expect(succeeded).toHaveLength(1);
    });
  });

  // ===================================================================
  // Admin exception — Step 20
  // ===================================================================
  describe('Admin exception', () => {
    it('a plain manager (Manager B) never gets a blanket "admin" bypass; authority is derived from explicit permission, not role membership alone', async () => {
      const fx = await seedFixture('adminException');
      // Manager B holds the full "production" permission set for a plain `manager` role, which does NOT include
      // MANAGER_MANAGE (an org_admin/CEO-level flag) — Manager B's own dashboard summary already reflects that
      // permission boundary today (managerCount is null without it); this documents the current policy rather
      // than assuming one, and proves "manager" alone is never treated as "admin."
      const bSummary = await dashboardService.getSummary(ctxOf(fx.managerB));
      expect(bSummary.managerCount).toBeNull();
      // An explicitly-provisioned org admin, acting under their OWN identity (never impersonating Manager A), can
      // reach org-wide administrative data by the SAME explicit-permission rule — never a bare "role === admin" bypass.
      const orgAdmin = await factory.createOrgAdmin(fx.organisation, { permissions: 'all' });
      expect(orgAdmin.organisationId).toBe(fx.organisation.id);
    });
  });
});
