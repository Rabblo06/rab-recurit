import { insertMembership, provisionFixtureWorkspace } from './helpers/test-identities';
import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { EmailOutbox, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { AccountInviteService } from '../../engine/core-modules/auth/services/account-invite.service';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { createAdminDataSource } from './helpers/admin-datasource';
import { generateFixturePassword } from './helpers/fixture-password';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * Phase D, F-1 (D8). Finding F-1: the Worker's `runAccountInviteCleanupCycle` runs on the RUNTIME connection with no
 * tenant context, so under RLS it sees no `core."user"` / `core.account_invite` rows and does nothing — invited users are
 * never moved to `invite_expired` and never deleted.
 *
 * Before anything is done about the cleanup, the owner asked for proof that this is a data-retention problem only and not
 * a security one: every dead invitation link must be refused at REDEMPTION by the redemption path's own checks, never
 * because the cleanup job happened to run first. This file proves that for every account-invite redemption path:
 *
 *   - `POST /auth/activate-account` (AuthService.activateAccount → AccountInviteService.consume) — the only path that
 *     consumes an account-invite token;
 *   - `POST /auth/login` for the invited account — the only INVITED→ACTIVE transition, which requires a password that only
 *     a successful activation can set;
 *   - first-time Google/Microsoft sign-in (`AuthService.resolveProviderUser`) — eligibility is "ACTIVE, or INVITED with a
 *     password set", the same gate as login.
 *
 * In every case the cleanup never runs: each test asserts the user is still `invited` (the state the cleanup would have
 * moved to `invite_expired` or deleted), with `expires_at` and `cleanup_at` both in the past.
 *
 * Member invitations (`core.member_invitation`) and organisation CEO invitations (`core.organisation_invitation`) are not
 * touched by this cleanup job at all; their redemption paths check accepted/revoked/superseded/expired on the database
 * clock (`MemberInvitationService.loadLive`, `core.organisation_invitation_peek` / `organisation_invitation_complete`)
 * and are covered by `member-invitation.integration.spec.ts` and `organisation-ceo-invitation.integration.spec.ts`.
 *
 * Runs at main's schema (no Phase D migration needed).
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('Phase D F-1: dead account-invite links are refused at redemption even when the cleanup never runs (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let accountInvites: AccountInviteService;
  let authService: AuthService;
  let tenantContext: TenantContextService;
  let passwordHashing: PasswordHashingService;
  let redisClient: ThrottlerRedisClientProvider;

  // USER_RESET_PASSWORD guards cancel-invite (StaffController).
  const OWNER_PERMISSIONS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW, PermissionFlag.MANAGER_MANAGE, PermissionFlag.USER_RESET_PASSWORD];

  function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async function seedOrgWithOwner(): Promise<{ organisationId: string; ownerEmail: string }> {
    const slug = `test-${randomUUID()}`;
    const ownerEmail = `owner-${randomUUID()}@example.test`;
    const inserted = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisationId = inserted.identifiers[0]!.id as string;

    await tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
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
      const roleResult = await manager.insert(Role, { organisationId, key: 'org_admin', name: 'Owner', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      await manager.insert(RolePermission, permissions.map((p) => ({ roleId, permissionId: p.id, organisationId })));
      const userResult = await manager.insert(User, {
        organisationId,
        email: ownerEmail,
        passwordHash: await passwordHashing.hash(FIXTURE_PASSWORD),
        firstName: 'Test',
        lastName: 'Owner',
        status: UserStatus.ACTIVE,
      });
      const ownerUserId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId: ownerUserId, roleId, organisationId });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [ownerUserId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId,
        ownerUserId,
        name: `Test Workspace ${ownerUserId}`,
        subdomain: `test-${ownerUserId.slice(0, 8)}`,
        status: 'active',
      });
      await provisionFixtureWorkspace(manager, workspace.id); // Part C1: READY schema, as the product builds it
      await insertMembership(manager, organisationId, ownerUserId, workspace.id);
      await manager.insert(ManagerProfile, { organisationId, userId: ownerUserId, type: ManagerType.INTERNAL, workspaceId: workspace.id });
    });
    return { organisationId, ownerEmail };
  }

  async function loginOwner(ownerEmail: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: ownerEmail, password: FIXTURE_PASSWORD });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function createPendingStaff(ownerToken: string): Promise<{ profileId: string; userId: string; email: string }> {
    const email = `staff-${randomUUID()}@example.test`;
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email, firstName: 'F', lastName: 'One' });
    expect(res.status).toBe(201);
    const user = await adminDataSource.manager.findOneByOrFail(User, { email });
    return { profileId: res.body.id as string, userId: user.id, email };
  }

  /** One confirmed-delivered attempt, exactly as the Worker would leave it (same helper shape as the abuse-case suite). */
  async function issueDelivered(manager: EntityManager, organisationId: string, userId: string): Promise<{ token: string; sendNumber: number }> {
    const prepared = await accountInvites.prepare(manager, userId);
    const invite = await accountInvites.commit(manager, { organisationId, userId, createdBy: null, ...prepared });
    await manager.insert(EmailOutbox, {
      organisationId,
      jobType: 'ACCOUNT_INVITATION',
      status: 'SENT',
      recipientEmail: 'test-recipient@example.test',
      targetUserId: userId,
      accountInviteId: invite.id,
      renderedSubject: 'test',
      sentAt: new Date(),
    });
    return prepared;
  }

  async function issueAttempts(organisationId: string, userId: string, attempts: number): Promise<string> {
    let token = '';
    for (let i = 0; i < attempts; i += 1) {
      ({ token } = await tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId, role: '' }, (manager) =>
        issueDelivered(manager, organisationId, userId),
      ));
    }
    return token;
  }

  /** Read raw: `User.passwordHash` is `select: false`, so an entity load would always report undefined. */
  async function passwordHashOf(userId: string): Promise<string | null> {
    const [row] = await adminDataSource.query<Array<{ password_hash: string | null }>>(`SELECT password_hash FROM core."user" WHERE id = $1`, [userId]);
    if (!row) throw new Error(`user ${userId} not found`);
    return row.password_hash;
  }

  /** The state a cleanup run would have changed: still `invited`, row still present, nothing accepted. */
  async function expectCleanupNeverRan(userId: string, tokenHash: string): Promise<void> {
    const [user] = await adminDataSource.query<Array<{ status: string; password_hash: string | null }>>(
      `SELECT status, password_hash FROM core."user" WHERE id = $1`,
      [userId],
    );
    expect(user?.status).toBe(UserStatus.INVITED);
    const [invite] = await adminDataSource.query<Array<{ accepted_at: Date | null }>>(`SELECT accepted_at FROM core.account_invite WHERE token_hash = $1`, [tokenHash]);
    expect(invite).toBeDefined();
  }

  async function activate(token: string, newPassword = 'F1-redemption-Passw0rd!') {
    return request(app.getHttpServer()).post('/rest/v1/auth/activate-account').send({ token, newPassword });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    accountInvites = moduleRef.get(AccountInviteService);
    authService = moduleRef.get(AuthService);
    tenantContext = moduleRef.get(TenantContextService);
    passwordHashing = moduleRef.get(PasswordHashingService);
    redisClient = moduleRef.get(ThrottlerRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  beforeEach(async () => {
    // Staff creation queues the first invite only while a Worker heartbeat is visible (no Worker runs under Jest).
    await redisClient.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 30);
  });

  afterAll(async () => {
    await app?.close();
    await adminDataSource?.destroy();
  });

  it('EXPIRED final (3rd) attempt, past expires_at AND past cleanup_at, user still invited: activation, login and provider sign-in are all refused', async () => {
    const { organisationId, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const pending = await createPendingStaff(ownerToken);
    // The create call queued attempt 1 (PENDING outbox, not delivered); three delivered attempts make send_number 3.
    const token = await issueAttempts(organisationId, pending.userId, 3);
    const tokenHash = hashToken(token);
    const [row] = await adminDataSource.query<Array<{ send_number: number; cleanup_at: Date | null }>>(
      `SELECT send_number, cleanup_at FROM core.account_invite WHERE token_hash = $1`,
      [tokenHash],
    );
    expect(row?.send_number).toBe(3);
    expect(row?.cleanup_at).not.toBeNull();
    // Exactly what the cleanup's expire phase and delete phase both select on — and the cleanup never runs.
    await adminDataSource.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '9 days', cleanup_at = now() - interval '2 days' WHERE token_hash = $1`,
      [tokenHash],
    );

    const res = await activate(token);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This activation link is invalid or has expired.');

    // Nothing was consumed or set by the refused attempt.
    const [after] = await adminDataSource.query<Array<{ accepted_at: Date | null }>>(`SELECT accepted_at FROM core.account_invite WHERE token_hash = $1`, [tokenHash]);
    expect(after?.accepted_at).toBeNull();
    expect(await passwordHashOf(pending.userId)).toBeNull();

    // No password can exist, so neither login nor a first provider link can turn the account on.
    const login = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: pending.email, password: 'F1-redemption-Passw0rd!', applicationTarget: 'staff_app' });
    expect(login.status).toBe(401);
    await expect(
      authService.resolveProviderUser('google', { subject: `sub-${randomUUID()}`, email: pending.email, emailVerified: true }),
    ).rejects.toMatchObject({ reason: 'no_eligible_account' });

    // The console still reports the invitation as expired without the cleanup's invite_expired status.
    const detail = await request(app.getHttpServer()).get(`/rest/v1/staff/${pending.profileId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(detail.status).toBe(200);
    expect(detail.body.invitationStatus).toBe('expired');

    await expectCleanupNeverRan(pending.userId, tokenHash);
  });

  it('EXPIRED first attempt (no cleanup_at at all) is refused on the token row itself', async () => {
    const { organisationId, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const pending = await createPendingStaff(ownerToken);
    const token = await issueAttempts(organisationId, pending.userId, 1);
    const tokenHash = hashToken(token);
    await adminDataSource.query(`UPDATE core.account_invite SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [tokenHash]);

    const res = await activate(token);
    expect(res.status).toBe(400);
    expect(await passwordHashOf(pending.userId)).toBeNull();
    await expectCleanupNeverRan(pending.userId, tokenHash);
  });

  it('REVOKED (cancelled by the admin, then left past expiry and cleanup_at) is refused', async () => {
    const { organisationId, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const pending = await createPendingStaff(ownerToken);
    const token = await issueAttempts(organisationId, pending.userId, 3);
    const tokenHash = hashToken(token);

    const cancel = await request(app.getHttpServer()).post(`/rest/v1/staff/${pending.profileId}/cancel-invite`).set('Authorization', `Bearer ${ownerToken}`);
    expect(cancel.status).toBe(204);
    const [revoked] = await adminDataSource.query<Array<{ revoked_at: Date | null }>>(`SELECT revoked_at FROM core.account_invite WHERE token_hash = $1`, [tokenHash]);
    expect(revoked?.revoked_at).not.toBeNull();
    await adminDataSource.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '9 days', cleanup_at = now() - interval '2 days' WHERE token_hash = $1`,
      [tokenHash],
    );

    const res = await activate(token);
    expect(res.status).toBe(400);
    expect(await passwordHashOf(pending.userId)).toBeNull();
    await expectCleanupNeverRan(pending.userId, tokenHash);
  });

  it('REVOKED while still inside its validity window (superseded by a resend) is refused — revocation, not expiry, decides', async () => {
    const { organisationId, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const pending = await createPendingStaff(ownerToken);
    const first = await issueAttempts(organisationId, pending.userId, 1);
    await issueAttempts(organisationId, pending.userId, 1); // revokes `first`
    const [row] = await adminDataSource.query<Array<{ revoked_at: Date | null; live: boolean }>>(
      `SELECT revoked_at, expires_at > now() AS live FROM core.account_invite WHERE token_hash = $1`,
      [hashToken(first)],
    );
    expect(row?.revoked_at).not.toBeNull();
    expect(row?.live).toBe(true);

    const res = await activate(first);
    expect(res.status).toBe(400);
    expect(await passwordHashOf(pending.userId)).toBeNull();
  });

  it('CONSUMED (already accepted), then left past expiry and cleanup_at with the account still invited: a replay is refused and changes nothing', async () => {
    const { organisationId, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const pending = await createPendingStaff(ownerToken);
    const token = await issueAttempts(organisationId, pending.userId, 3);
    const tokenHash = hashToken(token);

    const first = await activate(token, 'F1-owner-chosen-Passw0rd!');
    expect(first.status).toBe(200);
    const before = await passwordHashOf(pending.userId);
    expect(before).not.toBeNull();
    await adminDataSource.query(
      `UPDATE core.account_invite SET expires_at = now() - interval '9 days', cleanup_at = now() - interval '2 days' WHERE token_hash = $1`,
      [tokenHash],
    );

    const replay = await activate(token, 'F1-attacker-chosen-Passw0rd!');
    expect(replay.status).toBe(400);
    expect(await passwordHashOf(pending.userId)).toBe(before);
    // The attacker's password does not sign in; the account stays invited until its real owner signs in.
    const login = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: pending.email, password: 'F1-attacker-chosen-Passw0rd!', applicationTarget: 'staff_app' });
    expect(login.status).toBe(401);
    await expectCleanupNeverRan(pending.userId, tokenHash);
  });

  it('CONSUMED replay inside the validity window is refused too (single use is the token row, not the clock)', async () => {
    const { organisationId, ownerEmail } = await seedOrgWithOwner();
    const ownerToken = await loginOwner(ownerEmail);
    const pending = await createPendingStaff(ownerToken);
    const token = await issueAttempts(organisationId, pending.userId, 1);

    expect((await activate(token, 'F1-owner-chosen-Passw0rd!')).status).toBe(200);
    const before = await passwordHashOf(pending.userId);
    expect(before).not.toBeNull();
    const replay = await activate(token, 'F1-attacker-chosen-Passw0rd!');
    expect(replay.status).toBe(400);
    expect(await passwordHashOf(pending.userId)).toBe(before);
  });
});
