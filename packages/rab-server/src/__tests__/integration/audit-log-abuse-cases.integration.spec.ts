import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

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
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let platformAdmin: PlatformAdminService;

  const password = 'correct horse battery staple 1!';

  // Matches manager.service.ts's real ROLE_DEFS for ManagerType.INTERNAL
  // closely enough for this test's purposes — must include AUDIT_VIEW,
  // since that's the actual permission the leak/fix hinges on.
  const MANAGER_PERMS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
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
    venue: Venue;
    managers: Array<{ email: string; userId: string }>;
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: orgInsert.identifiers[0]!.id as string,
    });

    const managers: Array<{ email: string; userId: string }> = [];
    let venue!: Venue;

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
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
          await platformAdmin.tryClaim(manager, organisation.id, userId);
          managers.push({ email, userId });
        }

        venue = await manager.save(Venue, { organisationId: organisation.id, name: 'Test Venue' });
      },
    );

    return { organisation, venue, managers };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function seedJobRole(organisation: Organisation): Promise<JobRole> {
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
      (manager) => manager.save(JobRole, { organisationId: organisation.id, name: `Role-${randomUUID()}`, defaultRatePence: 1200 }),
    );
  }

  async function createStaff(token: string, prefix: string) {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `staff-${prefix}-${randomUUID()}@example.test`, firstName: prefix, lastName: 'Staff', staffRef: `STF-${randomUUID().slice(0, 8)}` });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function createAndPublishShift(token: string, organisation: Organisation, venue: Venue) {
    const jobRole = await seedJobRole(organisation);
    const startsAt = new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = new Date(startsAt.getTime() + 8 * 3600 * 1000);
    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${token}`)
      .send({ venueId: venue.id, jobRoleId: jobRole.id, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), requiredCount: 1 });
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
    platformAdmin = moduleRef.get(PlatformAdminService);
  });

  afterAll(async () => {
    await app.close();
  });

  it("a manager's audit feed shows only their own actions; the platform admin sees everyone's", async () => {
    const { organisation, venue, managers } = await seedOrgWithManagers(2);
    const [mgrA, mgrB] = managers; // mgrA is the platform admin (first claimed)
    const tokenA = await login(mgrA!.email);
    const tokenB = await login(mgrB!.email);

    const staffA = await createStaff(tokenA, 'A');
    const staffB = await createStaff(tokenB, 'B');
    const shiftA = await createAndPublishShift(tokenA, organisation, venue);
    const shiftB = await createAndPublishShift(tokenB, organisation, venue);
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

    const listAsA = await request(app.getHttpServer())
      .get('/rest/v1/audit-logs')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(listAsA.status).toBe(200);
    const aActions = listAsA.body.items.map((i: { action: string }) => i.action);
    expect(aActions).toContain('offer.sent'); // platform admin (mgrA) — org-wide feed, sees both
    const aOfferSentIds = listAsA.body.items
      .filter((i: { action: string }) => i.action === 'offer.sent')
      .map((i: { targetId: string | null }) => i.targetId);
    expect(aOfferSentIds).toEqual(expect.arrayContaining([offerA, offerB]));
  });

  it('entityType/entityId filters compose with the actor filter rather than overriding it', async () => {
    const { organisation, venue, managers } = await seedOrgWithManagers(2);
    const [mgrA, mgrB] = managers;
    const tokenB = await login(mgrB!.email);
    const tokenA = await login(mgrA!.email);

    const staffA = await createStaff(tokenA, 'A');
    const shiftA = await createAndPublishShift(tokenA, organisation, venue);
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
});
