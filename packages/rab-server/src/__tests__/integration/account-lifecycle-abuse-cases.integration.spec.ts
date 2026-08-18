import 'reflect-metadata';
import { PasswordResetTokenPurpose, PermissionFlag, UserStatus } from '@rab/shared';
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
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PasswordResetTokenService } from '../../engine/core-modules/auth/token/services/password-reset-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * Account-lifecycle abuse-case suite (rab-workforce-architecture.md §1.2):
 * real Postgres, RLS on, no mocks — the invite/reset emails themselves are
 * skipped (RESEND_API_KEY unset in CI), which is by design: token issuance,
 * `mustResetPassword`, session revocation and the audit trail all have to
 * work identically whether or not a live email provider is configured. See
 * auth-abuse-cases.integration.spec.ts for the base auth suite this extends.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const NEW_PASSWORD = 'a totally different S3cret!';

describeIfDb('account lifecycle abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let passwordResetTokens: PasswordResetTokenService;
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

    const insertResult = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
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
        await manager.insert(UserRole, {
          userId: userResult.identifiers[0]!.id as string,
          roleId,
          organisationId: organisation.id,
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
      { organisationId, userId: randomUUID(), role: '' },
      async (manager) => (await manager.findOneOrFail(User, { where: { organisationId, email } })).id,
    );
  }

  /** Creates a staff/manager account via the real endpoint and returns its temp password, unrevealed anywhere but this one response. */
  async function createAccount(
    organisation: Organisation,
    ownerToken: string,
    kind: 'staff' | 'internal-manager' | 'venue-manager',
  ): Promise<{ profileId: string; userId: string; email: string; temporaryPassword: string }> {
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

    const userId = await getUserIdByEmail(organisation.id, email);
    return { profileId: res.body.id as string, userId, email, temporaryPassword: res.body.temporaryPassword as string };
  }

  /** Creates an account and immediately completes its forced first-login reset, returning a normally-usable session. */
  async function provisionActiveUser(
    organisation: Organisation,
    ownerToken: string,
    kind: 'staff' | 'internal-manager' | 'venue-manager',
  ) {
    const account = await createAccount(organisation, ownerToken, kind);

    const login = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: account.email, password: account.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.mustResetPassword).toBe(true);

    await request(app.getHttpServer())
      .post('/rest/v1/auth/set-password')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ newPassword: NEW_PASSWORD })
      .expect(204);

    // set-password revoked the forced-reset login's refresh token, so sign
    // in again for a refresh token this account can actually still use.
    const freshLogin = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email: account.email, password: NEW_PASSWORD });
    expect(freshLogin.status).toBe(200);

    return { ...account, accessToken: freshLogin.body.accessToken as string, refreshToken: freshLogin.body.refreshToken as string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    passwordResetTokens = moduleRef.get(PasswordResetTokenService);
    tenantContext = moduleRef.get(TenantContextService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('mustResetPassword gate', () => {
    it('blocks a route the role would otherwise be allowed, exempts /auth/me, and clears once set-password completes', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);
      const staff = await createAccount(organisation, ownerToken, 'staff');

      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: staff.email, password: staff.temporaryPassword });
      expect(login.status).toBe(200);
      expect(login.body.mustResetPassword).toBe(true);
      const staffToken = login.body.accessToken as string;

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

      await request(app.getHttpServer())
        .post('/rest/v1/auth/set-password')
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ newPassword: NEW_PASSWORD })
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
      const staff = await createAccount(organisation, ownerToken, 'staff');

      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: staff.email, password: staff.temporaryPassword });
      const staffToken = login.body.accessToken as string;

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
      const staff = await createAccount(organisation, ownerToken, 'staff');

      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: staff.email, password: staff.temporaryPassword });
      const { accessToken, refreshToken } = login.body;

      await request(app.getHttpServer())
        .post('/rest/v1/auth/set-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ newPassword: NEW_PASSWORD })
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
        { organisationId: organisation.id, userId, role: '' },
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

    it('succeeds for an actor WITH USER_RESET_PASSWORD (an internal manager) and forces the target to reset again', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(organisation, ownerEmail);

      const internalManager = await provisionActiveUser(organisation, ownerToken, 'internal-manager');
      const targetStaff = await provisionActiveUser(organisation, ownerToken, 'staff');

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
