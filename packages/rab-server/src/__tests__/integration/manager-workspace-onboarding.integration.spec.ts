import 'reflect-metadata';
import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ManagerWorkspaceService } from '../../modules/manager-workspace/services/manager-workspace.service';
import { Organisation } from '../../modules/identity/entities/index';
import { createAdminDataSource } from './helpers/admin-datasource';
import { BootstrapTimer } from './helpers/bootstrap-trace';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * manager_profile.workspace_id is server-owned. First onboarding moves an unbound profile (NULL) to the workspace the SERVER just created.
 * After that, an ordinary Manager can neither rebind nor unbind its profile, and cannot write an arbitrary workspace. manager.manage
 * (CEO/admin) keeps its explicit, audited ability to move profiles.
 */
describe('manager workspace onboarding and profile binding (integration)', () => {
  let app: INestApplication;
  let runtime: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let onboarding: ManagerWorkspaceService;
  let factory: TestIdentityFactory;
  let org: Organisation;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let unboundManager: TestIdentity;
  let ceo: TestIdentity;

  const ctxOf = (m: TestIdentity, workspaceId: string | null) => ({ organisationId: org.id, workspaceId, userId: m.userId, role: '' });
  // manager_profile is FORCE RLS: the owner reads it only with the organisation bound.
  const profileWs = (profileId: string): Promise<string | null> =>
    adminDataSource.transaction(async (m) => {
      // Read as the CEO (manager.manage): the organisation-wide privileged path. The profile policy hides it from an unbound session.
      await m.query(`SELECT set_config('rab.organisation_id', $1, true), set_config('rab.user_id', $2, true)`, [org.id, ceo.userId]);
      const rows = await m.query(`SELECT workspace_id FROM core.manager_profile WHERE id = $1`, [profileId]);
      return rows[0]?.workspace_id ?? null;
    });
  /** Runs `sql` as a caller (runtime role, own user and workspace bound) and returns the error code, or ACCEPTED. */
  const writeAs = async (m: TestIdentity, workspaceId: string | null, sql: string, params: unknown[]): Promise<string> => {
    try {
      await tenantContext.runInTenantContext(ctxOf(m, workspaceId), (q) => q.query(sql, params));
      return 'ACCEPTED';
    } catch (e) {
      return (e as { code?: string }).code ?? 'NO-CODE';
    }
  };

  beforeAll(async () => {
    const __bt = new BootstrapTimer('manager-workspace-onboarding');
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
    onboarding = app.get(ManagerWorkspaceService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource: runtime, adminDataSource, tenantContext, passwordHashing: app.get(PasswordHashingService) });
    org = await factory.createOrganisation('onboarding');
    managerA = await factory.createInternalManager(org, { permissions: 'production', label: 'on-a' });
    managerB = await factory.createInternalManager(org, { permissions: 'production', label: 'on-b' });
    unboundManager = await factory.createInternalManager(org, { permissions: 'production', label: 'on-new', workspace: false });
    ceo = await factory.createCeo(org, { permissions: 'all' });
  }, 120_000);

  afterAll(async () => {
    await adminDataSource?.destroy();
    await app?.close();
  });

  it('first onboarding: an unbound Manager creates Workspace N and its profile moves NULL -> N, the server-created workspace', async () => {
    expect(await profileWs(unboundManager.profileId!)).toBeNull();
    // The client-side ctx has NO workspace. The server creates the workspace and binds it itself.
    const created = await onboarding.create(
      { organisationId: org.id, workspaceId: null, userId: unboundManager.userId, role: '' },
      { name: 'On-boarding New', subdomain: `onb-${unboundManager.userId.slice(0, 8)}` },
    );
    expect(await profileWs(unboundManager.profileId!)).toBe(created.id);
  });

  it('a Manager who already owns a workspace cannot create a second one (409), and the profile stays bound', async () => {
    await expect(
      onboarding.create({ organisationId: org.id, workspaceId: null, userId: unboundManager.userId, role: '' }, {
        name: 'Second', subdomain: `onb2-${unboundManager.userId.slice(0, 8)}`,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('a client-supplied workspaceId cannot choose the profile\'s workspace: the server binds the workspace it created', async () => {
    const other = await factory.createInternalManager(org, { permissions: 'production', label: 'on-x', workspace: false });
    // The caller claims it is in Workspace B while its request names no workspace. The profile must take the created workspace, not B.
    const created = await onboarding.create(
      { organisationId: org.id, workspaceId: managerB.workspaceId, userId: other.userId, role: '' },
      { name: 'Server Chosen', subdomain: `srv-${other.userId.slice(0, 8)}` },
    );
    expect(await profileWs(other.profileId!)).toBe(created.id);
    expect(await profileWs(other.profileId!)).not.toBe(managerB.workspaceId);
  });

  it('an ordinary Manager cannot move its bound profile from Workspace A to Workspace B', async () => {
    const code = await writeAs(managerA, managerA.workspaceId, `UPDATE core.manager_profile SET workspace_id = $1 WHERE id = $2`, [
      managerB.workspaceId,
      managerA.profileId,
    ]);
    expect(code).toBe('42501');
    expect(await profileWs(managerA.profileId!)).toBe(managerA.workspaceId);
  });

  it('an ordinary Manager cannot unbind its bound profile (NULL-ing is refused by the binding guard)', async () => {
    const code = await writeAs(managerA, managerA.workspaceId, `UPDATE core.manager_profile SET workspace_id = NULL WHERE id = $1`, [managerA.profileId]);
    expect(code).toBe('42501');
    expect(await profileWs(managerA.profileId!)).toBe(managerA.workspaceId);
  });

  it('Manager B cannot rebind Manager A\'s profile: the row is invisible to B, so nothing changes', async () => {
    await tenantContext.runInTenantContext(ctxOf(managerB, managerB.workspaceId), (q) =>
      q.query(`UPDATE core.manager_profile SET workspace_id = $1 WHERE id = $2`, [managerB.workspaceId, managerA.profileId]),
    );
    expect(await profileWs(managerA.profileId!)).toBe(managerA.workspaceId);
  });

  it('normal own-profile fields still work for Manager A, and its workspace stays Workspace A', async () => {
    const code = await writeAs(managerA, managerA.workspaceId, `UPDATE core.manager_profile SET job_title = $1 WHERE id = $2`, [
      'Duty Manager',
      managerA.profileId,
    ]);
    expect(code).toBe('ACCEPTED');
    expect(await profileWs(managerA.profileId!)).toBe(managerA.workspaceId);
  });

  it('manager.manage (CEO) keeps its explicit ability to move a bound profile, and the move is restored afterwards', async () => {
    const moved = await writeAs(ceo, null, `UPDATE core.manager_profile SET workspace_id = $1 WHERE id = $2`, [managerB.workspaceId, managerA.profileId]);
    expect(moved).toBe('ACCEPTED');
    expect(await profileWs(managerA.profileId!)).toBe(managerB.workspaceId);
    const restored = await writeAs(ceo, null, `UPDATE core.manager_profile SET workspace_id = $1 WHERE id = $2`, [managerA.workspaceId, managerA.profileId]);
    expect(restored).toBe('ACCEPTED');
    expect(await profileWs(managerA.profileId!)).toBe(managerA.workspaceId);
  });
});
