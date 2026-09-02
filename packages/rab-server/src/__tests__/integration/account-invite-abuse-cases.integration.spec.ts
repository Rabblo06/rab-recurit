import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AccountInvite, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { AccountInviteService } from '../../engine/core-modules/auth/services/account-invite.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { runAccountInviteCleanupCycle } from '../../queue-worker/jobs/account-invite-cleanup.job';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * The invitation-based account-activation flow (RAB — EMAIL INVITATION +
 * ACCOUNT ACTIVATION + SAFE CLEANUP). Real Postgres, RLS on, no mocks —
 * invitation emails just log (EMAIL_DRIVER defaults to LOGGER in this
 * environment), matching every other email-touching suite in this codebase.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('account invitation abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let accountInvites: AccountInviteService;
  let tenantContext: TenantContextService;

  const ownerPassword = 'correct horse battery staple 1!';
  const OWNER_PERMISSIONS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.USER_RESET_PASSWORD,
  ];

  async function seedOrgWithOwner(): Promise<{ organisation: Organisation; ownerEmail: string; ownerUserId: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `owner-${randomUUID()}@example.test`;

    const insertResult = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: insertResult.identifiers[0]!.id as string });

    let ownerUserId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
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

      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `owner-${randomUUID()}`, name: 'Owner', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      await manager.insert(RolePermission, permissions.map((p) => ({ roleId, permissionId: p.id, organisationId: organisation.id })));

      const userResult = await manager.insert(User, {
        organisationId: organisation.id,
        email,
        passwordHash: await hashOwnerPassword(),
        firstName: 'Test',
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId, organisationId: organisation.id });

      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId,
        name: `Test Workspace ${ownerUserId}`,
        subdomain: `test-${ownerUserId.slice(0, 8)}`,
        status: 'active',
      });
      await manager.insert(ManagerProfile, { organisationId: organisation.id, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
    });

    return { organisation, ownerEmail: email, ownerUserId };
  }

  let passwordHashingService: PasswordHashingService;
  async function hashOwnerPassword(): Promise<string> {
    return passwordHashingService.hash(ownerPassword);
  }

  async function loginOwner(ownerEmail: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Test-only convenience mirroring the OLD single-call `issue()` shape — production now splits `prepare()` (no write) from `commit()` (called only after a real successful email send, see AccountLifecycleService.sendAccountInvite) so a delivery failure never burns an attempt. Tests bypass the email step entirely and always commit. */
  async function issueForTest(manager: EntityManager, organisationId: string, userId: string): Promise<{ token: string; sendNumber: number; expiresAt: Date }> {
    const prepared = await accountInvites.prepare(manager, userId);
    await accountInvites.commit(manager, { organisationId, userId, createdBy: null, ...prepared });
    return prepared;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    accountInvites = moduleRef.get(AccountInviteService);
    tenantContext = moduleRef.get(TenantContextService);
    passwordHashingService = moduleRef.get(PasswordHashingService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('creation', () => {
    it('creates a Staff/Manager account PENDING (invited), with no password and a delivered invitation', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const res = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      expect(res.status).toBe(201);
      expect(res.body.accountStatus).toBe('invited');
      expect(res.body.temporaryPassword).toBeUndefined();
      expect(res.body.invite.sendNumber).toBe(1);
      expect(res.body.invite.delivered).toBe(true);
      expect(res.body.pendingInvite.sendNumber).toBe(1);
      expect(res.body.pendingInvite.maxSendAttempts).toBe(3);

      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: res.body.email });
      expect(userRow.status).toBe('invited');
      // password_hash has `select: false` — a plain find() never returns it
      // (property absent, not null) regardless of the column's own value;
      // a raw query is the only way to actually see it.
      const [{ password_hash: passwordHash }] = await adminDataSource.manager.query<[{ password_hash: string | null }]>(
        `SELECT password_hash FROM core."user" WHERE id = $1`,
        [userRow.id],
      );
      expect(passwordHash).toBeNull();
    });

    it('GET /staff/:id and GET /managers/:id also report the real pendingInvite (not just the create() response and list())', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const staffCreate = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const staffGet = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffCreate.body.id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(staffGet.status).toBe(200);
      expect(staffGet.body.pendingInvite?.sendNumber).toBe(1);
      expect(staffGet.body.pendingInvite?.maxSendAttempts).toBe(3);

      const mgrCreate = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const mgrGet = await request(app.getHttpServer()).get(`/rest/v1/managers/${mgrCreate.body.id}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(mgrGet.status).toBe(200);
      expect(mgrGet.body.pendingInvite?.sendNumber).toBe(1);
      expect(mgrGet.body.pendingInvite?.maxSendAttempts).toBe(3);
    });

    it('never stores the raw activation token — only its SHA-256 hash', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const email = `staff-${randomUUID()}@example.test`;
      await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` })
        .expect(201);

      const userRow = await adminDataSource.manager.findOneByOrFail(User, { email });
      const invite = await adminDataSource.manager.findOneByOrFail(AccountInvite, { userId: userRow.id });
      expect(invite.tokenHash).toHaveLength(64); // hex sha256
      expect(invite.tokenHash).not.toContain(' ');
    });

    it('email normalization: whitespace/case variants collide as the same identity', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const base = `Collide.${randomUUID()}@Example.TEST`;

      const first = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `  ${base}  `, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      expect(first.status).toBe(201);
      expect(first.body.email).toBe(base.trim().toLowerCase());

      const dup = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: base.toUpperCase(), firstName: 'C', lastName: 'D', staffRef: `S-${randomUUID().slice(0, 6)}` });
      expect(dup.status).toBe(409);
    });
  });

  describe('activation', () => {
    async function createPendingStaff(ownerToken: string): Promise<{ profileId: string; userId: string; email: string; organisationId: string }> {
      const email = `staff-${randomUUID()}@example.test`;
      const res = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      expect(res.status).toBe(201);
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { email });
      return { profileId: res.body.id, userId: userRow.id, email, organisationId: userRow.organisationId };
    }

    it('a valid token activates the account: sets a real password, status ACTIVE, emailVerifiedAt, and the invite becomes accepted', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const pending = await createPendingStaff(ownerToken);

      // Read the raw token straight off the just-issued invite via a direct
      // AccountInviteService call — the raw value is never persisted or
      // returned by the HTTP API (by design), so this mirrors exactly how
      // account-lifecycle-abuse-cases.integration.spec.ts already handles
      // PasswordResetTokenService for the equivalent limitation.
      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: pending.userId, role: '' },
        (manager) => issueForTest(manager, organisation.id, pending.userId),
      );

      const activate = await request(app.getHttpServer())
        .post('/rest/v1/auth/activate-account')
        .send({ token, newPassword: 'a totally different S3cret!' });
      expect(activate.status).toBe(204);

      const userRow = await adminDataSource.manager.findOneByOrFail(User, { id: pending.userId });
      expect(userRow.status).toBe('active');
      expect(userRow.passwordHash).not.toBeNull();
      expect(userRow.mustResetPassword).toBe(false);
      expect(userRow.emailVerifiedAt).not.toBeNull();

      const login = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: pending.email, password: 'a totally different S3cret!' });
      expect(login.status).toBe(200);
    });

    it('the same token cannot be used twice — concurrent double-activation is race-safe (exactly one succeeds)', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const pending = await createPendingStaff(ownerToken);
      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: pending.userId, role: '' },
        (manager) => issueForTest(manager, organisation.id, pending.userId),
      );

      const [a, b] = await Promise.all([
        request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token, newPassword: 'firstPassw0rd!!' }),
        request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token, newPassword: 'secondPassw0rd!!' }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([204, 400]);

      const userRow = await adminDataSource.manager.findOneByOrFail(User, { id: pending.userId });
      expect(userRow.status).toBe('active');
    });

    it('an unknown/garbage token is rejected with the same generic message as expired/used/revoked (no enumeration)', async () => {
      const res = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token: 'not-a-real-token', newPassword: 'whatever12345!!' });
      expect(res.status).toBe(400);
    });

    it('a revoked token (e.g. superseded by a resend) cannot activate', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const pending = await createPendingStaff(ownerToken);
      const { token: firstToken } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: pending.userId, role: '' },
        (manager) => issueForTest(manager, organisation.id, pending.userId),
      );
      // Resend via the real endpoint — revokes firstToken, issues a new one.
      await request(app.getHttpServer())
        .post(`/rest/v1/staff/${pending.profileId}/resend-invite`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(201);

      const res = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token: firstToken, newPassword: 'whatever12345!!' });
      expect(res.status).toBe(400);
    });

    it('an expired token cannot activate', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const pending = await createPendingStaff(ownerToken);
      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: pending.userId, role: '' },
        (manager) => issueForTest(manager, organisation.id, pending.userId),
      );
      await adminDataSource.manager.query(`UPDATE core.account_invite SET expires_at = now() - interval '1 hour' WHERE token_hash = $1`, [hashToken(token)]);

      const res = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token, newPassword: 'whatever12345!!' });
      expect(res.status).toBe(400);
    });

    it('a client-supplied userId/organisationId/role in the activation body is rejected by DTO whitelisting, never applied', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const pending = await createPendingStaff(ownerToken);
      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: pending.userId, role: '' },
        (manager) => issueForTest(manager, organisation.id, pending.userId),
      );

      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/activate-account')
        .send({ token, newPassword: 'whatever12345!!', userId: randomUUID(), organisationId: randomUUID(), role: 'super_admin' });
      expect(res.status).toBe(400); // forbidNonWhitelisted rejects the unknown fields outright
    });
  });

  describe('3-attempt resend semantics', () => {
    it('attempt 1 = creation, first resend = 2, second resend = 3, a 4th resend is rejected — each new attempt revokes the previous token', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const email = `staff-${randomUUID()}@example.test`;
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      expect(create.body.invite.sendNumber).toBe(1);
      const profileId = create.body.id as string;
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { email });

      const resend2 = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(resend2.status).toBe(201);
      expect(resend2.body.sendNumber).toBe(2);

      const resend3 = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(resend3.status).toBe(201);
      expect(resend3.body.sendNumber).toBe(3);

      const resend4 = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(resend4.status).toBe(409);

      // Exactly one active (unrevoked, unaccepted) invite row exists — attempt 3's.
      const rows = await adminDataSource.manager.find(AccountInvite, { where: { userId: userRow.id } });
      expect(rows).toHaveLength(3);
      const active = rows.filter((r) => !r.revokedAt && !r.acceptedAt);
      expect(active).toHaveLength(1);
      expect(active[0]!.sendNumber).toBe(3);
      expect(active[0]!.cleanupAt).not.toBeNull(); // only the 3rd (final) attempt gets a cleanup deadline
    });

    it('cross-workspace: Manager B cannot resend/change-email/cancel Manager A\'s pending Staff invite (404, not 403)', async () => {
      const ownerA = await seedOrgWithOwner();
      const ownerAToken = await loginOwner(ownerA.ownerEmail);
      const ownerB = await seedOrgWithOwner();
      const ownerBToken = await loginOwner(ownerB.ownerEmail);

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerAToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;

      const resend = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/resend-invite`).set('Authorization', `Bearer ${ownerBToken}`);
      expect(resend.status).toBe(404);
      const cancel = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerBToken}`);
      expect(cancel.status).toBe(404);
      const changeEmail = await request(app.getHttpServer())
        .patch(`/rest/v1/staff/${profileId}/pending-email`)
        .set('Authorization', `Bearer ${ownerBToken}`)
        .send({ email: `other-${randomUUID()}@example.test` });
      expect(changeEmail.status).toBe(404);
    });
  });

  describe('change pending email', () => {
    it('revokes the old token (old email can never activate again), issues a fresh one to the new email, keeps the attempt count cumulative', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const oldEmail = `staff-${randomUUID()}@example.test`;
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: oldEmail, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { email: oldEmail });
      const { token: oldToken } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' },
        (manager) => issueForTest(manager, organisation.id, userRow.id),
      );

      const newEmail = `corrected-${randomUUID()}@example.test`;
      const change = await request(app.getHttpServer())
        .patch(`/rest/v1/staff/${profileId}/pending-email`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: newEmail });
      expect(change.status).toBe(200);
      expect(change.body.sendNumber).toBe(3); // cumulative: 1 (create) + 1 (the direct issue() above) + 1 (this change)

      const staleActivate = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token: oldToken, newPassword: 'whatever12345!!' });
      expect(staleActivate.status).toBe(400);

      const updatedUser = await adminDataSource.manager.findOneByOrFail(User, { id: userRow.id });
      expect(updatedUser.email).toBe(newEmail);
    });

    it('rejects changing to an email already in use within the org', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;

      const change = await request(app.getHttpServer())
        .patch(`/rest/v1/staff/${profileId}/pending-email`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: ownerEmail });
      expect(change.status).toBe(409);
    });
  });

  describe('cancel invitation', () => {
    it('revokes the active token WITHOUT touching User.status (never SUSPENDED/DEACTIVATED — a cancelled invite is not an account state)', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });

      const cancel = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(cancel.status).toBe(204);

      // Account state untouched — still INVITED, not SUSPENDED/DEACTIVATED.
      const updated = await adminDataSource.manager.findOneByOrFail(User, { id: userRow.id });
      expect(updated.status).toBe('invited');

      // The old (create-time) token is dead — cancel revoked it.
      const get = await request(app.getHttpServer()).get(`/rest/v1/staff/${profileId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(get.body.invitationStatus).toBe('cancelled');
      expect(get.body.accountStatus).toBe('invited');
      expect(get.body.pendingInvite).not.toBeNull(); // still exposes sendNumber/etc for the "was invitation N of 3" UI copy
    });

    it('a cancelled invitation token can never be accepted', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' },
        (manager) => issueForTest(manager, organisation.id, userRow.id),
      );

      const cancel = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(cancel.status).toBe(204);

      const activate = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token, newPassword: 'whatever12345!!' });
      expect(activate.status).toBe(400);
    });

    it('Re-invite (the existing resend-invite endpoint) issues a brand-new token and returns the account to PENDING — the old cancelled token remains permanently invalid', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
      const { token: cancelledToken } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' },
        (manager) => issueForTest(manager, organisation.id, userRow.id),
      );

      const cancel = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(cancel.status).toBe(204);

      const reinvite = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/resend-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(reinvite.status).toBe(201);
      expect(reinvite.body.delivered).toBe(true);

      const afterReinvite = await request(app.getHttpServer()).get(`/rest/v1/staff/${profileId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(afterReinvite.body.invitationStatus).toBe('pending');
      expect(afterReinvite.body.accountStatus).toBe('invited');

      // The pre-cancel token is still dead after re-invite (a new token, never a resurrected old one).
      const staleActivate = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token: cancelledToken, newPassword: 'whatever12345!!' });
      expect(staleActivate.status).toBe(400);

      // The brand-new token from Re-invite works.
      const newRow = await adminDataSource.manager.findOne(AccountInvite, {
        where: { userId: userRow.id },
        order: { createdAt: 'DESC' },
      });
      expect(newRow!.revokedAt).toBeNull();
      expect(newRow!.acceptedAt).toBeNull();
    });

    it('cancelling twice is a safe no-op the second time (idempotent-safe, never an ambiguous partial state)', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;

      const first = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(first.status).toBe(204);
      const second = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
      expect(second.status).toBe(204);

      const get = await request(app.getHttpServer()).get(`/rest/v1/staff/${profileId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(get.body.invitationStatus).toBe('cancelled');
      expect(get.body.accountStatus).toBe('invited');
    });
  });

  describe('reactivate (a genuinely SUSPENDED account, never a cancelled invite)', () => {
    it('an ACTIVE Manager can be suspended then reactivated, and reactivation is rejected on an account that was never activated', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const managerId = create.body.id as string;
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });

      // Reactivating a never-activated (still INVITED) account is rejected —
      // INVITED -> ACTIVE is only reachable via real invitation acceptance.
      const prematureReactivate = await request(app.getHttpServer())
        .post(`/rest/v1/managers/${managerId}/reactivate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(prematureReactivate.status).toBe(409);

      // Activate for real, then suspend, then reactivate.
      const { token } = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' },
        (manager) => issueForTest(manager, organisation.id, userRow.id),
      );
      const realPassword = 'a totally different S3cret!';
      const activate = await request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token, newPassword: realPassword });
      expect(activate.status).toBe(204);

      const suspend = await request(app.getHttpServer()).post(`/rest/v1/managers/${managerId}/deactivate`).set('Authorization', `Bearer ${ownerToken}`);
      expect(suspend.status).toBe(201);
      expect(suspend.body.accountStatus).toBe('suspended');

      const reactivate = await request(app.getHttpServer()).post(`/rest/v1/managers/${managerId}/reactivate`).set('Authorization', `Bearer ${ownerToken}`);
      expect(reactivate.status).toBe(201);
      expect(reactivate.body.accountStatus).toBe('active');
      expect(reactivate.body.invitationStatus).toBeNull();

      // The existing password (set at activation) still works — reactivate never resets it.
      const login = await request(app.getHttpServer())
        .post('/rest/v1/auth/login')
        .send({ email: create.body.email, password: realPassword });
      expect(login.status).toBe(200);

      // Suspend/Reactivate are both auditable actions (§17) — previously
      // neither wrote any audit_log row at all.
      const rows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' },
        (manager) => manager.query(`SELECT action, actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND target_user_id = $2 ORDER BY created_at`, [organisation.id, userRow.id]),
      );
      const actions = rows.map((r: { action: string }) => r.action);
      expect(actions).toContain('user.suspended');
      expect(actions).toContain('user.reactivated');
    });
  });

  describe('reset-password guard on a pending account', () => {
    it('rejects an admin "reset password" attempt on a not-yet-activated account', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const profileId = create.body.id as string;

      const res = await request(app.getHttpServer()).post(`/rest/v1/staff/${profileId}/reset-password`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(409);
    });
  });

  describe('cleanup job', () => {
    it('expires an account whose final (3rd) invite has passed expires_at, and never touches an unexpired one', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
      // Force this straight to attempt 3 (bypassing the 24h real wait) and expire it.
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
        await issueForTest(manager, organisation.id, userRow.id);
        await issueForTest(manager, organisation.id, userRow.id);
      });
      await adminDataSource.manager.query(
        `UPDATE core.account_invite SET expires_at = now() - interval '1 minute', cleanup_at = now() + interval '6 days'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
        [userRow.id],
      );

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.expired).toBeGreaterThanOrEqual(1);

      const updated = await adminDataSource.manager.findOneByOrFail(User, { id: userRow.id });
      expect(updated.status).toBe('invite_expired');
    });

    it('does not hard-delete before the 7-day grace period passes, and is a no-op re-run (idempotent)', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
        await issueForTest(manager, organisation.id, userRow.id);
        await issueForTest(manager, organisation.id, userRow.id);
      });
      // Expired, but grace period NOT yet passed (cleanup_at in the future).
      await adminDataSource.manager.query(
        `UPDATE core.account_invite SET expires_at = now() - interval '1 minute', cleanup_at = now() + interval '6 days'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
        [userRow.id],
      );

      const first = await runAccountInviteCleanupCycle(adminDataSource);
      expect(first.deleted).toBe(0);
      const stillThere = await adminDataSource.manager.findOne(User, { where: { id: userRow.id } });
      expect(stillThere).not.toBeNull();
      expect(stillThere!.status).toBe('invite_expired');

      const second = await runAccountInviteCleanupCycle(adminDataSource);
      expect(second.expired).toBe(0); // already expired — idempotent, not re-counted
      expect(second.deleted).toBe(0);
    });

    it('safely hard-deletes a genuinely dependency-free account once the grace period has passed', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` });
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
        await issueForTest(manager, organisation.id, userRow.id);
        await issueForTest(manager, organisation.id, userRow.id);
      });
      await adminDataSource.manager.query(
        `UPDATE core.account_invite SET expires_at = now() - interval '8 days', cleanup_at = now() - interval '1 minute'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
        [userRow.id],
      );

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.deleted).toBeGreaterThanOrEqual(1);

      const gone = await adminDataSource.manager.findOne(User, { where: { id: userRow.id } });
      expect(gone).toBeNull();
      const inviteRowsGone = await adminDataSource.manager.find(AccountInvite, { where: { userId: userRow.id } });
      expect(inviteRowsGone).toHaveLength(0); // cascaded
    });

    it('never hard-deletes an account that has created real business data (e.g. a Venue) — retains it instead', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', type: 'internal' });
      const userRow = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: create.body.email });
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: userRow.id, role: '' }, async (manager) => {
        await issueForTest(manager, organisation.id, userRow.id);
        await issueForTest(manager, organisation.id, userRow.id);
      });
      await adminDataSource.manager.query(
        `UPDATE core.account_invite SET expires_at = now() - interval '8 days', cleanup_at = now() - interval '1 minute'
         WHERE user_id = $1 AND revoked_at IS NULL AND accepted_at IS NULL`,
        [userRow.id],
      );
      // Simulate this pending Manager having (somehow) created a Venue —
      // real business data that must block deletion regardless of pending
      // state. `venue`'s own WITH CHECK requires BOTH organisation_id AND
      // workspace_id to match current context (confirmed via pg_policy, not
      // assumed) — reuse the org's real workspace (created for the owner in
      // seedOrgWithOwner) rather than NULL, which can never satisfy a plain
      // `=` check against itself.
      const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE organisation_id = $1 LIMIT 1`,
        [organisation.id],
      );
      await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId, userId: userRow.id, role: '' }, (manager) =>
        manager.query(`INSERT INTO core.venue (organisation_id, workspace_id, name, created_by) VALUES ($1, $2, 'Test Venue', $3)`, [
          organisation.id,
          workspaceId,
          userRow.id,
        ]),
      );

      const result = await runAccountInviteCleanupCycle(adminDataSource);
      expect(result.retained).toBeGreaterThanOrEqual(1);
      expect(result.deleted).toBe(0);

      const stillThere = await adminDataSource.manager.findOneByOrFail(User, { id: userRow.id });
      expect(stillThere.status).toBe('invite_expired'); // retained, not silently reverted to active or deleted
    });

    it('never touches an already-ACTIVE user, even one whose status happens to look similar', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      // The org owner itself is ACTIVE, has no account_invite row at all —
      // the cleanup job's candidate query structurally can't select it
      // (it JOINs on account_invite with send_number = 3), but assert the
      // row is untouched after a real cleanup cycle regardless.
      const before = await adminDataSource.manager.findOneByOrFail(User, { organisationId: organisation.id, email: ownerEmail });
      await runAccountInviteCleanupCycle(adminDataSource);
      const after = await adminDataSource.manager.findOneByOrFail(User, { id: before.id });
      expect(after.status).toBe('active');
    });
  });

  describe('RLS', () => {
    it('a query against account_invite with no tenant context bound returns zero rows', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);
      await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'A', lastName: 'B', staffRef: `S-${randomUUID().slice(0, 6)}` })
        .expect(201);

      const rows = await dataSource.manager.query(`SELECT * FROM core.account_invite WHERE organisation_id = $1`, [organisation.id]);
      expect(rows).toHaveLength(0);
    });
  });
});
