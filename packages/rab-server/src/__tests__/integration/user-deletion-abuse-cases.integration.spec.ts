import 'reflect-metadata';
import { EmailOutboxStatus, ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';

import { AppModule } from '../../app.module';
import { AccountInvite, EmailOutbox, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { toTstzRange } from '../../modules/scheduling/utils/tstzrange';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { WORKER_HEARTBEAT_KEY } from '../../engine/worker-shared/heartbeat.constants';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * Part B (Safe Delete User) abuse cases — real Postgres, RLS on, no mocks,
 * real HTTP through the actual `DELETE /rest/v1/managers/:id` and
 * `DELETE /rest/v1/staff/:id` routes wherever the scenario is authorization-
 * shaped, with direct-entity seeding (matching this folder's established
 * `composite-workspace-fk-attack` fixture idiom) for the protected-history/
 * ownership fixtures that would otherwise need a full shift-publish/offer/
 * attendance flow to set up. `UserDeletionService` is the single place a
 * hard `DELETE FROM core."user"` is ever issued — these tests exercise it
 * exclusively through the two real controller routes, never by calling it
 * directly, so a gap in either route's own authorization check would show
 * up here too.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('user deletion abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let redisClient: ThrottlerRedisClientProvider;

  const password = FIXTURE_PASSWORD;
  // TestIdentityFactory generates its OWN random password per instance (`private readonly password
  // = generateFixturePassword()`, deliberately never a shared/repository constant — see that
  // class's own comment) — NOT this file's `FIXTURE_PASSWORD`. `seedOrgWithManager` below only
  // returned email/userId/workspaceId, so `login(email)` always authenticated with the wrong
  // password and failed closed with a genuine 401 — found live via `TestSetupError`, not assumed.
  // Registered here so `login()` can use each manager's REAL password without changing its own
  // `(email: string)` signature or any of this file's many call sites.
  const managerPasswordsByEmail = new Map<string, string>();
  const MANAGER_PERMS = [PermissionFlag.STAFF_CREATE, PermissionFlag.STAFF_VIEW, PermissionFlag.STAFF_DEACTIVATE, PermissionFlag.MANAGER_MANAGE];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /**
   * `email_outbox`/`account_invite`/`manager_profile` etc. have no FORCE-RLS
   * exemption — a `rab_owner` (`adminDataSource`) read with no tenant
   * context bound sees nothing, this session's standing gotcha. Run these
   * on the app's real `rab_app` connection instead, with tenant context
   * actually bound.
   */
  function withTenant<T>(organisationId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, fn);
  }

  /**
   * Like `withTenant`, but also binds `workspaceId` — required for any write to a workspace-scoped
   * table (`staff_profile`, `venue`, `shift`, ...), whose `WITH CHECK` requires
   * `workspace_id = core.current_workspace()`. `staff_profile`'s own insert/select policies go
   * further and ALSO require `current_uid()` to resolve to a non-venue manager who owns that same
   * workspace (`manager_profile.user_id = current_uid()`) — an empty `userId` satisfies neither, so
   * any caller writing or reading `staff_profile` through this helper must pass the real owning
   * manager's id, found live via a real RLS violation when it defaulted to `''` unconditionally.
   */
  function withWorkspace<T>(organisationId: string, workspaceId: string, fn: (manager: EntityManager) => Promise<T>, userId = ''): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId, workspaceId, userId, role: '' }, fn);
  }

  async function seedOrgWithManager(label = 'a'): Promise<{ organisation: Organisation; email: string; userId: string; workspaceId: string }> {
    // Canonical Internal Manager (role `manager`, ManagerProfile, own workspace) holding this suite's permission set.
    const organisation = await factory.createOrganisation();
    const manager = await factory.createInternalManager(organisation, { permissions: MANAGER_PERMS, label: `mgr-${label}` });
    managerPasswordsByEmail.set(manager.email, manager.password);
    return { organisation, email: manager.email, userId: manager.userId, workspaceId: manager.workspaceId! };
  }

  async function login(email: string): Promise<{ accessToken: string; refreshToken: string }> {
    return factory.loginTokens({ kind: 'internal_manager', email, password: passwordFor(email) });
  }

  /** P2.8 — step-up reauth: every DELETE /managers|staff/:id call below now needs the ACTOR's real password in the body, not just a bearer token. */
  function passwordFor(email: string): string {
    return managerPasswordsByEmail.get(email) ?? password;
  }

  /** A second real Manager in an EXISTING org, with their own Workspace (no role/session needed — never logs in, just needs to be a real `created_by`/`owner_user_id` target). */
  async function seedSecondManagerWithWorkspace(organisation: Organisation, label: string): Promise<{ userId: string; workspaceId: string }> {
    let userId!: string;
    let workspaceId!: string;
    await withTenant(organisation.id, async (manager) => {
      const passwordHash = await passwordHashing.hash(password);
      const result = await manager.insert(User, {
        organisationId: organisation.id,
        email: `2nd-${label}-${randomUUID()}@example.test`,
        passwordHash,
        firstName: label,
        lastName: 'Mgr2',
        status: UserStatus.ACTIVE,
      });
      userId = result.identifiers[0]!.id as string;
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: userId,
        name: `WS ${label} ${userId}`,
        subdomain: `ws-${label}-${userId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      // Must bind rab.workspace_id to the real workspace before this insert — manager_profile_tenant's
      // WITH CHECK needs workspace_id = current_workspace() (or a manager.manage permission this
      // brand-new user doesn't have yet); withTenant() only ever binds organisationId, leaving
      // current_workspace() at its initial null. Found live via a real QueryFailedError.
      await manager.query(`SELECT set_config('rab.workspace_id', $1, true)`, [workspaceId]);
      await manager.insert(ManagerProfile, { organisationId: organisation.id, userId, type: ManagerType.INTERNAL, workspaceId });
    });
    return { userId, workspaceId };
  }

  async function getManagerProfileUserId(organisationId: string, profileId: string): Promise<string> {
    // adminDataSource (superuser), not withTenant: manager_profile_tenant's own policy requires
    // current_uid() to resolve to a real identity (the row's own user or a manager.manage holder)
    // — withTenant's throwaway '' userId satisfies neither, so this always returned zero rows. This
    // helper is a test-verification read, not an RLS assertion, so the superuser connection
    // (already this file's own convention for admin/fixture reads) is the right tool here.
    const rows = await adminDataSource.query<[{ user_id: string }]>(`SELECT user_id FROM core.manager_profile WHERE id = $1`, [profileId]);
    return rows[0]!.user_id;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    redisClient = moduleRef.get(ThrottlerRedisClientProvider);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: passwordHashing });
  });

  beforeEach(async () => {
    // See account-invite-abuse-cases.integration.spec.ts's identical
    // beforeEach for why this is needed — no separate worker process runs
    // during Jest, so AccountLifecycleService.isEmailDeliveryAvailable()
    // would otherwise see no heartbeat and skip every invite send.
    await redisClient.client.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', 30);
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('never-activated accounts are deletable', () => {
    it('a pending (never-activated) Staff invite is hard-deletable', async () => {
      const { organisation, email, userId } = await seedOrgWithManager('s1');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Staff' });
      expect(create.status).toBe(201);
      expect(create.body.invitationStatus).toBe('queued');

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      const gone = await withTenant(organisation.id, (m) => m.findOne(User, { where: { email: create.body.email } }));
      expect(gone).toBeNull();
      void userId;
    });

    it('a pending (never-activated) Manager invite is hard-deletable', async () => {
      const { organisation, email } = await seedOrgWithManager('s2');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Mgr', type: 'internal' });
      expect(create.status).toBe(201);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${create.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      const gone = await withTenant(organisation.id, (m) => m.findOne(User, { where: { email: create.body.email } }));
      expect(gone).toBeNull();
    });
  });

  describe('authorization matches the existing model — never a new cross-scope bypass', () => {
    it('Manager A cannot delete Staff created by Manager B (creator-private, 404 not 403)', async () => {
      const { organisation, email: aEmail } = await seedOrgWithManager('cp-a');
      const aToken = (await login(aEmail)).accessToken;
      const { userId: bUserId, workspaceId: bWorkspaceId } = await seedSecondManagerWithWorkspace(organisation, 'cp-b');

      let staffProfileId!: string;
      await withWorkspace(organisation.id, bWorkspaceId, async (manager) => {
        const passwordHash = await passwordHashing.hash(password);
        const staffUser = await manager.insert(User, {
          organisationId: organisation.id,
          email: `bstaff-${randomUUID()}@example.test`,
          passwordHash,
          firstName: 'B',
          lastName: 'Staff',
          status: UserStatus.ACTIVE,
        });
        const staffUserId = staffUser.identifiers[0]!.id as string;
        const profile = await manager.save(StaffProfile, {
          organisationId: organisation.id,
          userId: staffUserId,
          staffRef: `STF-${randomUUID().slice(0, 8)}`,
          createdBy: bUserId,
          workspaceId: bWorkspaceId,
        });
        staffProfileId = profile.id;
      }, bUserId);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${aToken}`).send({ currentPassword: passwordFor(aEmail) });
      expect(del.status).toBe(404);

      const stillThere = await withWorkspace(organisation.id, bWorkspaceId, (m) => m.findOne(StaffProfile, { where: { id: staffProfileId } }), bUserId);
      expect(stillThere).not.toBeNull();
    });

    it('Manager A CAN delete Manager B (org-wide, matching Suspend — no per-Manager ownership restriction)', async () => {
      const { organisation, email: aEmail } = await seedOrgWithManager('owd-a');
      const aToken = (await login(aEmail)).accessToken;

      const createB = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${aToken}`)
        .send({ email: `mgrb-${randomUUID()}@example.test`, firstName: 'B', lastName: 'Mgr', type: 'internal' });
      expect(createB.status).toBe(201);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${createB.body.id}`).set('Authorization', `Bearer ${aToken}`).send({ currentPassword: passwordFor(aEmail) });
      expect(del.status).toBe(204);

      const gone = await withTenant(organisation.id, (m) => m.findOne(User, { where: { email: createB.body.email } }));
      expect(gone).toBeNull();
    });

    it('cross-org delete attempt 404s (target invisible under the caller\'s tenant context)', async () => {
      const { email: aEmail } = await seedOrgWithManager('xo-a');
      const aToken = (await login(aEmail)).accessToken;
      const other = await seedOrgWithManager('xo-c');

      // adminDataSource, not withTenant — see getManagerProfileUserId's own comment for why.
      const targetProfile = await adminDataSource.query<[{ id: string }]>(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [other.userId]);
      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${targetProfile[0]!.id}`).set('Authorization', `Bearer ${aToken}`).send({ currentPassword: passwordFor(aEmail) });
      expect(del.status).toBe(404);

      const stillThere = await withTenant(other.organisation.id, (m) => m.findOne(User, { where: { id: other.userId } }));
      expect(stillThere).not.toBeNull();
    });

    it('a guessed/nonexistent id 404s', async () => {
      const { email } = await seedOrgWithManager('guess-a');
      const token = (await login(email)).accessToken;
      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${randomUUID()}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(404);
    });
  });

  describe('the actual safety gate — UserDeletionService.assertCanDelete', () => {
    it('an active Staff member with real operational history (a ShiftAssignment) is blocked with USER_HAS_PROTECTED_HISTORY, and Suspend still works instead', async () => {
      const { organisation, email, userId: managerUserId, workspaceId } = await seedOrgWithManager('ph-a');
      const token = (await login(email)).accessToken;

      let staffProfileId!: string;
      await withWorkspace(organisation.id, workspaceId, async (manager) => {
        const passwordHash = await passwordHashing.hash(password);
        const staffUser = await manager.insert(User, {
          organisationId: organisation.id,
          email: `phstaff-${randomUUID()}@example.test`,
          passwordHash,
          firstName: 'Phst',
          lastName: 'Aff',
          status: UserStatus.ACTIVE,
        });
        const staffUserId = staffUser.identifiers[0]!.id as string;
        const staffProfile = await manager.save(StaffProfile, {
          organisationId: organisation.id,
          userId: staffUserId,
          staffRef: `STF-${randomUUID().slice(0, 8)}`,
          createdBy: managerUserId,
          workspaceId,
        });
        staffProfileId = staffProfile.id;

        const venue = await manager.save(Venue, { organisationId: organisation.id, name: 'PH Venue', createdBy: managerUserId, workspaceId });
        const jobRole = await manager.save(JobRole, { organisationId: organisation.id, name: `PH Role ${randomUUID().slice(0, 6)}`, defaultRatePence: 1500, createdBy: managerUserId, workspaceId });
        const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
        const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
        const shift = await manager.save(Shift, {
          organisationId: organisation.id,
          venueId: venue.id,
          jobRoleId: jobRole.id,
          startsAt,
          endsAt,
          breakMinutes: 0,
          requiredCount: 1,
          payRatePence: 1500,
          status: 'open',
          createdBy: managerUserId,
          workspaceId,
        });
        await manager.save(ShiftAssignment, {
          organisationId: organisation.id,
          shiftId: shift.id,
          staffProfileId,
          status: 'confirmed',
          payRateSnapshotPence: 1500,
          assignedBy: managerUserId,
          confirmedAt: new Date(),
          period: toTstzRange(startsAt, endsAt),
          workspaceId,
        });
      }, managerUserId);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('USER_HAS_PROTECTED_HISTORY');
      expect(del.body.message).not.toMatch(/shift_assignment|foreign key|violates/i);

      // Suspend must still work as the alternative — never removed.
      const suspend = await request(app.getHttpServer()).post(`/rest/v1/staff/${staffProfileId}/deactivate`).set('Authorization', `Bearer ${token}`);
      expect(suspend.status).toBe(201);
    });

    it('a Manager who owns a private Workspace is blocked with MANAGER_OWNS_WORKSPACE, not silently orphaning it', async () => {
      const { organisation, email } = await seedOrgWithManager('mow-a');
      const token = (await login(email)).accessToken;

      const createD = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `mgrd-${randomUUID()}@example.test`, firstName: 'D', lastName: 'Mgr', type: 'internal' });
      expect(createD.status).toBe(201);
      const dUserId = await getManagerProfileUserId(organisation.id, createD.body.id as string);

      // `manager_workspace`'s own RLS (NO FORCE, tightened by
      // `ManagerWorkspaceRls1786667900000`) means D's own tenant context is
      // required to insert as D's owner — write policy is `owner_user_id =
      // current_uid()`.
      await withTenant(organisation.id, async (manager) => {
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [dUserId]);
        await manager.save(ManagerWorkspace, {
          organisationId: organisation.id,
          ownerUserId: dUserId,
          name: `D Workspace ${dUserId}`,
          subdomain: `d-ws-${dUserId.slice(0, 8)}`,
          status: 'active',
        });
      });

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${createD.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('MANAGER_OWNS_WORKSPACE');

      // `manager_workspace`'s SELECT policy only ever shows a caller a
      // workspace they own themselves — verify durability via the
      // `rab_owner` connection instead (that table is NO FORCE, so the
      // owner role bypasses RLS entirely; the app itself never reads this
      // way, only this test's own verification step).
      const workspaceStillThere = await adminDataSource.manager.findOne(ManagerWorkspace, { where: { ownerUserId: dUserId } });
      expect(workspaceStillThere).not.toBeNull();
    });

    it('self-delete is blocked with CANNOT_DELETE_SELF', async () => {
      const { organisation, email, userId } = await seedOrgWithManager('self-a');
      const token = (await login(email)).accessToken;
      // adminDataSource, not withTenant — see getManagerProfileUserId's own comment for why.
      const ownProfile = await adminDataSource.query<[{ id: string }]>(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [userId]);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${ownProfile[0]!.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('CANNOT_DELETE_SELF');
    });

    it('deleting the platform administrator is blocked with CANNOT_DELETE_PLATFORM_ADMIN', async () => {
      const { organisation, email } = await seedOrgWithManager('pa-a');
      const token = (await login(email)).accessToken;

      const createE = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `mgre-${randomUUID()}@example.test`, firstName: 'E', lastName: 'Mgr', type: 'internal' });
      expect(createE.status).toBe(201);
      const eUserId = await getManagerProfileUserId(organisation.id, createE.body.id as string);
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [eUserId]);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${createE.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('CANNOT_DELETE_PLATFORM_ADMIN');
    });
  });

  describe('deletion side-effects — sessions, pending email, audit trail (Part C)', () => {
    it('deleting an active Staff member revokes their access and refresh sessions immediately', async () => {
      const { organisation, email, userId: managerUserId, workspaceId } = await seedOrgWithManager('sess-a');
      const managerToken = (await login(email)).accessToken;

      // A real Staff identity (role `staff`, StaffProfile in the manager's workspace) — logs in through the staff app like the real client.
      const staff = await factory.createStaff(organisation, { owner: { userId: managerUserId, workspaceId }, label: 'sessstaff' });
      const staffProfileId = staff.profileId!;

      const { accessToken, refreshToken } = await factory.loginTokens(staff);
      const before = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(before.status).toBe(200);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${managerToken}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      const afterAccessToken = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(afterAccessToken.status).toBe(401);
      const refreshAttempt = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').send({ refreshToken });
      expect(refreshAttempt.status).toBe(401);
    });

    it('deleting a Staff member with a still-queued invite email cancels the outbox row', async () => {
      const { organisation, email } = await seedOrgWithManager('outbox-a');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `outboxstaff-${randomUUID()}@example.test`, firstName: 'Out', lastName: 'Box' });
      expect(create.status).toBe(201);

      const outboxBefore = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));
      expect(['PENDING', 'QUEUED']).toContain(outboxBefore.status);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      const outboxAfter = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { id: outboxBefore.id }));
      expect(outboxAfter.status).toBe(EmailOutboxStatus.CANCELLED);
    });

    it('an unrevoked AccountInvite for the deleted user is cancelled/superseded, never left sendable', async () => {
      const { organisation, email } = await seedOrgWithManager('invite-a');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `inviteinv-${randomUUID()}@example.test`, firstName: 'Inv', lastName: 'Ite' });
      expect(create.status).toBe(201);
      const outbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));
      const inviteId = outbox.accountInviteId!;

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      // AccountInvite CASCADEs from user_id — the row itself must be gone,
      // never left behind as a still-consumable activation link.
      const invite = await withTenant(organisation.id, (m) => m.findOne(AccountInvite, { where: { id: inviteId } }));
      expect(invite).toBeNull();
    });

    /**
     * Pre-`AuditLogImmutableHistoricalIdentifiers1786692000000`, this test asserted that
     * `target_user_id` went to `NULL` on deletion — the behaviour the original `ON DELETE SET
     * NULL` FK was *supposed* to produce. That assertion was always describing a behaviour that
     * never actually ran: Postgres enforces a FK's SET NULL action using the REFERENCING table's
     * OWNER privileges, and `audit_log`'s owner (`crewflow`) has had UPDATE revoked from it since
     * `AuditLogCrewflowOwnerRevoke1786686000000` (deliberately, to keep the table insert-only) — so
     * the `DELETE FROM core."user"` itself threw `permission denied for table audit_log` and this
     * whole request 500'd before ever reaching the assertion below. Confirmed by running this exact
     * test, unmodified, against a disposable database before writing the fix: it failed with a 500,
     * not with a wrong NULL. The owner-approved fix removes the FK entirely rather than restore the
     * privilege it depended on (which would have reopened the exact hole the 2026-insert-only
     * lockdown closed) — so historical actor/target ids now survive a deletion unchanged instead of
     * going to NULL, and this test asserts that actual, working behaviour instead of the
     * never-functioning one.
     */
    it('deletion is audited (user.deleted, actor = the deleting manager, target id/email preserved only in metadata) and the user\'s prior audit history survives with its original target_user_id intact, not erased or nulled', async () => {
      const { organisation, email, userId: managerUserId } = await seedOrgWithManager('audit-a');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `auditstaff-${randomUUID()}@example.test`, firstName: 'Aud', lastName: 'It' });
      expect(create.status).toBe(201);
      const deletedUserId = await withTenant(organisation.id, (m) => m.findOneByOrFail(User, { email: create.body.email })).then((u) => u.id);

      const creationAudit = await withTenant(organisation.id, (m) =>
        m.query<[{ id: string }]>(`SELECT id FROM core.audit_log WHERE action = 'user.created' AND target_user_id = $1`, [deletedUserId]),
      );
      expect(creationAudit.length).toBe(1);
      const creationAuditId = creationAudit[0]!.id;

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`).send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      const deletionAudit = await withTenant(organisation.id, (m) =>
        m.query<[{ actor_user_id: string; metadata: { deletedUserId: string; deletedUserEmail: string } }]>(
          `SELECT actor_user_id, metadata FROM core.audit_log WHERE action = 'user.deleted' AND metadata->>'deletedUserId' = $1`,
          [deletedUserId],
        ),
      );
      expect(deletionAudit.length).toBe(1);
      expect(deletionAudit[0]!.actor_user_id).toBe(managerUserId);
      expect(deletionAudit[0]!.metadata.deletedUserEmail).toBe(create.body.email);

      // The user.created row must still exist, AND still carry the real, now-deleted user's id —
      // never deleted, never rewritten, never nulled. This is the new, intended guarantee.
      const survivingAudit = await withTenant(organisation.id, (m) => m.query<[{ target_user_id: string | null }]>(`SELECT target_user_id FROM core.audit_log WHERE id = $1`, [creationAuditId]));
      expect(survivingAudit.length).toBe(1);
      expect(survivingAudit[0]!.target_user_id).toBe(deletedUserId);
    });

    it('deleting a user who has logged in before (actor of a prior auth.login event) succeeds, and that historical actor_user_id survives intact', async () => {
      const { organisation, email: managerEmail, userId: managerUserId, workspaceId } = await seedOrgWithManager('audit-actor');
      const managerToken = (await login(managerEmail)).accessToken;

      const staff = await factory.createStaff(organisation, { owner: { userId: managerUserId, workspaceId }, label: 'auditactor' });
      const staffProfileId = staff.profileId!;
      const { accessToken } = await factory.loginTokens(staff);
      const whoAmI = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(whoAmI.status).toBe(200);
      const staffUserId = whoAmI.body.id as string;

      const loginAudit = await withTenant(organisation.id, (m) =>
        m.query<[{ id: string }]>(`SELECT id FROM core.audit_log WHERE action = 'auth.login' AND actor_user_id = $1`, [staffUserId]),
      );
      expect(loginAudit.length).toBeGreaterThanOrEqual(1);
      const loginAuditId = loginAudit[0]!.id;

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${managerToken}`).send({ currentPassword: passwordFor(managerEmail) });
      expect(del.status).toBe(204);

      const survivingAudit = await withTenant(organisation.id, (m) => m.query<[{ actor_user_id: string | null }]>(`SELECT actor_user_id FROM core.audit_log WHERE id = $1`, [loginAuditId]));
      expect(survivingAudit.length).toBe(1);
      expect(survivingAudit[0]!.actor_user_id).toBe(staffUserId);
    });

    it('deleting a user who is BOTH a prior actor (their own login) and a prior target (a manager suspending, then un-suspending, their account) succeeds, and both historical rows survive intact', async () => {
      const { organisation, email: managerEmail, userId: managerUserId, workspaceId } = await seedOrgWithManager('audit-both');
      const managerToken = (await login(managerEmail)).accessToken;

      // `factory.createStaff` is a direct-fixture helper (raw inserts) — it never calls
      // AuditService, so it leaves no 'user.created' row to key off. The actor half (login) and the
      // target half (a real, audited manager action against this account) both come from genuine
      // HTTP routes instead, which is what actually matters here — not which specific action pairs
      // demonstrate "this id was recorded as both actor and target."
      const staff = await factory.createStaff(organisation, { owner: { userId: managerUserId, workspaceId }, label: 'auditboth' });
      const staffProfileId = staff.profileId!;
      const { accessToken } = await factory.loginTokens(staff);
      const whoAmI = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(whoAmI.status).toBe(200);
      const staffUserId = whoAmI.body.id as string;

      const loginAudit = await withTenant(organisation.id, (m) =>
        m.query<[{ id: string }]>(`SELECT id FROM core.audit_log WHERE action = 'auth.login' AND actor_user_id = $1`, [staffUserId]),
      );
      expect(loginAudit.length).toBeGreaterThanOrEqual(1);

      // A real, audited action the manager takes AGAINST this staff member — target_user_id = staffUserId.
      const suspend = await request(app.getHttpServer()).post(`/rest/v1/staff/${staffProfileId}/deactivate`).set('Authorization', `Bearer ${managerToken}`);
      expect(suspend.status).toBe(201);
      const suspendAudit = await withTenant(organisation.id, (m) =>
        m.query<[{ id: string }]>(`SELECT id FROM core.audit_log WHERE action = 'user.suspended' AND target_user_id = $1`, [staffUserId]),
      );
      expect(suspendAudit.length).toBe(1);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${managerToken}`).send({ currentPassword: passwordFor(managerEmail) });
      expect(del.status).toBe(204);

      const survivingSuspend = await withTenant(organisation.id, (m) =>
        m.query<[{ target_user_id: string | null }]>(`SELECT target_user_id FROM core.audit_log WHERE id = $1`, [suspendAudit[0]!.id]),
      );
      const survivingLogin = await withTenant(organisation.id, (m) =>
        m.query<[{ actor_user_id: string | null }]>(`SELECT actor_user_id FROM core.audit_log WHERE id = $1`, [loginAudit[0]!.id]),
      );
      expect(survivingSuspend[0]!.target_user_id).toBe(staffUserId);
      expect(survivingLogin[0]!.actor_user_id).toBe(staffUserId);
    });
  });

  describe('P2.8 — step-up reauth (currentPassword) gates deletion before anything else runs', () => {
    it('a valid session with the WRONG current password is rejected (403) and the target is never touched', async () => {
      const { organisation, email } = await seedOrgWithManager('stepup-wrong');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `stepupwrong-${randomUUID()}@example.test`, firstName: 'Step', lastName: 'Up' });
      expect(create.status).toBe(201);

      const del = await request(app.getHttpServer())
        .delete(`/rest/v1/staff/${create.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'definitely-not-the-real-password' });
      expect(del.status).toBe(403);

      const stillThere = await withTenant(organisation.id, (m) => m.findOne(User, { where: { email: create.body.email } }));
      expect(stillThere).not.toBeNull();
    });

    it('a valid session with NO currentPassword in the body is rejected (400, DTO validation) before the service is even reached', async () => {
      const { email } = await seedOrgWithManager('stepup-missing');
      const token = (await login(email)).accessToken;

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${randomUUID()}`).set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(400);
    });

    it('the SAME action with the correct current password succeeds — step-up reauth is not merely a permanent block', async () => {
      const { organisation, email } = await seedOrgWithManager('stepup-right');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `stepupright-${randomUUID()}@example.test`, firstName: 'Step', lastName: 'Up' });
      expect(create.status).toBe(201);

      const del = await request(app.getHttpServer())
        .delete(`/rest/v1/staff/${create.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: passwordFor(email) });
      expect(del.status).toBe(204);

      const gone = await withTenant(organisation.id, (m) => m.findOne(User, { where: { email: create.body.email } }));
      expect(gone).toBeNull();
    });
  });
});
