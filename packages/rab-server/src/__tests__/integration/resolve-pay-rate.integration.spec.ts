import 'reflect-metadata';
import { EmploymentStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { OfferService } from '../../modules/offer/services/offer.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
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
 * `pay_rate_snapshot_pence`; only shifts created afterwards see the new rate. (The staff role rate step does not exist
 * yet: no per-staff rate table.)
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
});
