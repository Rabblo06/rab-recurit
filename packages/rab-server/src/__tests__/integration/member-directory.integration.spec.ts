import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * AdminMemberDirectory1786723400000 — GET /rest/v1/members/directory (any active member of the caller's workspace) and
 * GET /rest/v1/admin/users/directory (active platform administrator only). Abuse cases: no session → 401; another
 * workspace's or organisation's members never appear; only userId/firstName/lastName/email leave the workspace directory;
 * a non-admin never reaches the cross-organisation directory (route 403, function 42501 with no context bound); out-of-range
 * paging and client-sent organisationId are 400.
 */
const describeIfDb = integrationTestDatabaseReady() && Boolean(process.env.REDIS_URL) ? describe : describe.skip;

describeIfDb('member directory (integration)', () => {
  jest.setTimeout(300_000);
  let app: INestApplication;
  let owner: DataSource;
  let runtime: DataSource;
  let factory: TestIdentityFactory;
  let a: TestIdentity;
  let aSameOrgOtherWorkspace: TestIdentity;
  let b: TestIdentity;
  let admin: TestIdentity;
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    runtime = moduleRef.get(DataSource);
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const orgA = await factory.createOrganisation('mdir-a');
    a = await factory.createInternalManager(orgA, { permissions: 'production', label: 'mdira' });
    aSameOrgOtherWorkspace = await factory.createInternalManager(orgA, { permissions: 'production', label: 'mdira2' });
    const orgB = await factory.createOrganisation('mdir-b');
    b = await factory.createInternalManager(orgB, { permissions: 'production', label: 'mdirb' });
    const adminOrg = await factory.createOrganisation('mdir-admin');
    admin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'mdiradm', platformAdmin: true });
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('ABUSE: no session is 401 on both routes', async () => {
    expect((await http().get('/rest/v1/members/directory')).status).toBe(401);
    expect((await http().get('/rest/v1/admin/users/directory')).status).toBe(401);
  });

  it('workspace directory lists only the caller workspace, with exactly four fields', async () => {
    const res = await http().get('/rest/v1/members/directory?page=1&limit=100').set(bearer(await factory.login(a, { applicationTarget: 'manager_web' })));
    expect(res.status).toBe(200);
    const emails = res.body.data.map((r: { email: string }) => r.email);
    expect(emails).toContain(a.email);
    expect(emails).not.toContain(aSameOrgOtherWorkspace.email);
    expect(emails).not.toContain(b.email);
    for (const row of res.body.data) expect(Object.keys(row).sort()).toEqual(['email', 'firstName', 'lastName', 'userId']);
  });

  it('ABUSE: out-of-range paging and client-sent organisationId are 400', async () => {
    const token = await factory.login(a, { applicationTarget: 'manager_web' });
    expect((await http().get('/rest/v1/members/directory?limit=101').set(bearer(token))).status).toBe(400);
    expect((await http().get('/rest/v1/members/directory?page=0').set(bearer(token))).status).toBe(400);
    expect((await http().get(`/rest/v1/members/directory?organisationId=${b.organisationId}`).set(bearer(token))).status).toBe(400);
    const adminToken = await factory.login(admin, { applicationTarget: 'manager_web' });
    expect((await http().get('/rest/v1/admin/users/directory?limit=101').set(bearer(adminToken))).status).toBe(400);
    expect((await http().get(`/rest/v1/admin/users/directory?organisationId=${b.organisationId}`).set(bearer(adminToken))).status).toBe(400);
  });

  it('ABUSE: a non-admin gets 403 on the cross-organisation directory', async () => {
    expect((await http().get('/rest/v1/admin/users/directory').set(bearer(await factory.login(a, { applicationTarget: 'manager_web' })))).status).toBe(403);
  });

  it('platform admin directory spans organisations and returns no credential fields', async () => {
    const res = await http().get(`/rest/v1/admin/users/directory?search=${encodeURIComponent(b.email)}`).set(bearer(await factory.login(admin, { applicationTarget: 'manager_web' })));
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { email: string }) => r.email)).toContain(b.email);
    for (const row of res.body.data) {
      expect(Object.keys(row).sort()).toEqual(['email', 'expiresAt', 'firstName', 'id', 'kind', 'lastName', 'organisationName', 'status', 'userId']);
    }
  });

  it('ABUSE: as the runtime role with no tenant context bound, both functions refuse (42501), never all rows', async () => {
    for (const fn of ['core.workspace_member_directory', 'core.admin_member_directory']) {
      const error = await runtime.transaction(async (m) => {
        await m.query(`SELECT pg_catalog.set_config('rab.user_id', '', true), pg_catalog.set_config('rab.organisation_id', '', true), pg_catalog.set_config('rab.workspace_id', '', true)`);
        return m.query(`SELECT ${fn}('', 1, 25) AS r`).then(() => null, (e: { code?: string }) => e);
      });
      expect(error?.code).toBe('42501');
    }
  });

  it('ABUSE: a workspace member with a foreign workspace bound is refused (42501)', async () => {
    const error = await runtime.transaction(async (m) => {
      await m.query(`SELECT pg_catalog.set_config('rab.user_id', $1, true), pg_catalog.set_config('rab.organisation_id', $2, true), pg_catalog.set_config('rab.workspace_id', $3, true)`, [a.userId, a.organisationId, randomUUID()]);
      return m.query(`SELECT core.workspace_member_directory('', 1, 25) AS r`).then(() => null, (e: { code?: string }) => e);
    });
    expect(error?.code).toBe('42501');
  });
});
