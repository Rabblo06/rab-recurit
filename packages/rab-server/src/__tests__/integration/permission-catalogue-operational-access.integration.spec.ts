import 'reflect-metadata';
import { ManagerType, PermissionFlag } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { PermissionCatalogueAndSystemRoleDefaults1786718000000 } from '../../database/typeorm/core/migrations/1786718000000-PermissionCatalogueAndSystemRoleDefaults';
import { ROLE_DEFS } from '../../modules/manager/services/manager.service';
import { loadSystemRoleDefaultPermissions } from '../../modules/identity/services/system-role-permissions';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Recurring 403 on the Users page (2026-10-15, RECURRING_403_AUTHORIZATION_ROOT_CAUSE_REPORT.md). The permission catalogue
 * was never created by migrations, so on a clean rebuild a Platform-Admin CEO held 4 of its 33 permissions and
 * /job-roles, /staff and /managers answered 403. Runs against a test database built by the migration chain alone.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('permission catalogue and operational access (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  const http = () => request(app.getHttpServer());
  const get = (token: string, path: string) => http().get(`/rest/v1${path}`).set('Authorization', `Bearer ${token}`);
  const USERS_PAGE = ['/job-roles', '/staff?limit=1', '/managers?limit=1', '/staff?sort=createdAt&direction=desc&page=1'];

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
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('the migration chain alone created every PermissionFlag (no seed script, no fixture insert)', async () => {
    const rows: Array<{ key: string }> = await owner.query(`SELECT key FROM core.permission`);
    const keys = new Set(rows.map((r) => r.key));
    expect(Object.values(PermissionFlag).filter((flag) => !keys.has(flag))).toEqual([]);
  });

  it('a Platform-Admin CEO with an operational workspace loads every Users-page request (200, empty is valid)', async () => {
    const org = await factory.createOrganisation('p403-ws');
    const ceo = await factory.createCeo(org, { platformAdmin: true });
    const token = await factory.login(ceo);
    for (const path of USERS_PAGE) {
      const res = await get(token, path);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const staff = await get(token, '/staff?limit=1');
    expect(staff.body).toMatchObject({ data: [], total: 0 });
  });

  it('a Platform-Admin CEO WITHOUT a workspace is told "not found" for workspace data — never 403, never another tenant', async () => {
    const org = await factory.createOrganisation('p403-nows');
    const ceo = await factory.createInternalManager(org, { type: ManagerType.CEO, platformAdmin: true, workspace: false, permissions: 'production' });
    const token = await factory.login(ceo);
    expect((await get(token, '/staff?limit=1')).status).toBe(404);
    expect((await get(token, '/job-roles')).status).toBe(404);
    expect((await get(token, '/managers?limit=1')).status).toBe(200);
  });

  it('platform-admin authority never reaches another organisation\'s managers or staff (404)', async () => {
    const orgA = await factory.createOrganisation('p403-a');
    const orgB = await factory.createOrganisation('p403-b');
    const adminA = await factory.createCeo(orgA, { platformAdmin: true });
    const managerB: TestIdentity = await factory.createInternalManager(orgB, { permissions: 'production' });
    const token = await factory.login(adminA);
    const list = await get(token, '/managers?limit=100');
    expect((list.body.data as Array<{ email: string }>).some((m) => m.email === managerB.email)).toBe(false);
    expect((await get(token, `/managers/${managerB.profileId}`)).status).toBe(404);
  });

  it('system-role creation fails closed when the catalogue lacks a default (never a crippled role)', async () => {
    await owner.transaction(async (m) => {
      const ceo = await loadSystemRoleDefaultPermissions(m, 'ceo', ROLE_DEFS[ManagerType.CEO]!.permissions);
      expect(ceo).toHaveLength(ROLE_DEFS[ManagerType.CEO]!.permissions.length);
      await expect(loadSystemRoleDefaultPermissions(m, 'ceo', ['staff.view', 'not.a.real.flag'])).rejects.toThrow(/Permission catalogue is incomplete: .*not\.a\.real\.flag/);
    });
  });

  it('the repair migration restores a crippled system role and the SAME session recovers (permission_version invalidates caches)', async () => {
    const org = await factory.createOrganisation('p403-repair');
    const ceo = await factory.createCeo(org, { platformAdmin: true });
    const token = await factory.login(ceo);
    expect((await get(token, '/staff?limit=1')).status).toBe(200);

    // Reproduce the defect: the CEO system role loses staff.view, as on a catalogue-less clean install.
    await owner.query(
      `DELETE FROM core.role_permission rp USING core.role r, core.permission p
        WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.organisation_id = $1 AND r.key = 'ceo' AND p.key = 'staff.view'`,
      [org.id],
    );
    await owner.query(`UPDATE core.role SET permission_version = permission_version + 1 WHERE organisation_id = $1 AND key = 'ceo'`, [org.id]);
    expect((await get(token, '/staff?limit=1')).status).toBe(403);

    const runner = owner.createQueryRunner();
    await runner.connect();
    try {
      await new PermissionCatalogueAndSystemRoleDefaults1786718000000().up(runner);
    } finally {
      await runner.release();
    }
    expect((await get(token, '/staff?limit=1')).status).toBe(200);
    const [{ n }] = await owner.query(
      `SELECT count(*)::int AS n FROM core.role_permission rp JOIN core.role r ON r.id = rp.role_id WHERE r.organisation_id = $1 AND r.key = 'ceo'`,
      [org.id],
    );
    expect(n).toBe(ROLE_DEFS[ManagerType.CEO]!.permissions.length);
  });
});
