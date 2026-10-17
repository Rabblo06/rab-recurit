import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-08 (owner decision 2026-10-15, option C): credentials issued to a mobile application target are default-denied on
 * every route not explicitly available to that mobile app, whatever other roles the identity holds. Before: a manager-tier
 * identity's 180-day `staff_app` bearer token reached staff password resets, email changes, deactivation and attendance
 * corrections. Real PostgreSQL with RLS and real HTTP.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CF-08 mobile credentials are default-denied on web-only routes (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let venueManager: TestIdentity;
  let managerMobile: string; // manager-tier identity, mobile `staff_app` credential
  let managerWeb: string;
  let staffMobile: string;
  let vmMobile: string;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  // Either the CF-08 default-deny or the older per-route @ManagerApplication refusal: both are target denials.
  const routeDenied = (res: request.Response) => res.status === 403 && ['APPLICATION_ROUTE_DENIED', 'APPLICATION_ACCESS_DENIED'].includes(res.body?.code);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf08' });
    manager = seeded.managers[0]!;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'cf08s' });
    venueManager = await factory.createVenueManager(seeded.organisation, { owner: manager, label: 'cf08v' } as never);
    managerWeb = await factory.login(manager);
    managerMobile = await factory.login(manager, { applicationTarget: 'staff_app' });
    staffMobile = await factory.login(staff);
    vmMobile = await factory.login(venueManager);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  // Manager/admin operations a stolen manager phone token must never reach.
  const ADMIN_OPS = (staffId: string): Array<[string, string, object | null]> => [
    ['post', `/rest/v1/staff/${staffId}/reset-password`, null],
    ['patch', `/rest/v1/staff/${staffId}/email`, { email: `taken-${randomUUID()}@example.test` }],
    ['post', `/rest/v1/staff/${staffId}/deactivate`, null],
    ['post', '/rest/v1/staff', { email: `x-${randomUUID()}@example.test`, firstName: 'X', lastName: 'Y' }],
    ['get', '/rest/v1/staff', null],
    ['post', `/rest/v1/attendance/${randomUUID()}/correct`, {}],
    ['get', '/rest/v1/attendance', null],
    ['post', '/rest/v1/venues', { name: 'X' }],
    ['get', '/rest/v1/search?q=a', null],
    ['get', '/rest/v1/audit-logs', null],
  ];

  it('a manager-tier identity’s mobile credential is refused on every manager/admin operation (403 APPLICATION_ROUTE_DENIED)', async () => {
    for (const [method, path, body] of ADMIN_OPS(staff.profileId!)) {
      const req = (http() as unknown as Record<string, (p: string) => request.Test>)[method]!(path).set(as(managerMobile));
      const res = await (body ? req.send(body) : req);
      expect({ method, path, denied: routeDenied(res) }).toEqual({ method, path, denied: true });
    }
    // Nothing happened to the staff account.
    const [row] = await owner.query(`SELECT u.status, u.must_reset_password FROM core."user" u WHERE u.id = $1`, [staff.userId]);
    expect(row.must_reset_password).toBe(false);
  });

  it('the same manager on the web console is unaffected (the permission boundary, not the target, decides there)', async () => {
    expect((await http().get('/rest/v1/staff').set(as(managerWeb))).status).toBe(200);
  });

  it('a spoofed X-Application-Target header cannot widen a mobile credential (the target comes from the session)', async () => {
    const res = await http().get('/rest/v1/staff').set(as(managerMobile)).set('X-Application-Target', 'manager_web');
    expect(res.status).toBe(403);
    expect(['APPLICATION_ACCESS_DENIED', 'APPLICATION_ROUTE_DENIED']).toContain(res.body.code);
  });

  it('staff app: the explicitly allowed staff routes pass the target gate', async () => {
    for (const path of ['/rest/v1/auth/me', '/rest/v1/attendance/me/active', '/rest/v1/attendance/me/history', '/rest/v1/offers/mine', '/rest/v1/notifications', '/rest/v1/notifications/unread-count', '/rest/v1/auth/capabilities']) {
      const res = await http().get(path).set(as(staffMobile));
      expect({ path, denied: routeDenied(res) }).toEqual({ path, denied: false });
      expect({ path, status: res.status < 500 }).toEqual({ path, status: true });
    }
    const read = await http().post('/rest/v1/notifications/read-all').set(as(staffMobile));
    expect(routeDenied(read)).toBe(false);
  });

  it('staff app: venue-manager-only and manager routes are refused for a staff credential', async () => {
    for (const path of ['/rest/v1/staff/venue-directory', '/rest/v1/shifts', '/rest/v1/venues', `/rest/v1/attendance/report/shift/${randomUUID()}`]) {
      expect({ path, denied: routeDenied(await http().get(path).set(as(staffMobile))) }).toEqual({ path, denied: true });
    }
  });

  it('venue manager app: its explicitly allowed routes pass the target gate; staff-only and manager routes do not', async () => {
    for (const path of ['/rest/v1/auth/me', '/rest/v1/shifts', '/rest/v1/venues', '/rest/v1/job-roles', '/rest/v1/shifts/sent', '/rest/v1/staff/venue-directory?limit=1']) {
      const res = await http().get(path).set(as(vmMobile));
      expect({ path, denied: routeDenied(res), ok: res.status < 500 }).toEqual({ path, denied: false, ok: true });
    }
    expect(routeDenied(await http().post('/rest/v1/attendance/clock-in').set(as(vmMobile)).send({}))).toBe(true);
    expect(routeDenied(await http().get('/rest/v1/staff').set(as(vmMobile)))).toBe(true);
    expect(routeDenied(await http().post(`/rest/v1/staff/${staff.profileId}/reset-password`).set(as(vmMobile)))).toBe(true);
  });

  it('a refreshed mobile credential keeps its mobile target (no route widening through refresh)', async () => {
    const tokens = await factory.loginTokens(manager, { applicationTarget: 'staff_app' });
    const refreshed = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: tokens.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(routeDenied(await http().get('/rest/v1/staff').set(as(refreshed.body.accessToken as string)))).toBe(true);
  });
});
