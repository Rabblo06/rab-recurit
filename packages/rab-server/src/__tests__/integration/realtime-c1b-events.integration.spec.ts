/**
 * Phase C1b — the realtime event catalogue end to end at the database: each new event is written to
 * `core.realtime_event` by its REAL committed transition, in the SAME transaction (none on rollback), one row per
 * recipient computed server-side from current scope, with an ids-only payload — and never addressed to anyone outside
 * that scope (another venue's manager, another workspace's people, another organisation). Real Postgres, RLS on.
 *
 * `REALTIME_ENABLED` is set BEFORE ANY import (the config snapshot is taken at import time — see
 * realtime-gateway.integration.spec.ts). The flag-OFF behaviour (nothing written) is pinned by
 * realtime-event.service.spec.ts and realtime-push-gating.integration.spec.ts.
 */
process.env.REALTIME_ENABLED = 'true';

import 'reflect-metadata';
import { EmploymentStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RealtimeEventService } from '../../engine/core-modules/realtime/realtime-event.service';
import * as recipientsModule from '../../engine/core-modules/realtime/realtime-recipients';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { OfferService } from '../../modules/offer/services/offer.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { AttendanceService } from '../../modules/attendance/services/attendance.service';
import { Attendance } from '../../modules/attendance/entities/attendance.entity';
import { NotificationService } from '../../modules/notification/services/notification.service';
import { PayrollService } from '../../modules/payroll/services/payroll.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

/** Payload keys an event may carry — ids/routing only. Anything else (names, reasons, amounts, times) is a leak. */
const ALLOWED_PAYLOAD_KEYS = new Set(['shiftId', 'staffProfileId', 'offerBatchId', 'offerKind']);

