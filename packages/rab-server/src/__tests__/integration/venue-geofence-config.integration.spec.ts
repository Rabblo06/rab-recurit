import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Venue geofence CONFIGURATION (lat/lng/radius/enforce) — validation,
 * authorization and persistence. Real Postgres, RLS on, no mocks. The
 * attendance-side use of these saved values (clock-in outside/inside the
 * radius, disabling enforcement) is exercised end-to-end in
 * `attendance-abuse-cases.integration.spec.ts` ("venue geofence configuration
 * drives attendance").
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('venue geofence configuration (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';
  const MANAGER_PERMS = [PermissionFlag.VENUE_VIEW, PermissionFlag.VENUE_CREATE, PermissionFlag.VENUE_EDIT];
  const STAFF_PERMS = [PermissionFlag.ATTENDANCE_CLOCK];
  const VENUE_MANAGER_PERMS = [PermissionFlag.VENUE_VIEW];

  async function ensurePermission(key: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource: key.split('.')[0]!, action: key.split('.')[1]! });
    return permission;
  }

  /** One org + one Internal-Manager-equivalent (platform admin, same shape as the attendance suite's `seedOrg`) with a real workspace. */
  async function seedOrg(): Promise<{ organisation: Organisation; managerEmail: string; managerUserId: string }> {
    const slug = `test-${randomUUID()}`;
    const managerEmail = `mgr-${randomUUID()}@example.test`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });
    let managerUserId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager-${randomUUID()}`, name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await ensurePermission(key);
        await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email: managerEmail,
        passwordHash: await passwordHashing.hash(password),
        firstName: 'Manager',
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      managerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: managerUserId, roleId, organisationId: organisation.id });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [managerUserId]);
      await manager.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: managerUserId,
        name: `Test Workspace ${managerUserId}`,
        subdomain: `test-${managerUserId.slice(0, 8)}`,
        status: 'active',
      });
    });
    await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [managerUserId]);
    return { organisation, managerEmail, managerUserId };
  }

  /** A non-admin account with a literal role key (`applicationAllowed` matches role keys exactly) and only the given permissions. */
  async function seedRoleUser(organisation: Organisation, roleKey: string, perms: string[]): Promise<string> {
    const email = `${roleKey}-${randomUUID()}@example.test`;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      let role = await manager.findOne(Role, { where: { organisationId: organisation.id, key: roleKey } });
      if (!role) {
        const result = await manager.insert(Role, { organisationId: organisation.id, key: roleKey, name: roleKey, isSystem: true });
        role = await manager.findOneByOrFail(Role, { id: result.identifiers[0]!.id as string });
        for (const key of perms) {
          const permission = await ensurePermission(key);
          await manager.insert(RolePermission, { roleId: role.id, permissionId: permission.id, organisationId: organisation.id });
        }
      }
      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash: await passwordHashing.hash(password),
        firstName: roleKey,
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      await manager.insert(UserRole, { userId: userResult.identifiers[0]!.id as string, roleId: role.id, organisationId: organisation.id });
    });
    return email;
  }

  async function login(email: string, extra: { mobile?: boolean; applicationTarget?: string } = {}): Promise<string> {
    const req = request(app.getHttpServer()).post('/rest/v1/auth/login');
    if (extra.mobile) req.set('x-client-platform', 'mobile');
    const res = await req.send({ email, password, ...(extra.applicationTarget ? { applicationTarget: extra.applicationTarget } : {}) });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  const baseVenue = () => ({ name: `Venue ${randomUUID().slice(0, 8)}`, type: 'hotel' });
  const post = (token: string, body: unknown) => request(app.getHttpServer()).post('/rest/v1/venues').set('Authorization', `Bearer ${token}`).send(body as object);
  const patch = (token: string, id: string, body: unknown) =>
    request(app.getHttpServer()).patch(`/rest/v1/venues/${id}`).set('Authorization', `Bearer ${token}`).send(body as object);
  const get = (token: string, id: string) => request(app.getHttpServer()).get(`/rest/v1/venues/${id}`).set('Authorization', `Bearer ${token}`);
  /** Raw JSON string body — the only way to put a real `Infinity` (via `1e999`) on the wire, since `JSON.stringify` turns Infinity/NaN into null. */
  const postRaw = (token: string, raw: string) =>
    request(app.getHttpServer()).post('/rest/v1/venues').set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/json').send(raw);

  let organisation: Organisation;
  let managerEmail: string;
  let token: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();

    ({ organisation, managerEmail } = await seedOrg());
    token = await login(managerEmail);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('create venue', () => {
    it('accepts valid coordinates and returns lat/lng as real numbers (not Postgres numeric strings)', async () => {
      const res = await post(token, { ...baseVenue(), lat: 51.508, lng: -0.1281, geofenceRadiusM: 100 });
      expect(res.status).toBe(201);
      const read = await get(token, res.body.id);
      expect(read.body.lat).toBe(51.508);
      expect(read.body.lng).toBe(-0.1281);
      expect(typeof read.body.lat).toBe('number');
      expect(typeof read.body.lng).toBe('number');
      expect(read.body.geofenceRadiusM).toBe(100);
      expect(read.body.enforceGeofence).toBe(false);
    });

    it.each([
      ['latitude > 90', { lat: 90.0001, lng: 0 }],
      ['latitude < -90', { lat: -90.0001, lng: 0 }],
      ['longitude > 180', { lat: 0, lng: 180.0001 }],
      ['longitude < -180', { lat: 0, lng: -180.0001 }],
      ['NaN latitude', { lat: 'NaN', lng: 0 }],
      ['NaN longitude', { lat: 0, lng: 'NaN' }],
      ['Infinity latitude (string)', { lat: 'Infinity', lng: 0 }],
      ['non-numeric latitude', { lat: 'abc', lng: 0 }],
      ['radius below 50m', { geofenceRadiusM: 49 }],
      ['null radius', { geofenceRadiusM: null }],
      ['latitude without longitude', { lat: 51.5 }],
      ['longitude without latitude', { lng: -0.12 }],
    ])('rejects %s with 400', async (_label, extra) => {
      const res = await post(token, { ...baseVenue(), ...extra });
      expect(res.status).toBe(400);
    });

    it('rejects a real Infinity on the wire (1e999) with 400, not a 500', async () => {
      const res = await postRaw(token, JSON.stringify({ ...baseVenue(), lng: 0 }).replace('}', ',"lat":1e999}'));
      expect(res.status).toBe(400);
    });

    it('allows geofence OFF with no coordinates (existing behaviour preserved)', async () => {
      const res = await post(token, baseVenue());
      expect(res.status).toBe(201);
      expect(res.body.enforceGeofence).toBe(false);
      expect(res.body.lat ?? null).toBeNull();
    });

    it('rejects enforcement without latitude', async () => {
      const res = await post(token, { ...baseVenue(), lng: -0.1281, geofenceRadiusM: 100, enforceGeofence: true });
      expect(res.status).toBe(400);
    });

    it('rejects enforcement without longitude', async () => {
      const res = await post(token, { ...baseVenue(), lat: 51.508, geofenceRadiusM: 100, enforceGeofence: true });
      expect(res.status).toBe(400);
    });

    it('rejects enforcement without an explicit radius', async () => {
      const res = await post(token, { ...baseVenue(), lat: 51.508, lng: -0.1281, enforceGeofence: true });
      expect(res.status).toBe(400);
    });

    it('accepts a fully valid enforced geofence', async () => {
      const res = await post(token, { ...baseVenue(), lat: 51.508, lng: -0.1281, geofenceRadiusM: 100, enforceGeofence: true });
      expect(res.status).toBe(201);
      expect(res.body.enforceGeofence).toBe(true);
    });

    it('rejects a client-supplied organisationId/workspaceId (mass-assignment protection intact)', async () => {
      const res = await post(token, { ...baseVenue(), organisationId: randomUUID() });
      expect(res.status).toBe(400);
    });
  });

  describe('update venue', () => {
    async function makeVenue(extra: Record<string, unknown> = {}): Promise<string> {
      const res = await post(token, { ...baseVenue(), ...extra });
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    it('enabling enforcement on a venue that already has a location succeeds', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 100 });
      const res = await patch(token, id, { enforceGeofence: true });
      expect(res.status).toBe(200);
      expect(res.body.enforceGeofence).toBe(true);
    });

    it('enabling enforcement on a venue with NO location is rejected, and nothing changes', async () => {
      const id = await makeVenue();
      const res = await patch(token, id, { enforceGeofence: true });
      expect(res.status).toBe(400);
      expect((await get(token, id)).body.enforceGeofence).toBe(false);
    });

    it('disabling geofence keeps the saved location', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 100, enforceGeofence: true });
      const res = await patch(token, id, { enforceGeofence: false });
      expect(res.status).toBe(200);
      expect(res.body.enforceGeofence).toBe(false);
      expect(res.body.lat).toBe(51.508);
    });

    it('changes coordinates and radius, surviving create -> read -> update -> read as real numbers', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 100, enforceGeofence: true });
      const res = await patch(token, id, { lat: 40.712776, lng: -74.005974, geofenceRadiusM: 250 });
      expect(res.status).toBe(200);
      const read = (await get(token, id)).body;
      expect(read.lat).toBe(40.712776);
      expect(read.lng).toBe(-74.005974);
      expect(read.geofenceRadiusM).toBe(250);
      expect(read.enforceGeofence).toBe(true);
    });

    it('an unrelated edit (name) never resets the saved location, radius or enforcement to defaults', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 321, enforceGeofence: true });
      const res = await patch(token, id, { name: 'Renamed venue' });
      expect(res.status).toBe(200);
      expect(res.body.lat).toBe(51.508);
      expect(res.body.geofenceRadiusM).toBe(321);
      expect(res.body.enforceGeofence).toBe(true);
    });

    it('removing coordinates while enforcement is OFF is allowed (null clears them)', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 100 });
      const res = await patch(token, id, { lat: null, lng: null });
      expect(res.status).toBe(200);
      expect(res.body.lat ?? null).toBeNull();
      expect(res.body.lng ?? null).toBeNull();
    });

    it('removing coordinates while enforcement is ON is rejected, and the stored location is untouched', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 100, enforceGeofence: true });
      const res = await patch(token, id, { lat: null, lng: null });
      expect(res.status).toBe(400);
      expect((await get(token, id)).body.lat).toBe(51.508);
    });

    it('clearing only one coordinate is rejected (they are set together)', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281 });
      expect((await patch(token, id, { lng: null })).status).toBe(400);
    });

    it('rejects out-of-range and sub-minimum values on update too', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281 });
      expect((await patch(token, id, { lat: 91 })).status).toBe(400);
      expect((await patch(token, id, { lng: -181 })).status).toBe(400);
      expect((await patch(token, id, { geofenceRadiusM: 10 })).status).toBe(400);
      expect((await patch(token, id, { geofenceRadiusM: null })).status).toBe(400);
    });

    it('records an audit entry when the geofence configuration changes, and none for an unrelated edit', async () => {
      const id = await makeVenue({ lat: 51.508, lng: -0.1281, geofenceRadiusM: 100 });
      await patch(token, id, { name: 'Just a rename' });
      await patch(token, id, { enforceGeofence: true });
      const rows = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, (manager) =>
        manager.query(`SELECT action, metadata FROM core.audit_log WHERE organisation_id = $1 AND entity_id = $2 AND action = 'venue.geofence_updated'`, [organisation.id, id]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.before.enforceGeofence).toBe(false);
      expect(rows[0].metadata.after.enforceGeofence).toBe(true);
    });
  });

  describe('authorization', () => {
    it('a Staff account cannot create or change venue location configuration (403)', async () => {
      const id = (await post(token, baseVenue())).body.id as string;
      const staffToken = await login(await seedRoleUser(organisation, 'staff', STAFF_PERMS), { mobile: true });
      expect((await patch(staffToken, id, { lat: 1, lng: 1 })).status).toBe(403);
      expect((await post(staffToken, { ...baseVenue(), lat: 1, lng: 1 })).status).toBe(403);
    });

    it('a Venue Manager (venue.view only) cannot create or change venue location configuration (403)', async () => {
      const id = (await post(token, baseVenue())).body.id as string;
      const vmToken = await login(await seedRoleUser(organisation, 'venue_manager', VENUE_MANAGER_PERMS), { applicationTarget: 'venue_manager_app' });
      expect((await patch(vmToken, id, { lat: 1, lng: 1, geofenceRadiusM: 100, enforceGeofence: true })).status).toBe(403);
      expect((await post(vmToken, { ...baseVenue(), lat: 1, lng: 1 })).status).toBe(403);
    });

    it('another Manager in the same organisation (different private scope) gets 404, never the venue', async () => {
      const id = (await post(token, { ...baseVenue(), lat: 51.508, lng: -0.1281 })).body.id as string;
      const otherToken = await login(await seedRoleUser(organisation, 'manager', MANAGER_PERMS));
      expect((await patch(otherToken, id, { lat: 10, lng: 10 })).status).toBe(404);
      expect((await get(token, id)).body.lat).toBe(51.508);
    });

    it('a Manager from a different organisation gets 404 and cannot alter the venue', async () => {
      const id = (await post(token, { ...baseVenue(), lat: 51.508, lng: -0.1281 })).body.id as string;
      const other = await seedOrg();
      const otherToken = await login(other.managerEmail);
      expect((await patch(otherToken, id, { lat: 10, lng: 10 })).status).toBe(404);
      expect((await get(token, id)).body.lat).toBe(51.508);
    });

    it('a request with no token is rejected', async () => {
      const res = await request(app.getHttpServer()).patch(`/rest/v1/venues/${randomUUID()}`).send({ lat: 1, lng: 1 });
      expect(res.status).toBe(401);
    });
  });
});
