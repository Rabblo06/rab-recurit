import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation } from '../../modules/identity/entities/index';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * manager_profile is workspace-private. Same organisation, different private workspaces: an ordinary Manager sees its own profile and its
 * own workspace's profiles. A CEO/admin holding manager.manage sees the organisation's profiles. An unbound context sees nothing.
 * Enforced by the database policy manager_profile_tenant (migration ManagerProfileWorkspaceVisibility1786677400000).
 */
describe('manager_profile workspace visibility (integration)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let ceo: TestIdentity;

  const ctx = (m: TestIdentity) => ({ organisationId: org.id, workspaceId: m.workspaceId, userId: m.userId, role: '' });
  const visibleProfiles = (m: TestIdentity, sql: string, params: unknown[]) =>
    tenantContext.runInTenantContext(ctx(m), async (q) => (await q.query(sql, params)) as Array<{ id: string }>);

  beforeAll(async () => {
    const __bt = new BootstrapTimer('manager-profile-isolation');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    __bt.mark('compile');
    app = moduleRef.createNestApplication();
    await app.init();
    __bt.mark('init');
    await app.get(DataSource).query('SELECT 1');
    __bt.mark('dbPing');
    __bt.log();
    runtime = app.get(DataSource);
    tenantContext = app.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: runtime,
      adminDataSource,
      tenantContext,
      passwordHashing: app.get(PasswordHashingService),
    });
    org = await factory.createOrganisation('mp-isolation');
    managerA = await factory.createInternalManager(org, { permissions: 'production', label: 'mp-a' });
    managerB = await factory.createInternalManager(org, { permissions: 'production', label: 'mp-b' });
    ceo = await factory.createCeo(org, { permissions: 'all' });
  }, 120_000);

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  it('a Manager sees its own profile', async () => {
    const rows = await visibleProfiles(managerA, 'SELECT id FROM core.manager_profile WHERE id = $1', [managerA.profileId]);
    expect(rows).toHaveLength(1);
  });

  it('a Manager cannot see another workspace\'s profile in the same organisation', async () => {
    const rows = await visibleProfiles(managerA, 'SELECT id FROM core.manager_profile WHERE id = $1', [managerB.profileId]);
    expect(rows).toHaveLength(0);
  });

  it('a Manager enumerating the organisation sees only its own workspace (no roster across workspaces)', async () => {
    const rows = await visibleProfiles(managerA, 'SELECT id FROM core.manager_profile WHERE organisation_id = $1', [org.id]);
    expect(rows.map((r) => r.id)).toEqual([managerA.profileId]);
  });

  it('the other Manager sees only its own workspace as well', async () => {
    const rows = await visibleProfiles(managerB, 'SELECT id FROM core.manager_profile WHERE organisation_id = $1', [org.id]);
    expect(rows.map((r) => r.id)).toEqual([managerB.profileId]);
  });

  it('a CEO holding manager.manage sees the organisation\'s profiles, including every private workspace', async () => {
    const rows = await visibleProfiles(ceo, 'SELECT id FROM core.manager_profile WHERE organisation_id = $1', [org.id]);
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([managerA.profileId, managerB.profileId, ceo.profileId].sort());
  });

  it('a context with the organisation but no user or workspace sees zero profiles (fail closed)', async () => {
    const rows = await tenantContext.runInTenantContext(
      { organisationId: org.id, workspaceId: null, userId: '', role: '' },
      async (q) => (await q.query('SELECT id FROM core.manager_profile WHERE organisation_id = $1', [org.id])) as Array<{ id: string }>,
    );
    expect(rows).toHaveLength(0);
  });
});