describeIfDb('C1b realtime event catalogue — outbox rows, recipients, privacy (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let admin: DataSource;
  let tenantContext: TenantContextService;
  let offers: OfferService;
  let scheduling: SchedulingService;
  let attendance: AttendanceService;
  let notifications: NotificationService;
  let payroll: PayrollService;
  let realtime: RealtimeEventService;
  let factory: TestIdentityFactory;

  // One world, reused by every test (each test makes its own shifts/offers).
  let org: { id: string };
  let owner: TestIdentity; // internal manager who owns the workspace, the venue and the shifts
  let approver2: TestIdentity; // another internal manager of the same organisation (own workspace)
  let vm: TestIdentity; // venue manager of `venueId`
  let vm2: TestIdentity; // a second venue manager of `venueId`
  let otherVm: TestIdentity; // venue manager of a DIFFERENT venue (same workspace)
  let staff1: TestIdentity;
  let staff2: TestIdentity;
  let foreignManager: TestIdentity; // another organisation entirely
  let foreignStaff: TestIdentity;
  let venueId: string;
  let otherVenueId: string;
  let jobRoleId: string;

  const ctxOf = (who: TestIdentity, workspaceId: string | null = who.workspaceId): AuthContext => ({ organisationId: who.organisationId, workspaceId, userId: who.userId, role: '' });
  const staffCtx = (who: TestIdentity): AuthContext => ctxOf(who, owner.workspaceId);

  async function rows(entityId: string, eventType: string): Promise<Array<{ target_user_id: string; workspace_id: string | null; payload: Record<string, unknown>; organisation_id: string; event_key: string }>> {
    return admin.query(`SELECT target_user_id, workspace_id, payload, organisation_id, event_key FROM core.realtime_event WHERE entity_id = $1 AND event_type = $2`, [entityId, eventType]);
  }
  async function recipients(entityId: string, eventType: string): Promise<string[]> {
    return (await rows(entityId, eventType)).map((r) => r.target_user_id).sort();
  }
  const ids = (...who: TestIdentity[]) => who.map((w) => w.userId).sort();
  function expectIdsOnly(list: Array<{ payload: Record<string, unknown>; organisation_id: string }>): void {
    for (const r of list) {
      expect(r.organisation_id).toBe(org.id);
      for (const key of Object.keys(r.payload ?? {})) expect(ALLOWED_PAYLOAD_KEYS.has(key)).toBe(true);
    }
  }
  /** Nobody outside the computed scope ever appears as a recipient. */
  async function expectNoneOutsideScope(entityId: string, eventType: string): Promise<void> {
    const got = await recipients(entityId, eventType);
    for (const outsider of [otherVm, foreignManager, foreignStaff]) expect(got).not.toContain(outsider.userId);
  }

  async function activate(staff: TestIdentity): Promise<void> {
    await tenantContext.runInTenantContext(ctxOf(owner), (m) => m.update(StaffProfile, { id: staff.profileId! }, { employmentStatus: EmploymentStatus.ACTIVE }));
  }

  let shiftSeq = 0;
  async function seedShift(status: string, opts: { requestedBy?: string; createdBy?: string } = {}): Promise<string> {
    return tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      // A distinct day per shift: the same staff member gets offers on several of them, and overlapping offers are refused.
      const startsAt = new Date(Date.now() + (3 + shiftSeq++) * 24 * 3600 * 1000);
      const endsAt = new Date(startsAt.getTime() + 6 * 3600 * 1000);
      const shift = await m.save(Shift, {
        organisationId: org.id, venueId, jobRoleId, startsAt, endsAt, defaultStartsAt: startsAt, defaultEndsAt: endsAt, breakMinutes: 0,
        requiredCount: 3, payRatePence: 1500, status, createdBy: opts.createdBy ?? owner.userId, requestedBy: opts.requestedBy ?? null, workspaceId: owner.workspaceId!,
      } as Partial<Shift>);
      return shift.id;
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    offers = moduleRef.get(OfferService);
    scheduling = moduleRef.get(SchedulingService);
    attendance = moduleRef.get(AttendanceService);
    notifications = moduleRef.get(NotificationService);
    payroll = moduleRef.get(PayrollService);
    realtime = moduleRef.get(RealtimeEventService);
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource: admin, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'c1rt' });
    org = seeded.organisation;
    owner = seeded.managers[0]!;
    approver2 = seeded.managers[1]!;
    await tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      const v = await m.save(Venue, { organisationId: org.id, name: `C1 RT Venue ${randomUUID().slice(0, 6)}`, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const v2 = await m.save(Venue, { organisationId: org.id, name: `C1 RT Other ${randomUUID().slice(0, 6)}`, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      const jr = await m.save(JobRole, { organisationId: org.id, name: `C1 RT Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: owner.userId, workspaceId: owner.workspaceId! });
      venueId = v.id;
      otherVenueId = v2.id;
      jobRoleId = jr.id;
    });
    vm = await factory.createVenueManager(org, { owner, venueIds: [venueId], label: 'c1rt-vm' });
    vm2 = await factory.createVenueManager(org, { owner, venueIds: [venueId], label: 'c1rt-vm2' });
    otherVm = await factory.createVenueManager(org, { owner, venueIds: [otherVenueId], label: 'c1rt-othervm' });
    staff1 = await factory.createStaff(org, { owner, label: 'c1rt-s1' });
    staff2 = await factory.createStaff(org, { owner, label: 'c1rt-s2' });
    await activate(staff1);
    await activate(staff2);
    const foreign = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'c1rt-foreign' });
    foreignManager = foreign.managers[0]!;
    foreignStaff = await factory.createStaff(foreign.organisation, { owner: foreignManager, label: 'c1rt-fs' });
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  // ------------------------------------------------------------------------------------------- offers

  it('offer.declined — staff declines: the staff member, the sender/owner and BOTH managers of that venue; nobody else; ids only', async () => {
    const shiftId = await seedShift('open');
    const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff1.profileId! });
    await offers.decline(staffCtx(staff1), offer.id, { reason: 'Cannot make it that day, sorry' } as never);

    expect(await recipients(offer.id, 'offer.declined')).toEqual(ids(staff1, owner, vm, vm2));
    const list = await rows(offer.id, 'offer.declined');
    expectIdsOnly(list);
    expect(JSON.stringify(list)).not.toContain('Cannot make it'); // the free-text reason never enters the outbox
    expect(list.every((r) => r.workspace_id === owner.workspaceId)).toBe(true);
    await expectNoneOutsideScope(offer.id, 'offer.declined');
  });

  it('offer.withdrawn — manager withdraws a pending offer', async () => {
    const shiftId = await seedShift('open');
    const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff1.profileId! });
    await offers.withdraw(ctxOf(owner), offer.id);
    expect(await recipients(offer.id, 'offer.withdrawn')).toEqual(ids(staff1, owner, vm, vm2));
    expectIdsOnly(await rows(offer.id, 'offer.withdrawn'));
  });

  it('offer.rejected — manager declines the staff member’s acceptance; the reason is not in the outbox', async () => {
    const shiftId = await seedShift('open');
    const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff2.profileId! });
    await offers.staffAccept(staffCtx(staff2), offer.id);
    await offers.managerReject(ctxOf(owner), offer.id, { reason: 'Secret internal reason text' } as never);
    const list = await rows(offer.id, 'offer.rejected');
    expect(list.map((r) => r.target_user_id).sort()).toEqual(ids(staff2, owner, vm, vm2));
    expect(JSON.stringify(list)).not.toContain('Secret internal');
    expectIdsOnly(list);
  });

  it('offer.expired — the staff member’s accept arrives after expiry: the claimed expiry commits its event (409 to the caller)', async () => {
    const shiftId = await seedShift('open');
    const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff1.profileId! });
    await admin.query(`UPDATE core.job_offer SET expires_at = now() - interval '1 minute' WHERE id = $1`, [offer.id]);
    await expect(offers.staffAccept(staffCtx(staff1), offer.id)).rejects.toThrow(/expired/i);
    expect(await recipients(offer.id, 'offer.expired')).toEqual(ids(staff1, owner, vm, vm2));
  });

  it('rollback: a cancellation whose transaction rolls back leaves no event and no state change', async () => {
    const shiftId = await seedShift('open');
    const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff1.profileId! });
    await expect(
      tenantContext.runInWorkspaceContext(ctxOf(owner), async (m) => {
        const shift = await m.findOneByOrFail(Shift, { id: shiftId });
        await offers.cancelBookingWithManager(m, ctxOf(owner), shift, offer.id);
        throw new Error('roll back after the emit');
      }),
    ).rejects.toThrow('roll back after the emit');
    expect(await rows(offer.id, 'offer.withdrawn')).toHaveLength(0);
    const [state] = await admin.query(`SELECT status FROM core.job_offer WHERE id = $1`, [offer.id]);
    expect(state.status).toBe('pending');
  });

  // ------------------------------------------------------------------------------------------- shifts

  it('shift.updated — publishing a draft: the owner and the venue’s managers (not another venue’s)', async () => {
    const shiftId = await seedShift('draft');
    await scheduling.publish(ctxOf(owner), shiftId);
    expect(await recipients(shiftId, 'shift.updated')).toEqual(ids(owner, vm, vm2));
    await expectNoneOutsideScope(shiftId, 'shift.updated');
  });

  it('shift.cancelled — owner, venue managers and every staff member holding a live seat; not a staff member without one', async () => {
    const shiftId = await seedShift('open');
    await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff1.profileId! });
    await scheduling.cancel(ctxOf(owner), shiftId, 'Venue flooded — private note');
    const list = await rows(shiftId, 'shift.cancelled');
    expect(list.map((r) => r.target_user_id).sort()).toEqual(ids(owner, vm, vm2, staff1));
    expect(JSON.stringify(list)).not.toContain('flooded');
    expect(list.map((r) => r.target_user_id)).not.toContain(staff2.userId);
  });

  // ---------------------------------------------------------------------------------- shift requests

  // Approvers are the SAME set `SchedulingService.listApprovers` notifies — and `manager_profile` RLS limits that set to
  // what the acting transaction can see: approvers in THIS workspace (an Internal Manager of another workspace sees neither
  // the request nor its notification today — see `listVenueOffers`' PERF-01 note). The event never widens that.
  it('shift_request.created → visible approvers (workspace NULL) and the venue’s managers; declined → the same audience; never another workspace', async () => {
    await admin.query(`INSERT INTO core.venue_manager_staff (manager_profile_id, staff_profile_id, organisation_id, workspace_id) VALUES ($1, $2, $3, $4)`, [vm.profileId, staff1.profileId, org.id, owner.workspaceId]);
    const startsAt = new Date(Date.now() + 60 * 24 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 5 * 3600 * 1000);
    const shift = await scheduling.submitRequest(ctxOf(vm), { venueId, jobRoleId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), staffRequired: 1, staffProfileIds: [staff1.profileId!] } as never);

    const created = await rows(shift.id, 'shift_request.created');
    expect(created.map((r) => r.target_user_id).sort()).toEqual(ids(vm, vm2, owner));
    expect(created.find((r) => r.target_user_id === owner.userId)!.workspace_id).toBeNull(); // approver rows are org-wide (their session may be another workspace)
    expect(created.map((r) => r.target_user_id)).not.toContain(approver2.userId); // invisible under RLS → not told
    expect(created.find((r) => r.target_user_id === vm2.userId)!.workspace_id).toBe(owner.workspaceId);
    await expectNoneOutsideScope(shift.id, 'shift_request.created');
    expect(created.map((r) => r.target_user_id)).not.toContain(staff1.userId);

    await scheduling.declineRequest(ctxOf(owner), shift.id, { reason: 'No budget this week' } as never);
    const declined = await rows(shift.id, 'shift_request.declined');
    expect(declined.map((r) => r.target_user_id).sort()).toEqual(ids(vm, vm2, owner));
    expect(JSON.stringify(declined)).not.toContain('budget');
  });

  it('shift_request.approved → requester, new owner (the approver) and the venue managers', async () => {
    const shiftId = await seedShift('pending_manager_approval', { requestedBy: vm.userId, createdBy: vm.userId });
    await admin.query(
      `INSERT INTO core.shift_request_staff (organisation_id, workspace_id, shift_id, staff_profile_id, starts_at, ends_at) SELECT organisation_id, workspace_id, id, $2, starts_at, ends_at FROM core.shift WHERE id = $1`,
      [shiftId, staff2.profileId],
    );
    await offers.approveShiftRequest(ctxOf(owner), shiftId, {} as never);
    expect(await recipients(shiftId, 'shift_request.approved')).toEqual(ids(vm, vm2, owner));
  });

  // -------------------------------------------------------------------------------------- attendance

  it('attendance.changed — a clock-out: the staff member, the shift owner and the venue’s managers; ids only (no times, minutes or pay)', async () => {
    const shiftId = await seedShift('open');
    const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: staff2.profileId! });
    await offers.staffAccept(staffCtx(staff2), offer.id);
    await offers.managerConfirm(ctxOf(owner), offer.id);
    const [assignment] = await admin.query(`SELECT id FROM core.shift_assignment WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, staff2.profileId]);
    const [att] = await admin.query(
      `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, status, location_verified, clock_in_method)
       VALUES ($1, $2, $3, $4, $5, now() - interval '2 hours', 'clocked_in', false, 'staff') RETURNING id`,
      [org.id, owner.workspaceId, assignment.id, shiftId, staff2.profileId],
    );
    await tenantContext.runInWorkspaceContext(ctxOf(owner), async (m) => {
      const entity = await m.findOneByOrFail(Attendance, { id: att.id });
      // The shared clock-out funnel (staff, geofence and on-behalf clock-outs all go through it).
      await (attendance as unknown as { performClockOut: (...a: unknown[]) => Promise<unknown> }).performClockOut(m, ctxOf(owner), entity, {}, false, 'manager_on_behalf', { by: owner.userId, reason: 'c1 realtime test clock out on behalf' });
    });
    const list = await rows(att.id, 'attendance.changed');
    expect(list.map((r) => r.target_user_id).sort()).toEqual(ids(staff2, owner, vm, vm2));
    expect(list.every((r) => Object.keys(r.payload ?? {}).length === 0)).toBe(true);

    // ------------------------------------------------------------------------------------ payroll
    const [record] = await admin.query(
      `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
       VALUES ($1, $2, $3, $4, $5, 'pending_approval', 120, 1500, 3000) RETURNING id`,
      [org.id, owner.workspaceId, att.id, shiftId, staff2.profileId],
    );
    await payroll.reject(ctxOf(owner), record.id, 'Hours disputed by the venue');
    const payrollRows = await rows(record.id, 'payroll.record_changed');
    // Only payroll readers of THIS workspace: the owner. Never a venue manager, the staff member or another workspace's manager.
    expect(payrollRows.map((r) => r.target_user_id).sort()).toEqual(ids(owner));
    expect(JSON.stringify(payrollRows)).not.toMatch(/3000|1500|disputed/);
  });

  // ----------------------------------------------------------------------------------- notifications

  it('notification.created — exactly the notification’s recipient, workspace NULL, no title/message in the outbox', async () => {
    const entryIds = await tenantContext.runInTenantContext(ctxOf(owner), async (m) => {
      await notifications.notify(m, { organisationId: org.id, userId: staff1.userId, type: 'offer_sent', title: 'Private title', message: 'Private message body' });
      return m.query(`SELECT id FROM core.notification WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [staff1.userId]);
    });
    const list = await rows(entryIds[0].id, 'notification.created');
    expect(list.map((r) => r.target_user_id)).toEqual([staff1.userId]);
    expect(list[0]!.workspace_id).toBeNull();
    expect(JSON.stringify(list)).not.toMatch(/Private/);
  });

  // --------------------------------------------------------------------------- review F6 / F8 (Lows)

  it('F6: a suspended or deleted user never gets an outbox row, whichever audience named them', async () => {
    const suspended = await factory.createStaff(org, { owner, label: 'c1rt-f6-susp' });
    const deleted = await factory.createStaff(org, { owner, label: 'c1rt-f6-del' });
    await admin.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [suspended.userId]);
    await admin.query(`UPDATE core."user" SET deleted_at = now() WHERE id = $1`, [deleted.userId]);
    const entityId = randomUUID();
    await tenantContext.runInWorkspaceContext(ctxOf(owner), (m) =>
      realtime.recordForRecipients(m, { organisationId: org.id, eventKey: `shift.updated:${entityId}`, eventType: 'shift.updated', entityType: 'shift', entityId }, async () => [
        { userId: owner.userId, workspaceId: owner.workspaceId },
        { userId: suspended.userId, workspaceId: owner.workspaceId },
        { userId: deleted.userId, workspaceId: owner.workspaceId },
      ]),
    );
    expect(await recipients(entityId, 'shift.updated')).toEqual(ids(owner));
  });

  it('F6: a suspended staff member with a live seat is not told the shift was cancelled', async () => {
    const shiftId = await seedShift('open');
    const s3 = await factory.createStaff(org, { owner, label: 'c1rt-f6-seat' });
    await activate(s3);
    await offers.send(ctxOf(owner), shiftId, { staffProfileId: s3.profileId! });
    await admin.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [s3.userId]);
    await scheduling.cancel(ctxOf(owner), shiftId);
    expect(await recipients(shiftId, 'shift.cancelled')).toEqual(ids(owner, vm, vm2));
  });

  it('F8: bulk approve of N payroll records resolves the payroll audience ONCE and still emits one event per record', async () => {
    const recordIds: string[] = [];
    for (const who of [staff1, staff2, staff1]) {
      const shiftId = await seedShift('open');
      const offer = await offers.send(ctxOf(owner), shiftId, { staffProfileId: who.profileId! });
      await offers.staffAccept(staffCtx(who), offer.id);
      await offers.managerConfirm(ctxOf(owner), offer.id);
      const [assignment] = await admin.query(`SELECT id FROM core.shift_assignment WHERE shift_id = $1 AND staff_profile_id = $2`, [shiftId, who.profileId]);
      const [att] = await admin.query(
        `INSERT INTO core.attendance (organisation_id, workspace_id, shift_assignment_id, shift_id, staff_profile_id, clock_in_at, clock_out_at, status, location_verified, clock_in_method, worked_minutes, earned_pence)
         VALUES ($1, $2, $3, $4, $5, now() - interval '3 hours', now() - interval '1 hour', 'approved', false, 'staff', 120, 3000) RETURNING id`,
        [org.id, owner.workspaceId, assignment.id, shiftId, who.profileId],
      );
      const [record] = await admin.query(
        `INSERT INTO core.payroll_record (organisation_id, workspace_id, attendance_id, shift_id, staff_profile_id, status, worked_minutes, pay_rate_pence, amount_pence)
         VALUES ($1, $2, $3, $4, $5, 'pending_approval', 120, 1500, 3000) RETURNING id`,
        [org.id, owner.workspaceId, att.id, shiftId, who.profileId],
      );
      recordIds.push(record.id);
    }
    const audienceSpy = jest.spyOn(recipientsModule, 'payrollAudience');
    try {
      const result = await payroll.bulkApprove(ctxOf(owner), recordIds);
      expect(result.approved).toHaveLength(3);
      expect(audienceSpy).toHaveBeenCalledTimes(1);
    } finally {
      audienceSpy.mockRestore();
    }
    for (const id of recordIds) expect(await recipients(id, 'payroll.record_changed')).toEqual(ids(owner));
  });

  // ------------------------------------------------------------------------------------- mechanism

  it('recordForRecipients is atomic with its transaction and never trusts a recipient outside the bound workspace (written NULL, still one target)', async () => {
    const entityId = randomUUID();
    await expect(
      tenantContext.runInWorkspaceContext(ctxOf(owner), async (m) => {
        await realtime.recordForRecipients(m, { organisationId: org.id, eventKey: `shift.updated:${entityId}`, eventType: 'shift.updated', entityType: 'shift', entityId }, async () => [{ userId: owner.userId, workspaceId: owner.workspaceId }]);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    expect(await rows(entityId, 'shift.updated')).toHaveLength(0);

    await tenantContext.runInWorkspaceContext(ctxOf(owner), (m) =>
      realtime.recordForRecipients(m, { organisationId: org.id, eventKey: `shift.updated:${entityId}`, eventType: 'shift.updated', entityType: 'shift', entityId }, async () => [
        { userId: owner.userId, workspaceId: owner.workspaceId },
        { userId: approver2.userId, workspaceId: approver2.workspaceId }, // a different workspace than the bound one
        { userId: owner.userId, workspaceId: owner.workspaceId }, // duplicate → one row
      ]),
    );
    const list = await rows(entityId, 'shift.updated');
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.target_user_id === owner.userId)!.workspace_id).toBe(owner.workspaceId);
    expect(list.find((r) => r.target_user_id === approver2.userId)!.workspace_id).toBeNull();
    await expect(
      tenantContext.runInWorkspaceContext(ctxOf(owner), (m) =>
        realtime.recordForRecipients(m, { organisationId: org.id, eventKey: `x:${entityId}`, eventType: 'made.up', entityType: 'shift', entityId }, async () => []),
      ),
    ).rejects.toThrow(/Unknown realtime event type/);
  });
});
