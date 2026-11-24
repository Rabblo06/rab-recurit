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
import { VenueService } from '../../modules/venue/services/venue.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { businessTableOf } from './helpers/hws-fixtures';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Owner decision 60 (offers part): `GET /offers` counts the exact total on page 1 only; every later page answers
 * `total: null` and every page says `hasMore`. The read scope is unchanged (another manager sees none of these offers).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('GET /offers total on page 1 only (decision 60, integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let admin: DataSource;
  let factory: TestIdentityFactory;
  let a: TestIdentity;
  let b: TestIdentity;
  const offerIds: string[] = [];
  const ctxOf = (id: TestIdentity): AuthContext => ({ organisationId: id.organisationId, workspaceId: id.workspaceId, userId: id.userId, role: '' });

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
    const scheduling = moduleRef.get(SchedulingService);
    const offers = moduleRef.get(OfferService);
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'offers-total' });
    [a, b] = seeded.managers as [TestIdentity, TestIdentity];
    const venueId = (await moduleRef.get(VenueService).create(ctxOf(a), { name: `Total Venue ${randomUUID().slice(0, 6)}`, type: 'hotel' } as never)).id;
    const jobRoleId = (await scheduling.createJobRole(ctxOf(a), { name: `Total Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500 } as never)).id;
    const start = new Date(Date.now() + 9 * 86_400_000);
    const shift = await scheduling.create(ctxOf(a), {
      venueId, jobRoleId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 6 * 3_600_000).toISOString(), requiredCount: 7,
    } as never);
    await scheduling.publish(ctxOf(a), shift.id);
    for (let i = 0; i < 7; i++) {
      const person = await factory.createStaff(seeded.organisation, { owner: a });
      await admin.query(`UPDATE ${await businessTableOf(admin, 'staff_profile', person.profileId)} SET employment_status = $2 WHERE id = $1`, [person.profileId, EmploymentStatus.ACTIVE]);
      offerIds.push((await offers.send(ctxOf(a), shift.id, { staffProfileId: person.profileId! } as never)).id);
    }
  });

  afterAll(async () => {
    await app?.close();
    await admin?.destroy();
  });

  it('page 1 carries the exact total; later pages answer total null; hasMore is right on every page; no row repeats', async () => {
    const token = await factory.login(a);
    const get = (query: Record<string, unknown>) => request(app.getHttpServer()).get('/rest/v1/offers').query(query).set('Authorization', `Bearer ${token}`);

    const first = await get({ limit: 3 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 7, hasMore: true });
    expect(first.body.data).toHaveLength(3);
    expect((await get({ limit: 3, page: 1 })).body.total).toBe(7);

    const second = await get({ limit: 3, page: 2 });
    expect(second.body).toMatchObject({ total: null, hasMore: true });
    expect(second.body.data).toHaveLength(3);

    const last = await get({ limit: 3, page: 3 });
    expect(last.body).toMatchObject({ total: null, hasMore: false });
    expect(last.body.data).toHaveLength(1);

    const walked = [...first.body.data, ...second.body.data, ...last.body.data].map((r: { id: string }) => r.id);
    expect(walked).toHaveLength(7);
    expect(new Set(walked)).toEqual(new Set(offerIds));
    expect((await get({ limit: 7 })).body.hasMore).toBe(false);
    expect((await get({ limit: 3, status: 'manager_confirmed' })).body).toMatchObject({ total: 0, data: [], hasMore: false });
  });

  it('scope unchanged: another manager of the same organisation sees none of these offers, on any page', async () => {
    const token = await factory.login(b);
    const res = await request(app.getHttpServer()).get('/rest/v1/offers').query({ limit: 3 }).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.filter((r: { id: string }) => offerIds.includes(r.id))).toEqual([]);
    expect(res.body.total).toBe(res.body.data.length);
  });
});
