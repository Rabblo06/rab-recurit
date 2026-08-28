import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * The mandatory "Manager A/B/C + Admin" test from the per-manager
 * data-isolation task: same organisation, several managers, each manager's
 * created Staff/Shift/Offer must be invisible to every other manager except
 * the platform admin (the org's single first-claimed owner — see
 * PlatformAdminService's own docstring for why that, not a PermissionFlag,
 * is this codebase's "Admin" concept). Real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('resource ownership abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let platformAdmin: PlatformAdminService;

  const password = 'correct horse battery staple 1!';

  const MANAGER_PERMS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.STAFF_EDIT,
    PermissionFlag.STAFF_DEACTIVATE,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.OFFER_CONFIRM,
    PermissionFlag.OFFER_WITHDRAW,
  ];

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) permission = await dataSource.manager.save(Permission, { key, resource, action });
    return permission;
  }

  /**
   * One organisation, `count` managers sharing one "manager" role (every
   * permission above). The FIRST manager created wins the platform-admin
   * claim (tryClaim's own race-safe ON CONFLICT semantics — every later
   * call in this loop is a harmless no-op), matching exactly how the real
   * app crowns its first real user, not a special test path. Venues/job
   * roles are no longer seeded here — each is now privately owned per
   * Manager, so `createAndPublishShift` creates its own via the calling
   * manager's real token instead of sharing one fixture across managers.
   */
  async function seedOrgWithManagers(count: number): Promise<{
    organisation: Organisation;
    managers: Array<{ email: string; userId: string }>;
  }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: orgInsert.identifiers[0]!.id as string,
    });

    const managers: Array<{ email: string; userId: string }> = [];

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
      },
    );

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

  /**
   * Venue is privately owned per Manager now — `venue` from `seedOrgWithManagers`
   * is only accessible to whoever created it (or the platform admin), so a
   * shared venue can't be reused across different callers here. Creates a
   * fresh venue via `token`'s own POST first, so ownership always lines up
   * with whichever manager is creating the shift.
   */
  async function createAndPublishShift(token: string, organisation: Organisation) {
    void organisation;
    const venueRes = await request(app.getHttpServer())
      .post('/rest/v1/venues')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Venue-${randomUUID()}`, type: 'other' });
    expect(venueRes.status).toBe(201);

    // Job roles are owner-scoped the same as venues now — created via the
    // same token so `SchedulingService.create`'s new ownership check passes.
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

  describe('the mandatory Manager A/B/C + Admin test', () => {
    it('Staff: each manager sees only the Staff they created; the platform admin (Manager A) sees all', async () => {
      const { organisation, managers } = await seedOrgWithManagers(3);
      const [a, b, c] = managers;
      const [tokenA, tokenB, tokenC] = await Promise.all([login(a!.email), login(b!.email), login(c!.email)]);

      const staffA1 = await createStaff(tokenA, 'A1');
      const staffA2 = await createStaff(tokenA, 'A2');
      const staffB1 = await createStaff(tokenB, 'B1');
      const staffC1 = await createStaff(tokenC, 'C1');

      const listAs = (token: string) =>
        request(app.getHttpServer()).get('/rest/v1/staff').set('Authorization', `Bearer ${token}`).then((r) => r.body.map((s: { id: string }) => s.id));

      expect((await listAs(tokenB)).sort()).toEqual([staffB1].sort());
      expect((await listAs(tokenC)).sort()).toEqual([staffC1].sort());
      // Manager A is this org's platform admin (first claimed) — sees everyone's.
      expect((await listAs(tokenA)).sort()).toEqual([staffA1, staffA2, staffB1, staffC1].sort());

      void organisation;
    });

    it('Shift: each manager sees only the Shifts they created; the platform admin sees all', async () => {
      const { organisation, managers } = await seedOrgWithManagers(3);
      const [a, b, c] = managers;
      const [tokenA, tokenB, tokenC] = await Promise.all([login(a!.email), login(b!.email), login(c!.email)]);

      const shiftA = await createAndPublishShift(tokenA, organisation);
      const shiftB = await createAndPublishShift(tokenB, organisation);
      const shiftC = await createAndPublishShift(tokenC, organisation);

      const listAs = (token: string) =>
        request(app.getHttpServer()).get('/rest/v1/shifts').set('Authorization', `Bearer ${token}`).then((r) => r.body.map((s: { id: string }) => s.id));

      expect(await listAs(tokenB)).toEqual([shiftB]);
      expect(await listAs(tokenC)).toEqual([shiftC]);
      expect((await listAs(tokenA)).sort()).toEqual([shiftA, shiftB, shiftC].sort());
    });

    it('Offer: each manager sees only the Offers they sent; the platform admin sees all', async () => {
      const { organisation, managers } = await seedOrgWithManagers(3);
      const [a, b, c] = managers;
      const [tokenA, tokenB, tokenC] = await Promise.all([login(a!.email), login(b!.email), login(c!.email)]);

      const staffA = await createStaff(tokenA, 'OA');
      const staffB = await createStaff(tokenB, 'OB');
      const staffC = await createStaff(tokenC, 'OC');
      // createStaff's response doesn't expose staffProfileId directly under
      // that name — id IS the staff profile id (StaffSummary.id).
      const shiftA = await createAndPublishShift(tokenA, organisation);
      const shiftB = await createAndPublishShift(tokenB, organisation);
      const shiftC = await createAndPublishShift(tokenC, organisation);

      const offerA = await sendOffer(tokenA, shiftA, staffA);
      const offerB = await sendOffer(tokenB, shiftB, staffB);
      const offerC = await sendOffer(tokenC, shiftC, staffC);

      const listAs = (token: string) =>
        request(app.getHttpServer()).get('/rest/v1/offers').set('Authorization', `Bearer ${token}`).then((r) => r.body.map((o: { id: string }) => o.id));

      expect(await listAs(tokenB)).toEqual([offerB]);
      expect(await listAs(tokenC)).toEqual([offerC]);
      expect((await listAs(tokenA)).sort()).toEqual([offerA, offerB, offerC].sort());
    });
  });

  describe('direct API IDOR — same organisation, different manager, by-ID access', () => {
    it('Manager B cannot GET, UPDATE, or deactivate Staff A by ID — 404, not 403 or the record', async () => {
      const { managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);
      const staffAId = await createStaff(tokenA, 'IdorA');

      const get = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffAId}`).set('Authorization', `Bearer ${tokenB}`);
      expect(get.status).toBe(404);

      const update = await request(app.getHttpServer())
        .patch(`/rest/v1/staff/${staffAId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ firstName: 'Hijacked' });
      expect(update.status).toBe(404);

      const deactivate = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${staffAId}/deactivate`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(deactivate.status).toBe(404);

      // Manager A can still see/act on their own record — the check is
      // ownership-scoped, not a blanket lock.
      const getOwn = await request(app.getHttpServer()).get(`/rest/v1/staff/${staffAId}`).set('Authorization', `Bearer ${tokenA}`);
      expect(getOwn.status).toBe(200);
    });

    it('deactivating a Staff account records a suspension-notice audit entry attributing the real manager', async () => {
      const { organisation, managers } = await seedOrgWithManagers(1);
      const [a] = managers;
      const tokenA = await login(a!.email);
      const staffAId = await createStaff(tokenA, 'Suspend');

      const deactivate = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${staffAId}/deactivate`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(deactivate.status).toBe(201);
      expect(deactivate.body.employmentStatus).toBe('inactive');

      const rows = await tenantContext.runInTenantContext({ organisationId: organisation.id, userId: a!.userId, role: '' }, (manager) =>
        manager.query(
          `SELECT actor_user_id FROM core.audit_log WHERE organisation_id = $1 AND action = 'staff.suspension_notice_sent'`,
          [organisation.id],
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_user_id).toBe(a!.userId);
    });

    it('Manager B cannot GET, publish, or cancel Shift A by ID', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);

      const shiftAId = await createAndPublishShift(tokenA, organisation);

      const get = await request(app.getHttpServer()).get(`/rest/v1/shifts/${shiftAId}`).set('Authorization', `Bearer ${tokenB}`);
      expect(get.status).toBe(404);

      const publish = await request(app.getHttpServer()).post(`/rest/v1/shifts/${shiftAId}/publish`).set('Authorization', `Bearer ${tokenB}`);
      expect(publish.status).toBe(404);

      const cancel = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftAId}/cancel`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ reason: 'hijack attempt' });
      expect(cancel.status).toBe(404);
    });

    it('Manager B cannot send an offer against Shift A by guessing the shift ID', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);

      const shiftAId = await createAndPublishShift(tokenA, organisation);
      const staffB = await createStaff(tokenB, 'IdorOfferB');

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftAId}/offers`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ staffProfileId: staffB });
      expect(res.status).toBe(404);
    });

    it('Manager B cannot confirm, reject, or withdraw an Offer sent by Manager A', async () => {
      const { organisation, managers } = await seedOrgWithManagers(2);
      const [a, b] = managers;
      const [tokenA, tokenB] = await Promise.all([login(a!.email), login(b!.email)]);

      const staffA = await createStaff(tokenA, 'IdorOfferOwnerA');
      const shiftA = await createAndPublishShift(tokenA, organisation);
      const offerA = await sendOffer(tokenA, shiftA, staffA);

      const confirm = await request(app.getHttpServer()).post(`/rest/v1/offers/${offerA}/confirm`).set('Authorization', `Bearer ${tokenB}`);
      expect(confirm.status).toBe(404);

      const reject = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offerA}/reject`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ reason: 'not mine' });
      expect(reject.status).toBe(404);

      const withdraw = await request(app.getHttpServer()).post(`/rest/v1/offers/${offerA}/withdraw`).set('Authorization', `Bearer ${tokenB}`);
      expect(withdraw.status).toBe(404);

      void organisation;
    });
  });
});
