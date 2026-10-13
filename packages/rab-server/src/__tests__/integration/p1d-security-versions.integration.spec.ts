import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AccountLifecycleService } from '../../engine/core-modules/auth/services/account-lifecycle.service';
import { OrganisationAuthProvidersService } from '../../engine/core-modules/auth/services/organisation-auth-providers.service';
import { SecurityVersionService } from '../../engine/core-modules/auth/services/security-version.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { AdminPanelService } from '../../engine/core-modules/platform-admin/admin-panel.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { WorkspaceMembershipService } from '../../engine/core-modules/tenant/workspace-membership.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { Organisation, Role } from '../../modules/identity/entities';
import { RoleService } from '../../modules/identity/services/role.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * P1D — PostgreSQL-authoritative security versions. Proves the exit-gate properties from the
 * owner's own brief (§3.7): monotonic concurrent bumps, rollback correctness, role-definition
 * fan-out to every holder, workspace/platform-admin/organisation invalidation, session/user
 * invalidation on logout/password-reset, and fail-closed behaviour with no tenant context bound.
 *
 * No Redis cache exists yet (P1E) — every assertion here reads `core.*` directly, via
 * `SecurityVersionService.readVector` or raw SQL, never a cache.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('P1D security versions (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let securityVersion: SecurityVersionService;
  let roleService: RoleService;
  let platformAdminService: PlatformAdminService;
  let orgAuthProviders: OrganisationAuthProvidersService;
  let adminPanel: AdminPanelService;
  let refreshTokenService: RefreshTokenService;
  let accountLifecycle: AccountLifecycleService;
  let workspaceMembership: WorkspaceMembershipService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    securityVersion = moduleRef.get(SecurityVersionService);
    roleService = moduleRef.get(RoleService);
    platformAdminService = moduleRef.get(PlatformAdminService);
    orgAuthProviders = moduleRef.get(OrganisationAuthProvidersService);
    adminPanel = moduleRef.get(AdminPanelService);
    refreshTokenService = moduleRef.get(RefreshTokenService);
    accountLifecycle = moduleRef.get(AccountLifecycleService);
    workspaceMembership = moduleRef.get(WorkspaceMembershipService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function readVectorFor(identity: TestIdentity, sessionId: string = randomUUID()): ReturnType<SecurityVersionService['readVector']> {
    return tenantContext.runInTenantContext(
      { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' },
      (m) => securityVersion.readVector(m, { sessionId, userId: identity.userId, organisationId: identity.organisationId, workspaceId: identity.workspaceId }),
    );
  }

  describe('monotonic guard (database-enforced, not application discipline alone)', () => {
    it('rejects any UPDATE that sets core.user.security_version to anything other than exactly +1', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      const [{ security_version: before }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [user.userId],
      );

      await expect(adminDataSource.query(`UPDATE core."user" SET security_version = security_version + 2 WHERE id = $1`, [user.userId])).rejects.toMatchObject({
        code: '22023',
      });
      await expect(adminDataSource.query(`UPDATE core."user" SET security_version = security_version - 1 WHERE id = $1`, [user.userId])).rejects.toMatchObject({
        code: '22023',
      });
      await expect(adminDataSource.query(`UPDATE core."user" SET security_version = 999999 WHERE id = $1`, [user.userId])).rejects.toMatchObject({
        code: '22023',
      });

      const [{ security_version: after }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [user.userId],
      );
      expect(after).toBe(before);
      void organisation;
    });

    it('allows exactly +1, and a benign update that leaves the column untouched', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      await expect(adminDataSource.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [user.userId])).resolves.toBeDefined();
      await expect(adminDataSource.query(`UPDATE core."user" SET first_name = 'Unchanged' WHERE id = $1`, [user.userId])).resolves.toBeDefined();
    });
  });

  describe('concurrency and rollback correctness', () => {
    it('two concurrent bumps on the same user never lose an update (no lost-update race)', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      const [{ security_version: before }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [user.userId],
      );

      const ctx = { organisationId: user.organisationId, workspaceId: null, userId: user.userId, role: '' };
      await Promise.all([
        tenantContext.runInTenantContext(ctx, (m) => securityVersion.bumpUser(m, user.userId)),
        tenantContext.runInTenantContext(ctx, (m) => securityVersion.bumpUser(m, user.userId)),
      ]);

      const [{ security_version: after }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [user.userId],
      );
      expect(Number(after)).toBe(Number(before) + 2);
    });

    it('a rolled-back transaction leaves the version exactly as it was — the bump never survives a rollback its own mutation did not', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      const [{ security_version: before }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [user.userId],
      );

      const ctx = { organisationId: user.organisationId, workspaceId: null, userId: user.userId, role: '' };
      await expect(
        tenantContext.runInTenantContext(ctx, async (m) => {
          await securityVersion.bumpUser(m, user.userId);
          // Prove the bump genuinely happened WITHIN this transaction (not merely attempted) before
          // the rollback — otherwise "unchanged after" could just as well mean "silently no-op'd".
          const [{ security_version: midTransaction }] = await m.query<Array<{ security_version: string }>>(
            `SELECT security_version FROM core."user" WHERE id = $1`,
            [user.userId],
          );
          expect(Number(midTransaction)).toBe(Number(before) + 1);
          throw new Error('deliberate rollback');
        }),
      ).rejects.toThrow('deliberate rollback');

      const [{ security_version: after }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [user.userId],
      );
      expect(after).toBe(before);
    });
  });

  describe('role-definition fan-out — a role change affects EVERY current holder, without touching their own rows', () => {
    it('two users holding the same role both see the new rolePermissionVersion after one setPermissions call, with neither user row touched', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(2, { permissions: 'production' });
      const [userA, userB] = managers;
      const roleIdRow = await adminDataSource.query<Array<{ id: string }>>(`SELECT id FROM core.role WHERE key = $1 AND organisation_id = $2`, [
        userA!.roleKey,
        organisation.id,
      ]);
      const roleId = roleIdRow[0]!.id;

      const before = await Promise.all([readVectorFor(userA!), readVectorFor(userB!)]);
      const [{ security_version: userAVersionBefore }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [userA!.userId],
      );

      const ctx = { organisationId: organisation.id, workspaceId: null, userId: userA!.userId, role: '' };
      await roleService.update(ctx, roleId, { permissionKeys: ['staff.view' as never] });

      const after = await Promise.all([readVectorFor(userA!), readVectorFor(userB!)]);
      expect(after[0].rolePermissionVersion).toBeGreaterThan(before[0].rolePermissionVersion);
      expect(after[1].rolePermissionVersion).toBe(after[0].rolePermissionVersion);
      expect(after[1].rolePermissionVersion).toBeGreaterThan(before[1].rolePermissionVersion);

      // The role definition changed; neither holder's OWN user.security_version did — role-definition
      // fan-out is carried by role.permission_version alone, never a synchronous mass update of holders.
      const [{ security_version: userAVersionAfter }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [userA!.userId],
      );
      expect(userAVersionAfter).toBe(userAVersionBefore);
      void Role;
    });

    it('a user holding TWO roles still sees a changed rolePermissionVersion when only the LOWER-versioned one is edited (regression: MAX silently masked this, SUM does not)', async () => {
      // Found via an independent source review while this checkpoint was in progress, not by this
      // suite's own first pass: readVector originally used MAX(role.permission_version). A user
      // holding roles at versions (10, 1) who then has the SECOND role's definition changed
      // (1 -> 2) would see MAX(10, 2) = 10 — unchanged — silently hiding a real permission edit
      // behind a higher-versioned role the same user happens to also hold. Fixed to SUM, which a
      // monotonic-only-increases version column (SecurityVersionMonotonicGuard1786684000000) makes
      // injective: any single term increasing strictly increases the total.
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      const primaryRoleId = (
        await adminDataSource.query<Array<{ id: string }>>(`SELECT id FROM core.role WHERE key = $1 AND organisation_id = $2`, [user.roleKey, organisation.id])
      )[0]!.id;

      // A second, independent role, bumped to version 10 — far ahead of the primary role's version 1.
      const secondRoleId = (
        await adminDataSource.query<Array<{ id: string }>>(
          `INSERT INTO core.role (organisation_id, key, name, is_system) VALUES ($1, $2, 'Second Role', false) RETURNING id`,
          [organisation.id, `second-${randomUUID().slice(0, 8)}`],
        )
      )[0]!.id;
      // The monotonic guard trigger only allows exactly +1 per UPDATE — step up to 10 one at a time.
      for (let i = 0; i < 9; i++) {
        await adminDataSource.query(`UPDATE core.role SET permission_version = permission_version + 1 WHERE id = $1`, [secondRoleId]);
      }
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: user.userId, role: '' }, (m) =>
        m.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [user.userId, secondRoleId, organisation.id]),
      );

      const before = await readVectorFor(user);
      expect(before.rolePermissionVersion).toBe(11); // primary (1) + second (10)

      // Edit the LOWER-versioned (primary) role's own permissions — the exact real write path.
      const ctx = { organisationId: organisation.id, workspaceId: null, userId: user.userId, role: '' };
      await roleService.update(ctx, primaryRoleId, { permissionKeys: ['staff.view' as never] });

      const after = await readVectorFor(user);
      expect(after.rolePermissionVersion).toBeGreaterThan(before.rolePermissionVersion);
    });
  });

  describe('workspace membership lifecycle invalidation', () => {
    it('suspending then reinstating a membership bumps workspaceMembershipVersion each time', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true });
      const staffIdentity = managers[0]!;
      const before = await readVectorFor(staffIdentity);
      expect(before.workspaceMembershipVersion).not.toBeNull();

      const ctx = { organisationId: staffIdentity.organisationId, workspaceId: staffIdentity.workspaceId, userId: staffIdentity.userId, role: '' };
      await tenantContext.runInTenantContext(ctx, (m) => workspaceMembership.suspendForUser(m, staffIdentity.userId));
      const afterSuspend = await readVectorFor(staffIdentity);
      expect(afterSuspend.workspaceMembershipVersion).toBe(before.workspaceMembershipVersion! + 1);

      await tenantContext.runInTenantContext(ctx, (m) => workspaceMembership.reinstateForUser(m, staffIdentity.userId));
      const afterReinstate = await readVectorFor(staffIdentity);
      expect(afterReinstate.workspaceMembershipVersion).toBe(before.workspaceMembershipVersion! + 2);
    });
  });

  describe('platform-admin grant/revoke invalidation', () => {
    it('grant then revoke each bump the TARGET\'s platformAdminVersion, and a never-granted user reads 0', async () => {
      const { managers } = await factory.createOrganisationWithManagers(2, { permissions: 'production', firstIsPlatformAdmin: true });
      const [admin, target] = managers;
      const actorCtx = { userId: admin!.userId, organisationId: admin!.organisationId };

      const neverGranted = await readVectorFor(target!);
      expect(neverGranted.platformAdminVersion).toBe(0);

      await platformAdminService.grant(actorCtx, target!.userId, admin!.password);
      const afterGrant = await readVectorFor(target!);
      expect(afterGrant.platformAdminVersion).toBeGreaterThan(neverGranted.platformAdminVersion);

      await platformAdminService.revoke(actorCtx, target!.userId, admin!.password);
      const afterRevoke = await readVectorFor(target!);
      expect(afterRevoke.platformAdminVersion).toBeGreaterThan(afterGrant.platformAdminVersion);
    });
  });

  describe('organisation security-configuration invalidation — one counter for two different write paths', () => {
    it('an auth-provider toggle and a maintenance-mode toggle both bump the SAME organisation.security_version', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', firstIsPlatformAdmin: true });
      const admin = managers[0]!;
      const ctx = { organisationId: organisation.id, workspaceId: null, userId: admin.userId, role: '' };

      const [{ security_version: v0 }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core.organisation WHERE id = $1`,
        [organisation.id],
      );

      await orgAuthProviders.update(ctx, { googleAuthEnabled: false });
      const [{ security_version: v1 }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core.organisation WHERE id = $1`,
        [organisation.id],
      );
      expect(Number(v1)).toBe(Number(v0) + 1);

      await adminPanel.setMaintenanceMode(ctx, { enabled: true, message: 'p1d test' });
      const [{ security_version: v2 }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core.organisation WHERE id = $1`,
        [organisation.id],
      );
      expect(Number(v2)).toBe(Number(v1) + 1);

      // Cleanup: leave maintenance mode off so no other suite in this run observes it enabled.
      await adminPanel.setMaintenanceMode(ctx, { enabled: false });
    });
  });

  describe('session and user invalidation on logout / password change', () => {
    it('revoking a session family bumps that session row\'s own security_version (unchanged P1B semantics, not touched by P1D)', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      const familyId = randomUUID();
      await adminDataSource.query(
        `INSERT INTO core.user_session (id, organisation_id, user_id, application_target, created_at, last_seen_at, absolute_expires_at)
         VALUES ($1, $2, $3, 'manager_web', now(), now(), now() + interval '1 day')`,
        [familyId, organisation.id, user.userId],
      );
      const [{ security_version: before }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core.user_session WHERE id = $1`,
        [familyId],
      );
      await tenantContext.runInTenantContext(
        { organisationId: user.organisationId, workspaceId: null, userId: user.userId, role: '' },
        (m) => refreshTokenService.revokeAllForUser(m, user.userId, 'p1d_test'),
      );
      const [{ security_version: after }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core.user_session WHERE id = $1`,
        [familyId],
      );
      expect(Number(after)).toBe(Number(before) + 1);
    });

    it('an admin-triggered password reset bumps user.security_version', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const target = managers[0]!;
      const [{ security_version: before }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [target.userId],
      );
      const ctx = { organisationId: organisation.id, workspaceId: null, userId: target.userId, role: '' };
      await tenantContext.runInTenantContext(ctx, (m) =>
        accountLifecycle.adminResetPassword(m, ctx as never, {
          targetUserId: target.userId,
          targetEmail: target.email,
          targetFirstName: 'Test',
          organisationName: organisation.name,
        }),
      );
      const [{ security_version: after }] = await adminDataSource.query<Array<{ security_version: string }>>(
        `SELECT security_version FROM core."user" WHERE id = $1`,
        [target.userId],
      );
      expect(Number(after)).toBe(Number(before) + 1);
    });
  });

  describe('fail-closed: no tenant context bound', () => {
    it('readVector with zero GUCs bound (no runInTenantContext at all) returns an all-null/zero vector, never real data', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const user = managers[0]!;
      const vector = await dataSource.transaction((m) =>
        securityVersion.readVector(m, { sessionId: randomUUID(), userId: user.userId, organisationId: user.organisationId, workspaceId: user.workspaceId }),
      );
      expect(vector.sessionVersion).toBeNull();
      expect(vector.userVersion).toBeNull();
      expect(vector.rolePermissionVersion).toBe(0);
      expect(vector.workspaceMembershipVersion).toBeNull();
      expect(vector.platformAdminVersion).toBe(0);
      expect(vector.organisationVersion).toBeNull();
    });
  });
});
