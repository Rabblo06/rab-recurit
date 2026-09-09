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
import { WORKER_HEARTBEAT_KEY } from '../../queue-worker/heartbeat.constants';
import { createAdminDataSource } from './helpers/admin-datasource';

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
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let redisClient: ThrottlerRedisClientProvider;

  const password = 'correct horse battery staple 1!';
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

  /** Like `withTenant`, but also binds `workspaceId` — required for any write to a workspace-scoped table (`staff_profile`, `venue`, `shift`, ...), whose `WITH CHECK` requires `workspace_id = core.current_workspace()`. */
  function withWorkspace<T>(organisationId: string, workspaceId: string, fn: (manager: EntityManager) => Promise<T>): Promise<T> {
    return tenantContext.runInTenantContext({ organisationId, workspaceId, userId: '', role: '' }, fn);
  }

  /** One org, one Manager who owns a Workspace and holds every permission these tests need. */
  async function seedOrgWithManager(label = 'a'): Promise<{ organisation: Organisation; email: string; userId: string; workspaceId: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `mgr-${label}-${randomUUID()}@example.test`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    let userId!: string;
    let workspaceId!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' }, async (manager) => {
      const roleResult = await manager.insert(Role, { organisationId: organisation.id, key: `manager-${label}-${randomUUID()}`, name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
        await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await manager.insert(User, { organisationId: organisation.id, email, passwordHash, firstName: 'Mgr', lastName: label.toUpperCase(), status: UserStatus.ACTIVE });
      userId = userResult.identifiers[0]!.id as string;
      await manager.insert(UserRole, { userId, roleId, organisationId: organisation.id });
      await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
      const workspace = await manager.save(ManagerWorkspace, {
        organisationId: organisation.id,
        ownerUserId: userId,
        name: `WS ${label} ${userId}`,
        subdomain: `ws-${label}-${userId.slice(0, 8)}`,
        status: 'active',
      });
      workspaceId = workspace.id;
      await manager.insert(ManagerProfile, { organisationId: organisation.id, userId, type: ManagerType.INTERNAL, workspaceId });
    });
    return { organisation, email, userId, workspaceId };
  }

  async function login(email: string): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').set('X-Client-Platform', 'mobile').send({ email, password });
    expect(res.status).toBe(200);
    return { accessToken: res.body.accessToken as string, refreshToken: res.body.refreshToken as string };
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
      await manager.insert(ManagerProfile, { organisationId: organisation.id, userId, type: ManagerType.INTERNAL, workspaceId });
    });
    return { userId, workspaceId };
  }

  async function getManagerProfileUserId(organisationId: string, profileId: string): Promise<string> {
    const rows = await withTenant(organisationId, (m) => m.query<[{ user_id: string }]>(`SELECT user_id FROM core.manager_profile WHERE id = $1`, [profileId]));
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
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'New', lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
      expect(create.status).toBe(201);
      expect(create.body.invitationStatus).toBe('queued');

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`);
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

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${create.body.id}`).set('Authorization', `Bearer ${token}`);
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
      });

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${aToken}`);
      expect(del.status).toBe(404);

      const stillThere = await withWorkspace(organisation.id, bWorkspaceId, (m) => m.findOne(StaffProfile, { where: { id: staffProfileId } }));
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

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${createB.body.id}`).set('Authorization', `Bearer ${aToken}`);
      expect(del.status).toBe(204);

      const gone = await withTenant(organisation.id, (m) => m.findOne(User, { where: { email: createB.body.email } }));
      expect(gone).toBeNull();
    });

    it('cross-org delete attempt 404s (target invisible under the caller\'s tenant context)', async () => {
      const { email: aEmail } = await seedOrgWithManager('xo-a');
      const aToken = (await login(aEmail)).accessToken;
      const other = await seedOrgWithManager('xo-c');

      const targetProfile = await withTenant(other.organisation.id, (m) => m.query<[{ id: string }]>(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [other.userId]));
      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${targetProfile[0]!.id}`).set('Authorization', `Bearer ${aToken}`);
      expect(del.status).toBe(404);

      const stillThere = await withTenant(other.organisation.id, (m) => m.findOne(User, { where: { id: other.userId } }));
      expect(stillThere).not.toBeNull();
    });

    it('a guessed/nonexistent id 404s', async () => {
      const { email } = await seedOrgWithManager('guess-a');
      const token = (await login(email)).accessToken;
      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${randomUUID()}`).set('Authorization', `Bearer ${token}`);
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
      });

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${token}`);
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

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${createD.body.id}`).set('Authorization', `Bearer ${token}`);
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
      const ownProfile = await withTenant(organisation.id, (m) => m.query<[{ id: string }]>(`SELECT id FROM core.manager_profile WHERE user_id = $1`, [userId]));

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${ownProfile[0]!.id}`).set('Authorization', `Bearer ${token}`);
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

      const del = await request(app.getHttpServer()).delete(`/rest/v1/managers/${createE.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(409);
      expect(del.body.code).toBe('CANNOT_DELETE_PLATFORM_ADMIN');
    });
  });

  describe('deletion side-effects — sessions, pending email, audit trail (Part C)', () => {
    it('deleting an active Staff member revokes their access and refresh sessions immediately', async () => {
      const { organisation, email, userId: managerUserId, workspaceId } = await seedOrgWithManager('sess-a');
      const managerToken = (await login(email)).accessToken;

      let staffEmail!: string;
      let staffUserId!: string;
      let staffProfileId!: string;
      await withWorkspace(organisation.id, workspaceId, async (manager) => {
        staffEmail = `sessstaff-${randomUUID()}@example.test`;
        const passwordHash = await passwordHashing.hash(password);
        const staffUser = await manager.insert(User, { organisationId: organisation.id, email: staffEmail, passwordHash, firstName: 'Sess', lastName: 'Staff', status: UserStatus.ACTIVE });
        staffUserId = staffUser.identifiers[0]!.id as string;
        const profile = await manager.save(StaffProfile, { organisationId: organisation.id, userId: staffUserId, staffRef: `STF-${randomUUID().slice(0, 8)}`, createdBy: managerUserId, workspaceId });
        staffProfileId = profile.id;
      });

      const { accessToken, refreshToken } = await login(staffEmail);
      const before = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${accessToken}`);
      expect(before.status).toBe(200);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${staffProfileId}`).set('Authorization', `Bearer ${managerToken}`);
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
        .send({ email: `outboxstaff-${randomUUID()}@example.test`, firstName: 'Out', lastName: 'Box', staffRef: `STF-${randomUUID().slice(0, 8)}` });
      expect(create.status).toBe(201);

      const outboxBefore = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));
      expect(['PENDING', 'QUEUED']).toContain(outboxBefore.status);

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`);
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
        .send({ email: `inviteinv-${randomUUID()}@example.test`, firstName: 'Inv', lastName: 'Ite', staffRef: `STF-${randomUUID().slice(0, 8)}` });
      expect(create.status).toBe(201);
      const outbox = await withTenant(organisation.id, (m) => m.findOneByOrFail(EmailOutbox, { recipientEmail: create.body.email }));
      const inviteId = outbox.accountInviteId!;

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`);
      expect(del.status).toBe(204);

      // AccountInvite CASCADEs from user_id — the row itself must be gone,
      // never left behind as a still-consumable activation link.
      const invite = await withTenant(organisation.id, (m) => m.findOne(AccountInvite, { where: { id: inviteId } }));
      expect(invite).toBeNull();
    });

    it('deletion is audited (user.deleted, actor = the deleting manager, target id/email preserved only in metadata) and the user\'s prior audit history survives with target_user_id nulled, not erased', async () => {
      const { organisation, email, userId: managerUserId } = await seedOrgWithManager('audit-a');
      const token = (await login(email)).accessToken;

      const create = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `auditstaff-${randomUUID()}@example.test`, firstName: 'Aud', lastName: 'It', staffRef: `STF-${randomUUID().slice(0, 8)}` });
      expect(create.status).toBe(201);
      const deletedUserId = await withTenant(organisation.id, (m) => m.findOneByOrFail(User, { email: create.body.email })).then((u) => u.id);

      const creationAudit = await withTenant(organisation.id, (m) =>
        m.query<[{ id: string }]>(`SELECT id FROM core.audit_log WHERE action = 'user.created' AND target_user_id = $1`, [deletedUserId]),
      );
      expect(creationAudit.length).toBe(1);
      const creationAuditId = creationAudit[0]!.id;

      const del = await request(app.getHttpServer()).delete(`/rest/v1/staff/${create.body.id}`).set('Authorization', `Bearer ${token}`);
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

      // The user.created row must still exist — never deleted, only its FK nulled.
      const survivingAudit = await withTenant(organisation.id, (m) => m.query<[{ target_user_id: string | null }]>(`SELECT target_user_id FROM core.audit_log WHERE id = $1`, [creationAuditId]));
      expect(survivingAudit.length).toBe(1);
      expect(survivingAudit[0]!.target_user_id).toBeNull();
    });
  });
});
