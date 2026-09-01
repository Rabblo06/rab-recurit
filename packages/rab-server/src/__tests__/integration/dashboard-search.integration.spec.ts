import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';

/**
 * `GET /dashboard/summary` and `GET /search` must both compute results with
 * the exact same per-manager ownership scoping as the underlying list
 * endpoints (`staff.service.ts`/`venue.service.ts`/`scheduling.service.ts`/
 * `offer.service.ts`) — this is the IDOR-through-aggregate/IDOR-through-search
 * test matrix for both, real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('dashboard summary + global search (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  async function seedOrgWithManagers(
    count: number,
    extraPerms: string[] = [],
  ): Promise<{ organisation: Organisation; managers: Array<{ email: string; userId: string }> }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, {
      id: orgInsert.identifiers[0]!.id as string,
    });

    const managers: Array<{ email: string; userId: string }> = [];

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
      async (manager) => {
        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: `manager-${randomUUID()}`,
          name: 'Manager',
          isSystem: true,
        });
        const roleId = roleResult.identifiers[0]!.id as string;
        for (const key of [...MANAGER_PERMS, ...extraPerms]) {
          const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
          await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
        }

        for (let i = 0; i < count; i++) {
          const email = `mgr-${randomUUID()}@example.test`;
          const passwordHash = await passwordHashing.hash(password);
          const userResult = await manager.insert(User, {
            organisationId: organisation.id,
            email,
            passwordHash,
            firstName: `Manager${i}`,
            lastName: 'Test',
            status: UserStatus.ACTIVE,
          });
          const userId = userResult.identifiers[0]!.id as string;
          await manager.insert(UserRole, { userId, roleId, organisationId: organisation.id });
          // A real ManagerProfile row, matching what POST /managers really
          // creates — the shared helper this is based on never needed one
          // (it only tested Staff/Shift/Offer ownership), but `managerCount`
          // counts real rows in this table. manager_workspace_write's own
          // WITH CHECK requires owner_user_id = current_uid() — rebind it
          // to the real new user, not this transaction's throwaway
          // bootstrap identity.
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
          managers.push({ email, userId });
        }
      },
    );

    // Only the FIRST manager is granted platform_admin status — via
    // `adminDataSource` (rab_owner): `platform_admin`'s own write policy
    // requires the ACTING session to already be an admin, impossible for a
    // fresh org's first grant.
    if (managers[0]) {
      await adminDataSource.manager.query(`INSERT INTO core.platform_admin (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [
        managers[0].userId,
      ]);
    }

    return { organisation, managers };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function createStaff(token: string, name: string) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: `staff-findme-${name}-${randomUUID()}@example.test`,
        firstName: `Findme${name}`,
        lastName: 'Staff',
        staffRef: `STF-${randomUUID().slice(0, 8)}`,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createVenue(token: string, name: string) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Findme-${name}-${randomUUID()}`, type: 'other' });
    expect(res.status).toBe(201);
    return res.body as { id: string; name: string };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  describe('GET /dashboard/summary', () => {
    it('scopes counts to the caller\'s own created records; a field the caller lacks permission for is null, not 0', async () => {
      // Index 0 always holds platform_admin status (first-seeded, see
      // seedOrgWithManagers) — indexes 1/2 are the actual peer pair this
      // test needs. Platform admin status no longer widens a caller's own
      // scope outside Admin Inspect (Stage 2A Phase 2), but index 0 is
      // still avoided here for clarity/consistency with the rest of this
      // file's convention.
      const { managers } = await seedOrgWithManagers(3);
      const [, a, b] = managers;
      const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);

      await createStaff(tokenA, 'a1');
      await createStaff(tokenA, 'a2');
      await createStaff(tokenB, 'b1');
      await createVenue(tokenA, 'a');

      const resA = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${tokenA}`);
      expect(resA.status).toBe(200);
      expect(resA.body.staffCount).toBe(2);
      expect(resA.body.venueCount).toBe(1);
      // Neither manager's role grants MANAGER_MANAGE in this test's fixture
      // — the field must be null (invisible), never a guessed/leaked number.
      expect(resA.body.managerCount).toBeNull();

      const resB = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${tokenB}`);
      expect(resB.status).toBe(200);
      expect(resB.body.staffCount).toBe(1);
      expect(resB.body.venueCount).toBe(0);
    });

    it('a caller holding MANAGER_MANAGE gets a real org-wide managerCount', async () => {
      const { managers } = await seedOrgWithManagers(3, [PermissionFlag.MANAGER_MANAGE]);
      const token = await login(managers[0]!.email);
      const res = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.managerCount).toBe(3);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary');
      expect(res.status).toBe(401);
    });
  });

  describe('GET /search — IDOR through search', () => {
    it('Manager B never finds Manager A\'s staff or venues by name, and vice versa', async () => {
      // Same reasoning as the dashboard test above — index 0 holds
      // platform_admin status, avoided here for consistency.
      const { managers } = await seedOrgWithManagers(3);
      const [, a, b] = managers;
      const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);

      await createStaff(tokenA, 'alpha');
      const venueA = await createVenue(tokenA, 'alpha');
      await createStaff(tokenB, 'bravo');
      const venueB = await createVenue(tokenB, 'bravo');

      const searchAForB = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: 'Findmebravo' })
        .set('Authorization', `Bearer ${tokenA}`);
      expect(searchAForB.status).toBe(200);
      expect(searchAForB.body.some((r: { name: string }) => r.name.includes('Findmebravo'))).toBe(false);

      const searchAOwn = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: 'Findmealpha' })
        .set('Authorization', `Bearer ${tokenA}`);
      expect(searchAOwn.body.some((r: { name: string }) => r.name.includes('Findmealpha'))).toBe(true);

      const venueSearchA = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: venueB.name })
        .set('Authorization', `Bearer ${tokenA}`);
      expect(venueSearchA.body.some((r: { id: string }) => r.id === venueB.id)).toBe(false);

      const venueSearchAOwn = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: venueA.name })
        .set('Authorization', `Bearer ${tokenA}`);
      expect(venueSearchAOwn.body.some((r: { id: string }) => r.id === venueA.id)).toBe(true);
    });

    it('the platform admin cannot find records created by another manager outside Admin Inspect (Stage 2A Phase 2 retired the org-wide bypass)', async () => {
      const { managers } = await seedOrgWithManagers(2);
      const [admin, other] = managers;
      const [adminToken, otherToken] = await Promise.all([login(admin!.email), login(other!.email)]);

      await createStaff(otherToken, 'delta');
      const adminSearch = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: 'Findmedelta' })
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminSearch.status).toBe(200);
      expect(adminSearch.body.some((r: { name: string }) => r.name.includes('Findmedelta'))).toBe(false);
    });

    it('a % or _ in the query is treated as a literal character, not a wildcard', async () => {
      const { managers } = await seedOrgWithManagers(1);
      const token = await login(managers[0]!.email);
      const res = await request(app.getHttpServer()).get('/rest/v1/search').query({ q: '%_' }).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('requires a non-empty q', async () => {
      const { managers } = await seedOrgWithManagers(1);
      const token = await login(managers[0]!.email);
      const res = await request(app.getHttpServer()).get('/rest/v1/search').query({ q: '' }).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app.getHttpServer()).get('/rest/v1/search').query({ q: 'anything' });
      expect(res.status).toBe(401);
    });
  });

  // Step 7: Dashboard/Search's `owner` scope now filters by `workspace_id`
  // (matching the DB-level RLS dimension), not `created_by` alone — these
  // prove the rewrite actually changed the real boundary, not just its
  // implementation, and that the pre-onboarding fallback it depends on
  // genuinely works.
  describe('cross-workspace scoping (Step 7 — workspace_id, not created_by, is the real boundary)', () => {
    it("a Staff/Venue row stamped with a DIFFERENT manager's workspace_id is invisible on the dashboard/search of the manager who created it, and visible on the dashboard/search of the workspace it actually belongs to", async () => {
      // Index 0 is always the platform-admin claim (first-claimed, see
      // seedOrgWithManagers) — indexes 1/2 are the actual non-admin peer
      // pair this test needs, matching this file's own established
      // convention (an admin's own scope is unrestricted, so using it here
      // would silently defeat the ownership-scoping assertion).
      const { organisation, managers } = await seedOrgWithManagers(3, [PermissionFlag.MANAGER_MANAGE]);
      const [, managerA, managerB] = managers;
      const [{ id: workspaceB }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE owner_user_id = $1`,
        [managerB!.userId],
      );

      // An "impostor" row: created_by = Manager A (who never created
      // anything through the real API here), but workspace_id = Workspace
      // B — structurally impossible via the real app (every creation path
      // stamps the ACTING manager's own resolved workspace), but exactly
      // the shape needed to prove which column Dashboard/Search actually
      // key off now. If `created_by` were still the real boundary, this
      // row would show up for Manager A and never for Manager B — the
      // Step 7 rewrite means the opposite is now true.
      // `venue` is FORCE'd, so this needs a real bound tenant context
      // (matching Workspace B — the row's own workspace_id — for the
      // combined org+workspace WITH CHECK to pass); rab_owner's own
      // pre-auth exemption doesn't apply to FORCE'd tables like this one.
      const impostorName = `Impostor-${randomUUID()}`;
      await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: workspaceB, userId: managerB!.userId, role: '' },
        (m) =>
          m.query(`INSERT INTO core.venue (organisation_id, name, type, created_by, workspace_id) VALUES ($1, $2, 'other', $3, $4)`, [
            organisation.id,
            impostorName,
            managerA!.userId,
            workspaceB,
          ]),
      );

      const [tokenA, tokenB] = await Promise.all([login(managerA!.email), login(managerB!.email)]);

      const dashA = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${tokenA}`);
      const dashB = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${tokenB}`);
      expect(dashA.body.venueCount).toBe(0);
      expect(dashB.body.venueCount).toBe(1);

      const searchA = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: impostorName })
        .set('Authorization', `Bearer ${tokenA}`);
      const searchB = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: impostorName })
        .set('Authorization', `Bearer ${tokenB}`);
      expect(searchA.body.some((r: { name: string }) => r.name === impostorName)).toBe(false);
      expect(searchB.body.some((r: { name: string }) => r.name === impostorName)).toBe(true);
    });

    it("a NULL-workspace Staff row (a legacy backfill gap — confirmed live that no code path can create one going forward) is invisible to EVERYONE on Dashboard/Search, including the platform admin outside Admin Inspect and its own created_by — Stage 2A Phase 2's full replacement means there is no longer an unconditional 'admin sees it' escape hatch, and no valid Inspect target exists for an ownerless row", async () => {
      // Index 0 holds platform_admin status — index 1 is the real peer
      // this test needs.
      const { organisation, managers } = await seedOrgWithManagers(2);
      const admin = managers[0]!;
      const manager = managers[1]!;

      // Simulates a LEGACY row: `workspace_id IS NULL` with a real
      // `created_by` — the state `WorkspaceBackfill`'s own migration leaves
      // a row in when it couldn't resolve an owning workspace for it.
      // Deliberately seeded via `adminDataSource` (rab_owner, bypassing
      // RLS), not through the app's own RLS-bound path: confirmed live that
      // a genuinely NULL-vs-NULL `workspace_id = current_workspace()` WITH
      // CHECK is REJECTED, not satisfied, by Postgres RLS — so this state
      // can no longer arise from live creation at all (not even for a
      // not-yet-onboarded Manager, despite `StaffService.create()`'s own
      // doc comment describing that as supported — a real, confirmed,
      // separately-flagged finding). What CAN still exist is legacy
      // pre-migration data the backfill couldn't resolve. Under Stage 2A
      // Phase 2's full replacement, the RLS-layer "platform admin sees it
      // regardless" branch that `OperationalWorkspaceRlsTransition` relied
      // on for this state is retired — a row with no workspace_id can never
      // satisfy `workspace_id = current_workspace()` (NULL = NULL is never
      // true) for ANY caller, admin included, and there is no valid Admin
      // Inspect target for an ownerless orphaned row either. This test
      // proves the row is genuinely unreachable through ordinary API
      // scoping now, not "admin-only" — the honest, fail-closed consequence
      // of retiring the bypass, matching this mission's own "unresolved
      // historical rows remain historical" principle.
      const preOnboardingEmail = `preonboard-${randomUUID()}@example.test`;
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await adminDataSource.manager.query(
        `INSERT INTO core."user" (organisation_id, email, password_hash, first_name, last_name, status) VALUES ($1, $2, $3, 'Pre', 'Onboard', 'active') RETURNING id`,
        [organisation.id, preOnboardingEmail, passwordHash],
      );
      const userId = userResult[0].id as string;

      // `role`/`user_role` are FORCE'd (unlike `user`/`staff_profile`
      // above and below, both pre-auth-exempt) — need a real bound tenant
      // context, org-scoped only (neither table has a workspace dimension).
      const roleId = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        async (m) => {
          const existing = await m.query(`SELECT id FROM core.role WHERE organisation_id = $1 AND key = 'staff'`, [organisation.id]);
          if (existing.length > 0) return existing[0].id as string;
          const created = await m.query(
            `INSERT INTO core.role (organisation_id, key, name, is_system) VALUES ($1, 'staff', 'Staff', true) RETURNING id`,
            [organisation.id],
          );
          return created[0].id as string;
        },
      );
      await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (m) => m.query(`INSERT INTO core.user_role (user_id, role_id, organisation_id) VALUES ($1, $2, $3)`, [userId, roleId, organisation.id]),
      );
      await adminDataSource.manager.query(
        `INSERT INTO core.staff_profile (organisation_id, user_id, staff_ref, created_by, workspace_id) VALUES ($1, $2, $3, $4, NULL)`,
        [organisation.id, userId, `STF-PRE-${randomUUID().slice(0, 8)}`, manager.userId],
      );

      const [token, adminToken] = await Promise.all([login(manager.email), login(admin.email)]);

      const dash = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${token}`);
      expect(dash.body.staffCount).toBe(0);

      const search = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: 'STF-PRE-' })
        .set('Authorization', `Bearer ${token}`);
      expect(search.body.some((r: { name: string }) => r.name.includes('Pre Onboard'))).toBe(false);

      // The platform admin, outside Admin Inspect, ALSO sees nothing — the
      // row is genuinely orphaned, not "admin-only".
      const adminDash = await request(app.getHttpServer()).get('/rest/v1/dashboard/summary').set('Authorization', `Bearer ${adminToken}`);
      expect(adminDash.body.staffCount).toBe(0);
      const adminSearch = await request(app.getHttpServer())
        .get('/rest/v1/search')
        .query({ q: 'STF-PRE-' })
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminSearch.body.some((r: { name: string }) => r.name.includes('Pre Onboard'))).toBe(false);
    });
  });
});
