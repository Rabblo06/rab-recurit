import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuditLog, Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

/**
 * Confirmed-critical fix: `AUDIT_VIEW` is held by the default `manager`
 * role in production (manager.service.ts's ROLE_DEFS), so without
 * actor-scoping in `AuditService.list()`, any ordinary Manager could read
 * every other Manager's audit trail org-wide — a side channel around the
 * whole per-manager ownership model this session already built and tested
 * elsewhere (resource-ownership-abuse-cases.integration.spec.ts). Real
 * Postgres, RLS on, no mocks — same conventions as that file.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('audit log abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  // Matches manager.service.ts's real ROLE_DEFS for ManagerType.INTERNAL
  // closely enough for this test's purposes — must include AUDIT_VIEW,
  // since that's the actual permission the leak/fix hinges on.
  const MANAGER_PERMS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.AUDIT_VIEW,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  async function seedOrgWithManagers(count: number): Promise<{
    organisation: Organisation;
    managers: Array<{ email: string; userId: string }>;
  }> {
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
        for (const key of MANAGER_PERMS) {
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
          // manager_workspace_write's WITH CHECK requires owner_user_id =
          // current_uid() — rebind it to the real new user, not this
          // transaction's throwaway bootstrap identity.
          await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [userId]);
          await manager.insert(ManagerWorkspace, {
            organisationId: organisation.id,
            ownerUserId: userId,
            name: `Test Workspace ${userId}`,
            subdomain: `test-${userId.slice(0, 8)}`,
            status: 'active',
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

  async function createStaff(token: string, prefix: string) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${prefix}-${randomUUID()}@example.test`, firstName: prefix, lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** Venue/JobRole are privately owned per Manager now — created via `token`'s own POSTs so ownership lines up. */
  async function createAndPublishShift(token: string, organisation: Organisation) {
    void organisation;
    const venueRes = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Venue-${randomUUID()}`, type: 'other' });
    expect(venueRes.status).toBe(201);

    const jobRoleRes = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Role-${randomUUID()}`, defaultRatePence: 1200 });
    expect(jobRoleRes.status).toBe(201);

    const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ venueId: venueRes.body.id, jobRoleId: jobRoleRes.body.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
    expect(createRes.status).toBe(201);
    const publishRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${createRes.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(publishRes.status).toBe(201);
    return createRes.body.id as string;
  }

  /** Triggers a real `offer.sent` audit row attributed to whoever sends it — the simplest genuine auditable action available. */
  async function sendOffer(token: string, shiftId: string, staffProfileId: string) {
    const res = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${shiftId}/offers`)
      .set('Authorization', `Bearer ${token}`)
      .send({ staffProfileId });
    expect(res.status).toBe(201);
    return res.body.id as string;
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

  it("a manager's audit feed shows only their own actions — including the platform admin's own feed, outside an Admin Inspect session (Stage 2A Phase 2 retired the org-wide bypass)", async () => {
    const { organisation, managers } = await seedOrgWithManagers(2);
    const [mgrA, mgrB] = managers; // mgrA holds platform_admin status (first-seeded)
    const tokenA = await login(mgrA!.email);
    const tokenB = await login(mgrB!.email);

    const staffA = await createStaff(tokenA, 'A');
    const staffB = await createStaff(tokenB, 'B');
    const shiftA = await createAndPublishShift(tokenA, organisation);
    const shiftB = await createAndPublishShift(tokenB, organisation);
    const offerA = await sendOffer(tokenA, shiftA, staffA);
    const offerB = await sendOffer(tokenB, shiftB, staffB);

    const listAsB = await request(app.getHttpServer())
      .get('/rest/v1/audit-logs')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(listAsB.status).toBe(200);
    const bOfferSentIds = listAsB.body.items
      .filter((i: { action: string }) => i.action === 'offer.sent')
      .map((i: { targetId: string | null }) => i.targetId);
    expect(bOfferSentIds).toContain(offerB);
    expect(bOfferSentIds).not.toContain(offerA); // the actual leak this test guards against

    // mgrA holds platform_admin status but is NOT inspecting anyone — their
    // own ordinary audit feed is actor-scoped exactly like mgrB's, proving
    // the retired org-wide bypass stays retired.
    const listAsA = await request(app.getHttpServer())
      .get('/rest/v1/audit-logs')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(listAsA.status).toBe(200);
    const aOfferSentIds = listAsA.body.items
      .filter((i: { action: string }) => i.action === 'offer.sent')
      .map((i: { targetId: string | null }) => i.targetId);
    expect(aOfferSentIds).toContain(offerA);
    expect(aOfferSentIds).not.toContain(offerB);
  });

  it('entityType/entityId filters compose with the actor filter rather than overriding it', async () => {
    const { organisation, managers } = await seedOrgWithManagers(2);
    const [mgrA, mgrB] = managers;
    const tokenB = await login(mgrB!.email);
    const tokenA = await login(mgrA!.email);

    const staffA = await createStaff(tokenA, 'A');
    const shiftA = await createAndPublishShift(tokenA, organisation);
    const offerA = await sendOffer(tokenA, shiftA, staffA);

    // mgrB (not platform admin) filters directly by mgrA's own offer id —
    // must still come back empty, not bypass the actor scope.
    const res = await request(app.getHttpServer())
      .get('/rest/v1/audit-logs')
      .query({ entityType: 'offer', entityId: offerA })
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows for audit_log, even over the table-owner connection', async () => {
      // audit_log is ENABLE+FORCE'd (unlike organisation/user/login_history/
      // refresh_token/password_reset_token) — this is what proves FORCE
      // genuinely blocks the owner connection this test suite runs as, not
      // just the app's own runtime role. Seed one real audited action first
      // so an empty table wouldn't make the assertion vacuous.
      const { organisation, managers } = await seedOrgWithManagers(1);
      const [mgr] = managers;
      const token = await login(mgr!.email);
      const staffId = await createStaff(token, 'RLS');
      const shiftId = await createAndPublishShift(token, organisation);
      await sendOffer(token, shiftId, staffId);

      // Deliberately the owner connection (adminDataSource, rab_owner), not
      // the app's own rab_app connection (dataSource) — this is the one
      // test in this file explicitly proving owner/FORCE behavior, per this
      // session's own convention that RLS/auth tests run as rab_app except
      // where owner behavior is the literal thing being asserted.
      const rows = await adminDataSource.manager.find(AuditLog, { where: { organisationId: organisation.id } });
      expect(rows).toHaveLength(0);
    });
  });
});
