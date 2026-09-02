import 'reflect-metadata';
import { ManagerType, PasswordResetTokenPurpose, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  Organisation,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { AccountInviteService } from '../../engine/core-modules/auth/services/account-invite.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PasswordResetTokenService } from '../../engine/core-modules/auth/token/services/password-reset-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Account-lifecycle abuse-case suite (rab-workforce-architecture.md §1.2):
 * real Postgres, RLS on, no mocks — the invite/reset emails themselves just
 * log (EMAIL_DRIVER defaults to LOGGER in CI, no SMTP configured), which is
 * by design: token issuance, `mustResetPassword`, session revocation and the
 * audit trail all have to work identically whether or not a live SMTP
 * provider is configured. See
 * auth-abuse-cases.integration.spec.ts for the base auth suite this extends.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const NEW_PASSWORD = 'a totally different S3cret!';

describeIfDb('account lifecycle abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let passwordResetTokens: PasswordResetTokenService;
  let accountInvites: AccountInviteService;
  let tenantContext: TenantContextService;

  const ownerPassword = 'correct horse battery staple 1!';

  // The owner gets every permission this suite exercises — these tests are
  // about the account-lifecycle flows, not about proving permission grants.
  const OWNER_PERMISSIONS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.USER_RESET_PASSWORD,
  ];

  async function seedOrgWithOwner(): Promise<{ organisation: Organisation; ownerEmail: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `owner-${randomUUID()}@example.test`;

    const insertResult = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
      async (manager) => {
        const permissions = await Promise.all(
          OWNER_PERMISSIONS.map(async (key) => {
            let permission = await manager.findOne(Permission, { where: { key } });
            if (!permission) {
              const [resource, action] = key.split('.');
              permission = await manager.save(Permission, { key, resource: resource!, action: action ?? key });
            }
            return permission;
          }),
        );

        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: `owner-${randomUUID()}`,
          name: 'Owner',
          isSystem: true,
        });
        const roleId = roleResult.identifiers[0]!.id as string;
        await manager.insert(
          RolePermission,
          permissions.map((permission) => ({ roleId, permissionId: permission.id, organisationId: organisation.id })),
        );

        const passwordHash = await passwordHashing.hash(ownerPassword);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: 'Test',
          lastName: 'Owner',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await manager.insert(UserRole, {
          userId,
          roleId,
          organisationId: organisation.id,
        });
        // A real ManagerWorkspace, otherwise this owner's resolved
        // workspaceId stays NULL forever and POST /staff's real INSERT
        // trips the combined org+workspace RLS WITH CHECK (NULL = NULL is
        // never true) — matching the fix already applied to this session's
        // other abuse-case specs. manager_workspace_write's own WITH CHECK
        // also requires owner_user_id = current_uid() — rebind it to the
        // real new user, not this transaction's throwaway bootstrap identity.
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
        const workspace = await manager.save(ManagerWorkspace, {
          organisationId: organisation.id,
          ownerUserId: userId,
          name: `Test Workspace ${userId}`,
          subdomain: `test-${userId.slice(0, 8)}`,
          status: 'active',
        });
        await manager.insert(ManagerProfile, {
          organisationId: organisation.id,
          userId,
          type: ManagerType.INTERNAL,
          workspaceId: workspace.id,
        });
      },
    );

    return { organisation, ownerEmail: email };
  }

  async function loginOwner(organisation: Organisation, ownerEmail: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: ownerEmail, password: ownerPassword });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function getUserIdByEmail(organisationId: string, email: string): Promise<string> {
    return tenantContext.runInTenantContext(
      { organisationId, workspaceId: null, userId: randomUUID(), role: '' },
      async (manager) => (await manager.findOneOrFail(User, { where: { organisationId, email } })).id,
    );
  }

  /**
   * Creates a staff/manager account via the real endpoint — PENDING
   * (INVITED), no password, per the invitation-based activation flow (see
   * `account-invite-abuse-cases.integration.spec.ts` for the flow's own
   * dedicated test coverage). No raw token is returned here: the real
   * response never carries one (only `invite.sendNumber`/`expiresAt`) —
   * exactly like the admin never seeing a raw email-delivered token in
   * production. Callers that need to actually activate use
   * `activateViaFreshToken` below.
   */
  async function createAccount(
    organisation: Organisation,
    ownerToken: string,
    kind: 'staff' | 'internal-manager' | 'venue-manager',
  ): Promise<{ profileId: string; userId: string; email: string }> {
    const email = `${kind}-${randomUUID()}@example.test`;
    const res =
      kind === 'staff'
        ? await request(app.getHttpServer())
            .post('/rest/v1/staff')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ email, firstName: 'Test', lastName: 'User', staffRef: `STF-${randomUUID().slice(0, 8)}` })
        : await request(app.getHttpServer())
            .post('/rest/v1/managers')
            .set('Authorization', `Bearer ${ownerToken}`)
            .send({ email, firstName: 'Test', lastName: 'User', type: kind === 'internal-manager' ? 'internal' : 'venue' });
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeUndefined();
    expect(typeof res.body.invite?.sendNumber).toBe('number');

    const userId = await getUserIdByEmail(organisation.id, email);
    return { profileId: res.body.id as string, userId, email };
  }

  /**
   * Mints a fresh raw activation token for an already-created PENDING user
   * by calling `AccountInviteService.prepare()`+`commit()` directly (the raw
   * token is never persisted anywhere — only its hash — so this is the same
   * "call the token service directly to get a usable raw value" pattern
   * `reset token single-use` below already uses for `PasswordResetTokenService`;
   * production splits the two so a failed email send never consumes an
   * attempt — see AccountInviteService's own doc comment — but this test
   * helper bypasses the email step entirely and always commits).
   * Revokes whatever `createAccount()`'s own real HTTP call already issued
   * and issues the next attempt in its place — harmless for every test
   * using this helper, none of which assert a specific attempt number.
   */
  async function activateViaFreshToken(organisation: Organisation, userId: string, email: string, password: string): Promise<void> {
    const { token } = await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId, role: '' }, async (manager) => {
      const prepared = await accountInvites.prepare(manager, userId);
      await accountInvites.commit(manager, { organisationId: organisation.id, userId, createdBy: null, ...prepared });
      return prepared;
    });
    await request(app.getHttpServer())
      .post('/rest/v1/auth/activate-account')
      .send({ token, newPassword: password })
      .expect(204);
    void email;
  }

  /** Creates an account and immediately activates it, returning a normally-usable session. */
  async function provisionActiveUser(
    organisation: Organisation,
    ownerToken: string,
    kind: 'staff' | 'internal-manager' | 'venue-manager',
  ) {
    const account = await createAccount(organisation, ownerToken, kind);
    await activateViaFreshToken(organisation, account.userId, account.email, NEW_PASSWORD);

    // Mobile-flagged so it comes back in the body — this helper's callers
    // need the raw value to exercise refresh-token-specific behavior.
    const login = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .set('X-Client-Platform', 'mobile')
      .send({ email: account.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mustResetPassword).toBe(false);

    return { ...account, accessToken: login.body.accessToken as string, refreshToken: login.body.refreshToken as string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    passwordResetTokens = moduleRef.get(PasswordResetTokenService);
    accountInvites = moduleRef.get(AccountInviteService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  /**
   * Triggers `mustResetPassword: true` via an ADMIN reset on an already-
   * ACTIVE account — the only way this flag is ever set since the
   * invitation-based activation flow shipped (account creation no longer
   * sets it; `AccountLifecycleService.adminResetPassword` still does). The
   * target's real password is UNCHANGED by an admin reset (only a fresh
   * setup link is emailed) — the same password still logs in, now flagged.
   */
  async function forceResetFlag(organisation: Organisation, ownerToken: string, target: { profileId: string; email: string }): Promise<string> {
    await request(app.getHttpServer())
      .post(`/rest/v1/staff/${target.profileId}/reset-password`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: target.email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mustResetPassword).toBe(true);
    return login.body.accessToken as string;
  }

  describe('mustResetPassword gate', () => {
    it('blocks a route the role would otherwise be allowed, exempts /auth/me, and clears once set-password completes', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);
      const staff = await provisionActiveUser(organisation, ownerToken, 'staff');
      const staffToken = await forceResetFlag(organisation, ownerToken, staff);

      // Exempt route still works while the flag is set.
      const me = await request(app.getHttpServer())
        .get('/rest/v1/auth/me')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(me.status).toBe(200);

      // A non-exempt route the staff role WOULD be allowed (OFFER_RESPOND) is blocked by the gate, not by permissions.
      const blocked = await request(app.getHttpServer())
        .get('/rest/v1/offers/mine')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(blocked.status).toBe(403);

      const ANOTHER_NEW_PASSWORD = 'a third, still-different S3cret!';
      await request(app.getHttpServer())
        .post('/rest/v1/auth/set-password')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ newPassword: ANOTHER_NEW_PASSWORD })
        .expect(204);

      // Same access token, now allowed — the flag, not the token, was gating it.
      const allowed = await request(app.getHttpServer())
        .get('/rest/v1/offers/mine')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(allowed.status).toBe(200);
    });

    it('rejects a weak new password and leaves the flag set', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);
      const staff = await provisionActiveUser(organisation, ownerToken, 'staff');
      const staffToken = await forceResetFlag(organisation, ownerToken, staff);

      const weak = await request(app.getHttpServer())
        .post('/rest/v1/auth/set-password')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ newPassword: 'password1' });
      expect(weak.status).toBe(400);

      const stillBlocked = await request(app.getHttpServer())
        .get('/rest/v1/offers/mine')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(stillBlocked.status).toBe(403);
    });
  });

  describe('set-password session invalidation', () => {
    it('revokes the refresh token issued at the forced-reset login once set-password completes', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);
      const staff = await provisionActiveUser(organisation, ownerToken, 'staff');
      await request(app.getHttpServer())
        .post(`/rest/v1/staff/${staff.profileId}/reset-password`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(204);

      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .set('X-Client-Platform', 'mobile')
        .send({ email: staff.email, password: NEW_PASSWORD });
      const { accessToken, refreshToken } = login.body;

      const ANOTHER_NEW_PASSWORD = 'a third, still-different S3cret!';
      await request(app.getHttpServer())
        .post('/rest/v1/auth/set-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ newPassword: ANOTHER_NEW_PASSWORD })
        .expect(204);

      const refresh = await request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .send({ refreshToken });
      expect(refresh.status).toBe(401);
    });
  });

  describe('forgot password — no account enumeration', () => {
    it('returns the identical response for a real and a fake email', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();

      const real = await request(app.getHttpServer())
        .post('/rest/v1/auth/forgot-password')
        .send({ email: ownerEmail });
      const fake = await request(app.getHttpServer())
        .post('/rest/v1/auth/forgot-password')
        .send({ email: 'nobody@example.test' });

      expect(real.status).toBe(204);
      expect(fake.status).toBe(204);
      expect(real.body).toEqual(fake.body);
    });
  });

  describe('reset token single-use', () => {
    it('cannot be consumed a second time', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const userId = await getUserIdByEmail(organisation.id, ownerEmail);

      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId, role: '' },
        (manager) =>
          passwordResetTokens.issue(manager, {
            organisationId: organisation.id,
            userId,
            purpose: PasswordResetTokenPurpose.FORGOT_PASSWORD,
          }),
      );

      const first = await request(app.getHttpServer())
        .post('/rest/v1/auth/reset-password')
        .send({ token, newPassword: NEW_PASSWORD });
      expect(first.status).toBe(204);

      const second = await request(app.getHttpServer())
        .post('/rest/v1/auth/reset-password')
        .send({ token, newPassword: 'Some0therSecret!!' });
      expect(second.status).toBe(400);
    });
  });

  describe('admin password reset — permission-gated', () => {
    it('403s for an actor without USER_RESET_PASSWORD (a venue manager)', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);

      const venueManager = await provisionActiveUser(organisation, ownerToken, 'venue-manager');
      const targetStaff = await createAccount(organisation, ownerToken, 'staff');

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${targetStaff.profileId}/reset-password`)
        .set('Authorization', `Bearer ${venueManager.accessToken}`);
      expect(res.status).toBe(403);
    });

    it('succeeds for an actor WITH USER_RESET_PASSWORD (an internal manager) resetting their own Staff, and forces the target to reset again', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);

      const internalManager = await provisionActiveUser(organisation, ownerToken, 'internal-manager');
      // A freshly-created Manager has no private Workspace of their own yet
      // — RequireWorkspaceGuard blocks Staff creation until onboarding
      // completes (Stage 2A, unrelated to this test's own subject).
      const onboard = await request(app.getHttpServer())
        .post('/rest/v1/manager-workspaces')
        .set('Authorization', `Bearer ${internalManager.accessToken}`)
        .send({ name: 'Internal Manager Workspace', subdomain: `im-${randomUUID().slice(0, 8)}` });
      expect(onboard.status).toBe(201);

      // Created via the manager's OWN token, not the org owner's — Staff is
      // privately owned per Manager (Increment 2), and USER_RESET_PASSWORD
      // alone was never meant to bypass that; it's the permission gate on
      // top of the ownership check, not instead of it.
      const targetStaff = await provisionActiveUser(organisation, internalManager.accessToken, 'staff');

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${targetStaff.profileId}/reset-password`)
        .set('Authorization', `Bearer ${internalManager.accessToken}`);
      expect(res.status).toBe(204);

      // The target's existing refresh token is revoked (their still-live
      // access token isn't retroactively killed — same as /auth/logout;
      // it's a stateless JWT valid until its own natural expiry).
      const refresh = await request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .send({ refreshToken: targetStaff.refreshToken });
      expect(refresh.status).toBe(401);

      // A fresh login now reports mustResetPassword again.
      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: targetStaff.email, password: NEW_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.mustResetPassword).toBe(true);
    });

    it("404s (not 403) for an admin reset-password attempt across tenants", async () => {
      const orgA = await seedOrgWithOwner();
      const ownerAToken = await loginOwner(orgA.organisation, orgA.ownerEmail);

      const orgB = await seedOrgWithOwner();
      const ownerBToken = await loginOwner(orgB.organisation, orgB.ownerEmail);
      const staffInOrgB = await createAccount(orgB.organisation, ownerBToken, 'staff');

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${staffInOrgB.profileId}/reset-password`)
        .set('Authorization', `Bearer ${ownerAToken}`);
      expect(res.status).toBe(404);
    });
  });
});
