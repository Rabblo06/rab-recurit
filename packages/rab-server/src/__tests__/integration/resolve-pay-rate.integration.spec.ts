import 'reflect-metadata';
import { EmploymentStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { OfferService } from '../../modules/offer/services/offer.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { PAY_RATE_REQUIRED_CODE, PAY_RATE_REQUIRED_MESSAGE } from '../../modules/scheduling/utils/pay-rate-rules';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTableOf, siblingTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Rate resolution against the real database (architecture §1 A6, CLAUDE.md "Rate resolution is snapshotted at
 * confirmation ... never recalculated later"). Every level that exists today, through the real create path:
 * explicit rate → venue role rate in force at the shift start (latest effective_from wins; a rate not yet in force or
 * already ended is ignored) → job role default. Then the snapshot rule: once a seat is confirmed, adding, changing or
 * deleting venue rates and changing the job role default never changes that shift's rate or the seat's
 * `pay_rate_snapshot_pence`; only shifts created afterwards see the new rate. (The staff role rate is applied per seat:
 * PR #311.)
 *
 * Owner decisions (decided 2026-11-22): 39 — a shift whose rate resolves to £0 is refused on create, publish and
 * create-and-send (409 PAY_RATE_REQUIRED, "Set a pay rate for this role first."); 40 — a rate period is judged on the shift
 * start's ORGANISATION-LOCAL date (core.organisation.timezone), end date inclusive.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Rate resolution and the confirmation snapshot (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let scheduling: SchedulingService;
  let venues: VenueService;
  let offers: OfferService;
  let a: TestIdentity;
  let ctxA: AuthContext;
  let venueId: string;
  let worker: TestIdentity;

  const ctxOf = (id: TestIdentity): AuthContext => ({ organisationId: id.organisationId, workspaceId: id.workspaceId, userId: id.userId, role: '' });
  const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
  let shiftDay = 5;
  const newShift = async (jobRoleId: string, extra: Record<string, unknown> = {}) => {
    const start = new Date(Date.now() + shiftDay++ * 86_400_000);
    return scheduling.create(ctxA, {
      venueId,
      jobRoleId,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 6 * 3_600_000).toISOString(),
      requiredCount: 1,
      ...extra,
    } as never);
  };
  const newRole = async (defaultRatePence: number) =>
    (await scheduling.createJobRole(ctxA, { name: `Rate Role ${randomUUID().slice(0, 8)}`, defaultRatePence } as never)).id;
  const shiftRate = async (shiftId: string) =>
    (await admin.query(`SELECT pay_rate_pence FROM ${await businessTableOf(admin, 'shift', shiftId)} WHERE id = $1`, [shiftId]))[0].pay_rate_pence as string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    admin = createAdminDataSource();
    await admin.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: admin,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    scheduling = moduleRef.get(SchedulingService);
    venues = moduleRef.get(VenueService);
    offers = moduleRef.get(OfferService);
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'rates' });
    a = seeded.managers[0]!;
    ctxA = ctxOf(a);
    venueId = (await venues.create(ctxA, { name: `Rate Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    worker = await factory.createStaff(seeded.organisation, { owner: a });
    await admin.query(`UPDATE ${await businessTableOf(admin, 'staff_profile', worker.profileId)} SET employment_status = $2 WHERE id = $1`, [worker.profileId, EmploymentStatus.ACTIVE]);
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('job role default when no venue rate exists', async () => {
    const role = await newRole(1400);
    expect(await shiftRate((await newShift(role)).id)).toBe('1400');
  });

  it('venue role rate in force beats the default; the latest effective_from wins; future and ended rates are ignored', async () => {
    const role = await newRole(1400);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2000, effectiveFrom: day(-60) } as never);
    expect(await shiftRate((await newShift(role)).id)).toBe('2000');
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2200, effectiveFrom: day(-10) } as never);
    expect(await shiftRate((await newShift(role)).id)).toBe('2200');
    // Not yet in force at the shift start (starts after every test shift) and already ended: neither applies.
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 9000, effectiveFrom: day(400) } as never);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 8000, effectiveFrom: day(-5), effectiveTo: day(-2) } as never);
    expect(await shiftRate((await newShift(role)).id)).toBe('2200');
  });

  it('a venue rate for another job role never applies', async () => {
    const role = await newRole(1500);
    const other = await newRole(1500);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: other, payRatePence: 3000, effectiveFrom: day(-30) } as never);
    expect(await shiftRate((await newShift(role)).id)).toBe('1500');
  });

  it('an explicit rate beats the venue rate and the default', async () => {
    const role = await newRole(1400);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2000, effectiveFrom: day(-30) } as never);
    expect(await shiftRate((await newShift(role, { payRatePence: 1777 })).id)).toBe('1777');
  });

  it('snapshot: after confirmation no rate change reprices the shift or the confirmed seat; only new shifts see it', async () => {
    const role = await newRole(1400);
    const rate = await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2100, effectiveFrom: day(-30) } as never);
    const shift = await newShift(role);
    await scheduling.publish(ctxA, shift.id);
    const offer = await offers.send(ctxA, shift.id, { staffProfileId: worker.profileId! } as never);
    await offers.staffAccept(ctxOf(worker), offer.id);
    await offers.managerConfirm(ctxA, offer.id);
    const seatTable = siblingTable(await businessTableOf(admin, 'shift', shift.id), 'shift_assignment');
    const seat = async () =>
      (await admin.query(`SELECT status, pay_rate_snapshot_pence FROM ${seatTable} WHERE shift_id = $1 AND staff_profile_id = $2`, [shift.id, worker.profileId]))[0] as {
        status: string;
        pay_rate_snapshot_pence: string;
      };
    expect(await seat()).toEqual({ status: 'confirmed', pay_rate_snapshot_pence: '2100' });

    // Every kind of later rate change: a new, later rate; an edit of the rate used; its deletion; a new role default.
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2600, effectiveFrom: day(-1) } as never);
    await venues.updateRoleRate(ctxA, venueId, rate.id, { payRatePence: 2400 } as never);
    await venues.deleteRoleRate(ctxA, venueId, rate.id);
    await admin.query(`UPDATE ${siblingTable(await businessTableOf(admin, 'shift', shift.id), 'job_role')} SET default_rate_pence = 1900 WHERE id = $1`, [role]);

    expect(await shiftRate(shift.id)).toBe('2100');
    expect(await seat()).toEqual({ status: 'confirmed', pay_rate_snapshot_pence: '2100' });
    expect(await shiftRate((await newShift(role)).id)).toBe('2600'); // a shift created now resolves the new rate
  });

  // ---------------------------------------------------------------------------------------------- decision 39 (£0 refused)

  it('decision 39: creating a shift whose rate resolves to £0 is refused (service and HTTP 409 PAY_RATE_REQUIRED); nothing is inserted', async () => {
    const role = await newRole(0);
    await expect(newShift(role)).rejects.toMatchObject({ status: 409, response: { code: PAY_RATE_REQUIRED_CODE, message: PAY_RATE_REQUIRED_MESSAGE } });
    await expect(newShift(await newRole(1400), { payRatePence: 0 })).rejects.toMatchObject({ status: 409 }); // an explicit 0 too
    const start = new Date(Date.now() + 40 * 86_400_000);
    const res = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${await factory.login(a)}`)
      .send({ venueId, jobRoleId: role, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString(), requiredCount: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: PAY_RATE_REQUIRED_CODE, message: PAY_RATE_REQUIRED_MESSAGE });
    // A venue rate for the role fixes it: the same create now succeeds at that rate.
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 1650, effectiveFrom: day(-10) } as never);
    expect(await shiftRate((await newShift(role)).id)).toBe('1650');
    const shiftTable = siblingTable(await businessTableOf(admin, 'venue', venueId), 'shift');
    expect(Number((await admin.query(`SELECT count(*)::int AS n FROM ${shiftTable} WHERE job_role_id = $1`, [role]))[0].n)).toBe(1);
  });

  it('decision 39: create-and-send with a £0 rate is refused before any shift or offer exists', async () => {
    const role = await newRole(0);
    const start = new Date(Date.now() + 41 * 86_400_000);
    await expect(
      offers.createShiftAndSend(ctxA, {
        venueId,
        jobRoleId: role,
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + 4 * 3_600_000).toISOString(),
        requiredCount: 1,
        staffProfileIds: [worker.profileId!],
      } as never),
    ).rejects.toMatchObject({ status: 409, response: { code: PAY_RATE_REQUIRED_CODE } });
    const shiftTable = siblingTable(await businessTableOf(admin, 'venue', venueId), 'shift');
    expect(Number((await admin.query(`SELECT count(*)::int AS n FROM ${shiftTable} WHERE job_role_id = $1`, [role]))[0].n)).toBe(0);
  });

  it('decision 39: a draft priced at £0 (written before the rule) is never published (409); it stays a draft', async () => {
    const draft = await newShift(await newRole(1400));
    const shiftTable = await businessTableOf(admin, 'shift', draft.id);
    await admin.query(`UPDATE ${shiftTable} SET pay_rate_pence = 0 WHERE id = $1`, [draft.id]);
    await expect(scheduling.publish(ctxA, draft.id)).rejects.toMatchObject({ status: 409, response: { code: PAY_RATE_REQUIRED_CODE } });
    expect((await admin.query(`SELECT status FROM ${shiftTable} WHERE id = $1`, [draft.id]))[0].status).toBe('draft');
  });

  it('decision 39 (review): an already-open shift priced at £0 can be neither offered nor confirmed; nothing changes', async () => {
    // Offer refused: a shift published, then priced at £0 the way a pre-rule row would be.
    const open = await newShift(await newRole(1400));
    await scheduling.publish(ctxA, open.id);
    const table = await businessTableOf(admin, 'shift', open.id);
    await admin.query(`UPDATE ${table} SET pay_rate_pence = 0 WHERE id = $1`, [open.id]);
    await expect(offers.send(ctxA, open.id, { staffProfileId: worker.profileId! } as never)).rejects.toMatchObject({ status: 409, response: { code: PAY_RATE_REQUIRED_CODE } });
    const seats = siblingTable(table, 'shift_assignment');
    expect(await admin.query(`SELECT 1 FROM ${seats} WHERE shift_id = $1`, [open.id])).toHaveLength(0);

    // Confirmation refused: the offer was sent and accepted at a real rate, then the shift was priced at £0.
    const shift = await newShift(await newRole(1400));
    await scheduling.publish(ctxA, shift.id);
    const offer = await offers.send(ctxA, shift.id, { staffProfileId: worker.profileId! } as never);
    await offers.staffAccept(ctxOf(worker), offer.id);
    await admin.query(`UPDATE ${table} SET pay_rate_pence = 0 WHERE id = $1`, [shift.id]);
    await expect(offers.managerConfirm(ctxA, offer.id)).rejects.toMatchObject({ status: 409, response: { code: PAY_RATE_REQUIRED_CODE } });
    const [seat] = await admin.query(`SELECT status, pay_rate_snapshot_pence FROM ${seats} WHERE shift_id = $1`, [shift.id]);
    expect(seat).toEqual({ status: 'staff_accepted', pay_rate_snapshot_pence: '1400' }); // rolled back: not confirmed
    expect((await admin.query(`SELECT filled_count FROM ${table} WHERE id = $1`, [shift.id]))[0].filled_count).toBe(0);
  });

  it('decision 39 (review): approving a Venue Manager request priced at £0 is refused; the request stays pending', async () => {
    const request = await newShift(await newRole(1400));
    const table = await businessTableOf(admin, 'shift', request.id);
    // A pending request priced at £0, as one submitted before the rule would be.
    await admin.query(`UPDATE ${table} SET status = 'pending_manager_approval', requested_by = $2, pay_rate_pence = 0 WHERE id = $1`, [request.id, a.userId]);
    await expect(offers.approveShiftRequest(ctxA, request.id, {} as never)).rejects.toMatchObject({ status: 409, response: { code: PAY_RATE_REQUIRED_CODE } });
    expect((await admin.query(`SELECT status FROM ${table} WHERE id = $1`, [request.id]))[0].status).toBe('pending_manager_approval');
  });

  // ---------------------------------------------------------------------------------------------- decision 40 (org-local, inclusive)

  /** A UTC instant `daysAhead` days from now at hh:mm UTC, and the UTC calendar date of that day. */
  const utcAt = (daysAhead: number, hh: number, mm: number) => {
    const d = new Date(Date.now() + daysAhead * 86_400_000);
    d.setUTCHours(hh, mm, 0, 0);
    return { iso: d.toISOString(), day: d.toISOString().slice(0, 10), next: new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10) };
  };
  const shiftAt = async (jobRoleId: string, iso: string) =>
    scheduling.create(ctxA, { venueId, jobRoleId, startsAt: iso, endsAt: new Date(new Date(iso).getTime() + 3 * 3_600_000).toISOString(), requiredCount: 1 } as never);
  const withOrgTimezone = async <T>(tz: string, fn: () => Promise<T>): Promise<T> => {
    const [{ timezone: before }] = await admin.query(`SELECT timezone FROM core.organisation WHERE id = $1`, [a.organisationId]);
    await admin.query(`UPDATE core.organisation SET timezone = $2 WHERE id = $1`, [a.organisationId, tz]);
    try {
      return await fn();
    } finally {
      await admin.query(`UPDATE core.organisation SET timezone = $2 WHERE id = $1`, [a.organisationId, before]);
    }
  };

  it('decision 40: the end date is inclusive — a shift late on day D uses the rate that ends on D', async () => {
    const role = await newRole(1400);
    const late = utcAt(60, 22, 0); // 22:00 UTC on D, still D in a UTC organisation
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2100, effectiveFrom: day(-10), effectiveTo: late.day } as never);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2900, effectiveFrom: late.next } as never);
    await withOrgTimezone('UTC', async () => {
      expect(await shiftRate((await shiftAt(role, late.iso)).id)).toBe('2100');
    });
  });

  it('decision 40: the day is the organisation-local date — 23:30 UTC on D is D+1 in a +1 zone and takes the next rate', async () => {
    const role = await newRole(1400);
    const t = utcAt(61, 23, 30);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2100, effectiveFrom: day(-10), effectiveTo: t.day } as never);
    await venues.createRoleRate(ctxA, venueId, { jobRoleId: role, payRatePence: 2900, effectiveFrom: t.next } as never);
    // Africa/Lagos is UTC+1 all year (no daylight saving), so the expectation never depends on the test date.
    await withOrgTimezone('Africa/Lagos', async () => {
      expect(await shiftRate((await shiftAt(role, t.iso)).id)).toBe('2900');
    });
    await withOrgTimezone('UTC', async () => {
      expect(await shiftRate((await shiftAt(role, t.iso)).id)).toBe('2100');
    });
  });
});
