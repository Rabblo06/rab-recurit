import 'reflect-metadata';
import { EmploymentStatus, PermissionFlag, PermissionFlagType, ReplacementRequestStatus, ShiftAssignmentStatus, ShiftStatus } from '@rab/shared';
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { AttendanceService } from '../../modules/attendance/services/attendance.service';
import { OfferService } from '../../modules/offer/services/offer.service';
import { ReplacementRequest } from '../../modules/offer/entities/replacement-request.entity';
import { ReplacementRequestService } from '../../modules/offer/services/replacement-request.service';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

/**
 * SF-2 (docs/plans/untangle/server-modules.md M3), part 2: the layer-2 (service) re-check of the route's own flag on the
 * OfferService, ReplacementRequestService, SchedulingService and AttendanceService methods that relied on the route guard.
 *
 * Every call goes to the SERVICE directly (no PermissionGuard in the path), as a job, CLI command, AI tool or another service
 * reaches it. The actor lacking the flag is the SAME identity with a real per-user `revoke` override for that one flag, so a
 * refusal can only come from the new check. Each refusal must be a ForbiddenException AND leave the organisation's rows as
 * they were (audit log, notifications, realtime events, shifts, seats, offers, attendance, requested staff, replacement
 * requests). Real records are used where a refusal matters most (a pending and an accepted offer, an open and a pending
 * shift), plus unknown ids (403 either way: no existence oracle). Real PostgreSQL with RLS on (crewflow_app), no mocks.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SF-2 layer-2 re-checks: offers, replacement requests, scheduling, attendance (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let offers: OfferService;
  let replacements: ReplacementRequestService;
  let scheduling: SchedulingService;
  let attendance: AttendanceService;
  let orgId: string;
  let owner: TestIdentity; // Internal Manager, production permission set
  let vm: TestIdentity; // Venue Manager of venueId (requests shifts)
  let staff1: TestIdentity;
  let staff2: TestIdentity;
  let venueId: string;
  let jobRoleId: string;
  let openShiftId: string;
  let pendingRequestId: string; // a Venue Manager's shift request awaiting approval
  let replacementRequestId: string; // a real replacement request awaiting approval (staff1 declined, staff2 shortlisted)
  let pendingOffer: { id: string; offerBatchId: string };
  let acceptedOffer: { id: string; offerBatchId: string };

  const ctxOf = (who: TestIdentity, workspaceId: string | null = who.workspaceId): AuthContext => ({ organisationId: who.organisationId, workspaceId, userId: who.userId, role: '' });
  const staffCtx = (who: TestIdentity): AuthContext => ctxOf(who, owner.workspaceId);

  const bumpSecurityVersion = (identity: TestIdentity) =>
    admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

  /** Runs `fn` while `flag` is revoked for `identity` by a per-user override; the override is removed afterwards, whatever happens. */
  async function withRevoked<T>(identity: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    const inserted = (await admin.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3 RETURNING user_id`,
      [identity.userId, identity.organisationId, flag],
    )) as unknown[];
    if (inserted.length !== 1) throw new Error(`test setup: permission ${flag} is not in the catalogue`);
    await bumpSecurityVersion(identity);
    try {
      return await fn();
    } finally {
      await admin.query(
        `DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`,
        [identity.userId, flag],
      );
      await bumpSecurityVersion(identity);
    }
  }

  /** Everything a refused call could have written in this organisation, read as the fixture superuser (not narrowed by RLS). */
  async function snapshot(): Promise<Record<string, unknown>> {
    const ws = owner.workspaceId!;
    const t = (table: string) => businessTable(ws, table);
    const [row] = (await admin.query(
      `SELECT
         (SELECT count(*) FROM core.audit_log WHERE organisation_id = $1)::int AS audit,
         (SELECT count(*) FROM core.email_outbox WHERE organisation_id = $1)::int AS outbox,
         (SELECT count(*) FROM core.notification WHERE organisation_id = $1)::int AS notifications,
         (SELECT count(*) FROM core.realtime_event WHERE organisation_id = $1)::int AS realtime,
         (SELECT count(*) FROM ${t('job_role')} WHERE organisation_id = $1)::int AS job_roles,
         (SELECT json_agg(json_build_object('id', id, 'status', status, 'archived', archived_at) ORDER BY id) FROM ${t('shift')} WHERE organisation_id = $1) AS shifts,
         (SELECT json_agg(json_build_object('id', id, 'status', status) ORDER BY id) FROM ${t('shift_assignment')} WHERE organisation_id = $1) AS seats,
         (SELECT json_agg(json_build_object('id', id, 'status', status) ORDER BY id) FROM ${t('job_offer')} WHERE organisation_id = $1) AS offers,
         (SELECT count(*) FROM ${t('attendance')} WHERE organisation_id = $1)::int AS attendance,
         (SELECT count(*) FROM ${t('shift_request_staff')} WHERE organisation_id = $1)::int AS requested_staff,
         (SELECT json_agg(json_build_object('id', id, 'status', status) ORDER BY id) FROM ${t('replacement_request')} WHERE organisation_id = $1) AS replacement_requests`,
      [orgId],
    )) as Array<Record<string, unknown>>;
    return row!;
  }

  /** The call is refused with 403 and nothing in the organisation changed. */
  async function expectRefusedAndInert(call: () => Promise<unknown>): Promise<void> {
    const before = await snapshot();
    await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
    expect(await snapshot()).toEqual(before);
  }

  let shiftSeq = 0;
  async function seedShift(status: string, opts: { requestedBy?: string } = {}): Promise<string> {
    return tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      // A distinct day per shift: the same staff member gets offers on several of them, and overlapping offers are refused.
      const startsAt = new Date(Date.now() + (3 + shiftSeq++) * 24 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 6 * 3600 * 1000);
      const shift = await m.save(Shift, {
        organisationId: orgId, venueId, jobRoleId, startsAt, endsAt, defaultStartsAt: startsAt, defaultEndsAt: endsAt, breakMinutes: 0,
        requiredCount: 2, payRatePence: 1500, status, createdBy: owner.userId, requestedBy: opts.requestedBy ?? null, workspaceId: owner.workspaceId!,
      } as Partial<Shift>);
      return shift.id;
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app, dataSource: moduleRef.get(DataSource), adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService),
    });
    offers = moduleRef.get(OfferService);
    replacements = moduleRef.get(ReplacementRequestService);
    scheduling = moduleRef.get(SchedulingService);
    attendance = moduleRef.get(AttendanceService);

    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sf2b' });
    orgId = seeded.organisation.id;
    owner = seeded.managers[0]!;
    await tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      const v = await m.save(Venue, { organisationId: orgId, name: `SF2b Venue ${randomUUID().slice(0, 6)}`, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const jr = await m.save(JobRole, { organisationId: orgId, name: `SF2b Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      venueId = v.id;
      jobRoleId = jr.id;
    });
    vm = await factory.createVenueManager(seeded.organisation, { owner, venueIds: [venueId], label: 'sf2b-vm' });
    staff1 = await factory.createStaff(seeded.organisation, { owner, label: 'sf2b-s1' });
    staff2 = await factory.createStaff(seeded.organisation, { owner, label: 'sf2b-s2' });
    for (const s of [staff1, staff2]) {
      await tenantContext.runInTenantContext(ctxOf(owner), (m) => m.update(StaffProfile, { id: s.profileId! }, { employmentStatus: EmploymentStatus.ACTIVE }));
    }
    openShiftId = await seedShift(ShiftStatus.OPEN);
    const sent = await offers.send(ctxOf(owner), openShiftId, { staffProfileId: staff1.profileId! } as never);
    pendingOffer = { id: sent.id, offerBatchId: sent.offerBatchId! };
    const acceptedShiftId = await seedShift(ShiftStatus.OPEN);
    const toAccept = await offers.send(ctxOf(owner), acceptedShiftId, { staffProfileId: staff1.profileId! } as never);
    acceptedOffer = { id: toAccept.id, offerBatchId: toAccept.offerBatchId! };
    await offers.staffAccept(staffCtx(staff1), acceptedOffer.id);
    pendingRequestId = await seedShift(ShiftStatus.PENDING_MANAGER_APPROVAL, { requestedBy: vm.userId });
    // A real replacement request: staff1 declined a seat on its own shift; staff2 is the shortlisted candidate.
    const declinedShiftId = await seedShift(ShiftStatus.OPEN);
    replacementRequestId = await tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      const shift = await m.findOneByOrFail(Shift, { id: declinedShiftId });
      const seat = await m.save(ShiftAssignment, {
        organisationId: orgId, shiftId: shift.id, staffProfileId: staff1.profileId!, status: ShiftAssignmentStatus.DECLINED,
        payRateSnapshotPence: 1500, assignedBy: owner.userId, period: toTstzRange(shift.startsAt, shift.endsAt), workspaceId: owner.workspaceId!,
      } as Partial<ShiftAssignment>);
      const request = await m.save(ReplacementRequest, {
        organisationId: orgId, workspaceId: owner.workspaceId!, shiftId: shift.id, declinedShiftAssignmentId: seat.id,
        status: ReplacementRequestStatus.AWAITING_APPROVAL,
        candidatesSnapshot: [{ staffProfileId: staff2.profileId!, firstName: 'Cand', lastName: 'Two', score: 10, reasons: [] }],
      } as Partial<ReplacementRequest>);
      return request.id;
    });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ─────────────────────────────────────────────── reads (schedule.view)

  it('reads without schedule.view → 403 for real and unknown ids: offers, batches, shifts, job roles, requested staff, replacement requests', async () => {
    const ctx = ctxOf(owner);
    await withRevoked(owner, PermissionFlag.SCHEDULE_VIEW, async () => {
      await expectRefusedAndInert(() => offers.list(ctx));
      await expectRefusedAndInert(() => scheduling.list(ctx));
      await expectRefusedAndInert(() => scheduling.listJobRoles(ctx));
      await expectRefusedAndInert(() => replacements.list(ctx));
      for (const id of [pendingOffer.offerBatchId, randomUUID()]) await expectRefusedAndInert(() => offers.getBatch(ctx, id));
      for (const id of [openShiftId, randomUUID()]) {
        await expectRefusedAndInert(() => scheduling.get(ctx, id));
        await expectRefusedAndInert(() => scheduling.getRequestedStaff(ctx, id));
      }
      for (const id of [replacementRequestId, randomUUID()]) await expectRefusedAndInert(() => replacements.get(ctx, id));
    });
  });

  it('with schedule.view the same reads still work (behaviour unchanged)', async () => {
    const ctx = ctxOf(owner);
    expect((await scheduling.get(ctx, openShiftId)).id).toBe(openShiftId);
    expect((await offers.list(ctx)).data.map((o) => o.id)).toContain(pendingOffer.id);
    expect((await offers.getBatch(ctx, pendingOffer.offerBatchId)).batchId).toBe(pendingOffer.offerBatchId);
  });

  // ─────────────────────────────────────────────── manager writes

  it('sending without offer.send → 403: send, sendBulk, replacement approve / reject create no offer and change no request', async () => {
    const ctx = ctxOf(owner);
    await withRevoked(owner, PermissionFlag.OFFER_SEND, async () => {
      await expectRefusedAndInert(() => offers.send(ctx, openShiftId, { staffProfileId: staff2.profileId! } as never));
      await expectRefusedAndInert(() => offers.sendBulk(ctx, openShiftId, { staffProfileIds: [staff2.profileId!] } as never));
      // A real request awaiting approval (the request stays awaiting_approval, no offer is sent) and an unknown id alike.
      for (const id of [replacementRequestId, randomUUID()]) {
        await expectRefusedAndInert(() => replacements.approve(ctx, id, { staffProfileId: staff2.profileId! } as never));
        await expectRefusedAndInert(() => replacements.reject(ctx, id));
      }
    });
    // Control: with offer.send the request is still readable and awaiting approval (the refusals above changed nothing).
    expect((await replacements.get(ctx, replacementRequestId)).status).toBe(ReplacementRequestStatus.AWAITING_APPROVAL);
  });

  it('withdraw without offer.withdraw → 403, the pending offer stays pending', async () => {
    await withRevoked(owner, PermissionFlag.OFFER_WITHDRAW, () => expectRefusedAndInert(() => offers.withdraw(ctxOf(owner), pendingOffer.id)));
  });

  it('confirm / reject / confirm-all without offer.confirm → 403, the accepted offer and its seat are unchanged', async () => {
    const ctx = ctxOf(owner);
    await withRevoked(owner, PermissionFlag.OFFER_CONFIRM, async () => {
      await expectRefusedAndInert(() => offers.managerConfirm(ctx, acceptedOffer.id));
      await expectRefusedAndInert(() => offers.managerReject(ctx, acceptedOffer.id, { reason: 'not this time' } as never));
      await expectRefusedAndInert(() => offers.confirmAll(ctx, acceptedOffer.offerBatchId));
    });
  });

  it('request handling without staffing_request.approve → 403: the organisation-wide lists, approve, decline, add / remove requested staff', async () => {
    const ctx = ctxOf(owner);
    await withRevoked(owner, PermissionFlag.STAFFING_REQUEST_APPROVE, async () => {
      await expectRefusedAndInert(() => scheduling.listVenueOffers(ctx));
      await expectRefusedAndInert(() => scheduling.listPendingApprovals(ctx));
      await expectRefusedAndInert(() => offers.approveShiftRequest(ctx, pendingRequestId, {} as never));
      await expectRefusedAndInert(() => scheduling.declineRequest(ctx, pendingRequestId, { reason: 'no budget' } as never));
      await expectRefusedAndInert(() => scheduling.addRequestedStaff(ctx, pendingRequestId, staff2.profileId!));
      await expectRefusedAndInert(() => scheduling.removeRequestedStaff(ctx, pendingRequestId, staff2.profileId!));
    });
  });

  it('cancel and job-role creation without schedule.create → 403, the shift stays open and no job role is added', async () => {
    const ctx = ctxOf(owner);
    await withRevoked(owner, PermissionFlag.SCHEDULE_CREATE, async () => {
      await expectRefusedAndInert(() => scheduling.cancel(ctx, openShiftId, 'weather'));
      await expectRefusedAndInert(() => scheduling.createJobRole(ctx, { name: `SF2b New ${randomUUID().slice(0, 6)}`, defaultRatePence: 1200 } as never));
    });
  });

  it('the attendance register without attendance.view → 403', async () => {
    await withRevoked(owner, PermissionFlag.ATTENDANCE_VIEW, () => expectRefusedAndInert(() => attendance.list(ctxOf(owner))));
  });

  // ─────────────────────────────────────────────── staff app (offer.respond, attendance.clock)

  it('staff offer actions without offer.respond → 403: my offers, accept, decline leave the offer pending', async () => {
    const ctx = staffCtx(staff1);
    await withRevoked(staff1, PermissionFlag.OFFER_RESPOND, async () => {
      await expectRefusedAndInert(() => offers.listMine(ctx));
      await expectRefusedAndInert(() => offers.staffAccept(ctx, pendingOffer.id));
      await expectRefusedAndInert(() => offers.decline(ctx, pendingOffer.id, { reason: 'busy' } as never));
    });
    await expect(offers.listMine(ctx)).resolves.toEqual(expect.any(Array)); // control: with the flag
  });

  it('staff attendance without attendance.clock → 403: check-in, clock-in / out, geofence exit and every /me read write nothing', async () => {
    const ctx = staffCtx(staff1);
    const dto = { shiftId: openShiftId } as never;
    await withRevoked(staff1, PermissionFlag.ATTENDANCE_CLOCK, async () => {
      await expectRefusedAndInert(() => attendance.checkIn(ctx, dto));
      await expectRefusedAndInert(() => attendance.getCheckIn(ctx, openShiftId));
      await expectRefusedAndInert(() => attendance.clockIn(ctx, dto));
      await expectRefusedAndInert(() => attendance.clockOut(ctx, dto));
      await expectRefusedAndInert(() => attendance.autoClockOutOnGeofenceExit(ctx, dto));
      await expectRefusedAndInert(() => attendance.getActive(ctx));
      await expectRefusedAndInert(() => attendance.getHistory(ctx));
      await expectRefusedAndInert(() => attendance.getForShift(ctx, openShiftId));
    });
    await expect(attendance.getActive(ctx)).resolves.toMatchObject({ serverNow: expect.any(String) }); // control: with the flag
  });

  // ─────────────────────────────────────────────── HTTP path unchanged

  it('HTTP behaviour is unchanged: the route guard answers 403 first, 200 with the flag', async () => {
    const http = () => request(app.getHttpServer());
    const token = await factory.login(owner);
    await withRevoked(owner, PermissionFlag.SCHEDULE_VIEW, async () => {
      expect((await http().get(`/rest/v1/shifts/${openShiftId}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
    });
    expect((await http().get(`/rest/v1/shifts/${openShiftId}`).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await http().get('/rest/v1/offers').set('Authorization', `Bearer ${token}`)).status).toBe(200);
  });
});
