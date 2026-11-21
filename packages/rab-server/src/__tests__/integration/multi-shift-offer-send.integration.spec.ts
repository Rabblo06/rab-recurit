import 'reflect-metadata';
import { EmploymentStatus, PermissionFlag, PermissionFlagType, ShiftStatus } from '@rab/shared';
import { ConflictException, ForbiddenException, INestApplication } from '@nestjs/common';
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
import { BULK_OFFER_REJECTED, OfferService } from '../../modules/offer/services/offer.service';
import { SchedulingService } from '../../modules/scheduling/services/scheduling.service';
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTableOf, siblingTable } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Multi-shift send (M6): `POST /offers/send-to-shifts` → OfferService.sendOffersToShifts. All or nothing: any failing
 * row (ineligible staff, another manager's shift, the same person on two overlapping shifts of the batch, an existing
 * offer) means NOTHING is sent and the 409 lists every row. Abuse cases: OFFER_SEND re-checked in the service (403,
 * nothing written); another manager's shift reads as "Shift not found." with nothing sent; organisationId / status /
 * pay / kind in the body → 400. Happy path: every offer is created through the single-send path with the shift's pay
 * rate snapshot and one offer_batch_id per shift.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Multi-shift offer send (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let scheduling: SchedulingService;
  let offers: OfferService;
  let a: TestIdentity;
  let b: TestIdentity;
  let ctxA: AuthContext;
  let venueId: string;
  let jobRoleId: string;
  let staff: TestIdentity[];

  const ctxOf = (id: TestIdentity): AuthContext => ({ organisationId: id.organisationId, workspaceId: id.workspaceId, userId: id.userId, role: '' });
  const http = () => request(app.getHttpServer());
  const bump = (id: TestIdentity) => admin.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [id.userId]);
  async function withRevoked<T>(id: TestIdentity, flag: PermissionFlagType, fn: () => Promise<T>): Promise<T> {
    await admin.query(`INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect) SELECT $1, id, $2, 'revoke' FROM core.permission WHERE key = $3`, [
      id.userId,
      id.organisationId,
      flag,
    ]);
    await bump(id);
    try {
      return await fn();
    } finally {
      await admin.query(`DELETE FROM core.user_permission_override WHERE user_id = $1 AND permission_id = (SELECT id FROM core.permission WHERE key = $2)`, [id.userId, flag]);
      await bump(id);
    }
  }
  let dayOffset = 10;
  /** A published shift owned by `owner`, `hours` long, on its own future day (or at `start` to force an overlap). */
  async function publishedShift(owner: TestIdentity, ownerVenue: string, ownerRole: string, start?: Date, hours = 6): Promise<string> {
    const startsAt = start ?? new Date(Date.now() + dayOffset++ * 86_400_000);
    const shift = await scheduling.create(ctxOf(owner), {
      venueId: ownerVenue,
      jobRoleId: ownerRole,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + hours * 3_600_000).toISOString(),
      requiredCount: 3,
    } as never);
    await scheduling.publish(ctxOf(owner), shift.id);
    return shift.id;
  }
  const offersOn = async (shiftId: string) => {
    const table = siblingTable(await businessTableOf(admin, 'shift', shiftId), 'shift_assignment');
    return (await admin.query(`SELECT staff_profile_id, pay_rate_snapshot_pence, status FROM ${table} WHERE shift_id = $1`, [shiftId])) as Array<{
      staff_profile_id: string;
      pay_rate_snapshot_pence: string;
      status: string;
    }>;
  };
  const shiftStatus = async (shiftId: string) => (await admin.query(`SELECT status FROM ${await businessTableOf(admin, 'shift', shiftId)} WHERE id = $1`, [shiftId]))[0].status as string;

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
    offers = moduleRef.get(OfferService);
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'multisend' });
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    ctxA = ctxOf(a);
    venueId = (await moduleRef.get(VenueService).create(ctxA, { name: `Multi Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    jobRoleId = (await scheduling.createJobRole(ctxA, { name: `Multi Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500 } as never)).id;
    staff = [];
    for (let i = 0; i < 4; i++) staff.push(await factory.createStaff(seeded.organisation, { owner: a }));
    for (const person of staff) {
      await admin.query(`UPDATE ${await businessTableOf(admin, 'staff_profile', person.profileId)} SET employment_status = $2 WHERE id = $1`, [person.profileId, EmploymentStatus.ACTIVE]);
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('sends every offer of every shift in one call: pay snapshot from each shift, one batch per shift, shifts become offered', async () => {
    const s1 = await publishedShift(a, venueId, jobRoleId);
    const s2 = await publishedShift(a, venueId, jobRoleId);
    const result = await offers.sendOffersToShifts(ctxA, {
      items: [
        { shiftId: s1, staffProfileIds: [staff[0]!.profileId!, staff[1]!.profileId!] },
        { shiftId: s2, staffProfileIds: [staff[0]!.profileId!, staff[2]!.profileId!] },
      ],
    });
    expect(result.results.every((r) => r.ok && r.offerId)).toBe(true);
    expect(result.results).toHaveLength(4);
    expect(Object.keys(result.batches).sort()).toEqual([s1, s2].sort());
    expect(result.batches[s1]).not.toBe(result.batches[s2]);
    for (const shiftId of [s1, s2]) {
      const seats = await offersOn(shiftId);
      expect(seats).toHaveLength(2);
      expect(seats.every((seat) => seat.pay_rate_snapshot_pence === '1500' && seat.status === 'offered')).toBe(true);
      expect(await shiftStatus(shiftId)).toBe(ShiftStatus.OFFERED);
    }
  });

  it('all or nothing: one ineligible recipient means nothing is sent on ANY shift; the 409 reports every row', async () => {
    const s1 = await publishedShift(a, venueId, jobRoleId);
    const s2 = await publishedShift(a, venueId, jobRoleId);
    const suspended = staff[3]!;
    const table = await businessTableOf(admin, 'staff_profile', suspended.profileId);
    await admin.query(`UPDATE ${table} SET employment_status = $2 WHERE id = $1`, [suspended.profileId, EmploymentStatus.SUSPENDED]);
    try {
      const error = await offers
        .sendOffersToShifts(ctxA, {
          items: [
            { shiftId: s1, staffProfileIds: [staff[0]!.profileId!] },
            { shiftId: s2, staffProfileIds: [staff[1]!.profileId!, suspended.profileId!] },
          ],
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { code: string; message: string; results: Array<{ shiftId: string; staffProfileId: string; ok: boolean; message: string }> };
      expect(body.code).toBe(BULK_OFFER_REJECTED);
      expect(body.message).toBe('Nothing was sent: 1 of 3 offers could not be sent.');
      expect(body.results).toHaveLength(3);
      expect(body.results.every((r) => r.ok === false)).toBe(true);
      expect(body.results.find((r) => r.staffProfileId === suspended.profileId)!.message).toMatch(/not actively employed/);
      expect(body.results.find((r) => r.staffProfileId === staff[0]!.profileId)!.message).toMatch(/another offer in this batch failed/);
      expect(await offersOn(s1)).toEqual([]);
      expect(await offersOn(s2)).toEqual([]);
      expect([await shiftStatus(s1), await shiftStatus(s2)]).toEqual([ShiftStatus.OPEN, ShiftStatus.OPEN]);
    } finally {
      await admin.query(`UPDATE ${table} SET employment_status = $2 WHERE id = $1`, [suspended.profileId, EmploymentStatus.ACTIVE]);
    }
  });

  it('double booking: the same person on two overlapping shifts of the batch is refused before anything is sent', async () => {
    const start = new Date(Date.now() + dayOffset++ * 86_400_000);
    const s1 = await publishedShift(a, venueId, jobRoleId, start, 6);
    const s2 = await publishedShift(a, venueId, jobRoleId, new Date(start.getTime() + 2 * 3_600_000), 6);
    const error = await offers
      .sendOffersToShifts(ctxA, { items: [{ shiftId: s1, staffProfileIds: [staff[2]!.profileId!] }, { shiftId: s2, staffProfileIds: [staff[2]!.profileId!] }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as { results: Array<{ message: string }> };
    expect(body.results.map((r) => r.message)).toEqual([expect.stringMatching(/overlapping shift in this batch/), expect.stringMatching(/overlapping shift in this batch/)]);
    expect([...(await offersOn(s1)), ...(await offersOn(s2))]).toEqual([]);
  });

  it('abuse: another manager’s shift reads as "Shift not found." and nothing is sent, not even on my own shift', async () => {
    const otherVenue = (await app.get(VenueService).create(ctxOf(b), { name: `B ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    const otherRole = (await scheduling.createJobRole(ctxOf(b), { name: `B ${randomUUID().slice(0, 6)}`, defaultRatePence: 1000 } as never)).id;
    const foreign = await publishedShift(b, otherVenue, otherRole);
    const mine = await publishedShift(a, venueId, jobRoleId);
    const error = await offers
      .sendOffersToShifts(ctxA, { items: [{ shiftId: mine, staffProfileIds: [staff[0]!.profileId!] }, { shiftId: foreign, staffProfileIds: [staff[1]!.profileId!] }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as { results: Array<{ shiftId: string; message: string }> };
    expect(body.results.find((r) => r.shiftId === foreign)!.message).toBe('Shift not found.');
    expect(await offersOn(mine)).toEqual([]);
    expect(await offersOn(foreign)).toEqual([]);
  });

  it('abuse: OFFER_SEND revoked → the SERVICE refuses with 403 and writes nothing', async () => {
    const s1 = await publishedShift(a, venueId, jobRoleId);
    await withRevoked(a, PermissionFlag.OFFER_SEND, async () => {
      await expect(offers.sendOffersToShifts(ctxA, { items: [{ shiftId: s1, staffProfileIds: [staff[0]!.profileId!] }] })).rejects.toBeInstanceOf(ForbiddenException);
    });
    expect(await offersOn(s1)).toEqual([]);
  });

  it('abuse: organisationId / status / pay / kind anywhere in the body → 400; duplicate shifts → 400; a second send to the same people → 409', async () => {
    const token = await factory.login(a);
    const s1 = await publishedShift(a, venueId, jobRoleId);
    const item = { shiftId: s1, staffProfileIds: [staff[1]!.profileId!] };
    const post = (body: object) => http().post('/rest/v1/offers/send-to-shifts').set('Authorization', `Bearer ${token}`).send(body);
    for (const body of [
      { items: [item], organisationId: a.organisationId },
      { items: [item], status: 'manager_confirmed' },
      { items: [{ ...item, payRatePence: 1 }] },
      { items: [{ ...item, offerKind: 'standby' }] },
      { items: [{ ...item, startsAt: new Date().toISOString() }] },
      { items: [] },
    ]) {
      expect({ body, status: (await post(body)).status }).toEqual({ body, status: 400 });
    }
    expect((await post({ items: [item, item] })).status).toBe(400);
    expect(await offersOn(s1)).toEqual([]);

    const ok = await post({ items: [item] });
    expect(ok.status).toBe(201);
    const again = await post({ items: [item] });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: BULK_OFFER_REJECTED });
    expect(await offersOn(s1)).toHaveLength(1);
  });
});
