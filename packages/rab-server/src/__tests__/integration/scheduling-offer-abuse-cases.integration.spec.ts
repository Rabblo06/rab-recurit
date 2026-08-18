import 'reflect-metadata';
import { PermissionFlag, UserStatus } from '@rab/shared';
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
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * Scheduling + offer abuse-case suite (rab-workforce-architecture.md §1.2,
 * §8.4, §11.1). Real Postgres, RLS on, no mocks. Needs DATABASE_URL —
 * skipped locally if unset, same convention as auth-abuse-cases.spec.ts.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('scheduling + offer abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const password = 'correct horse battery staple 1!';

  async function ensurePermission(key: string, resource: string, action: string): Promise<Permission> {
    let permission = await dataSource.manager.findOne(Permission, { where: { key } });
    if (!permission) {
      permission = await dataSource.manager.save(Permission, { key, resource, action });
    }
    return permission;
  }

  /** Seeds an org, an admin with the given permission set, and one venue. */
  async function seedOrg(permissionKeys: string[]) {
    const slug = `test-${randomUUID()}`;
    const adminEmail = `admin-${randomUUID()}@example.test`;

    const orgInsert = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: orgInsert.identifiers[0]!.id as string,
    });

    let venue!: Venue;
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
      async (manager) => {
        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: 'org_admin',
          name: 'Org Admin',
          isSystem: true,
        });
        const roleId = roleResult.identifiers[0]!.id as string;

        for (const key of permissionKeys) {
          const permission = await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);
          await manager.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
        }

        const passwordHash = await passwordHashing.hash(password);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email: adminEmail,
          passwordHash,
          firstName: 'Test',
          lastName: 'Admin',
          status: UserStatus.ACTIVE,
        });
        await manager.insert(UserRole, { userId: userResult.identifiers[0]!.id as string, roleId, organisationId: organisation.id });

        venue = await manager.save(Venue, { organisationId: organisation.id, name: 'Test Venue' });
      },
    );

    return { organisation, adminEmail, venue };
  }

  /** Seeds a staff user (with OFFER_RESPOND) inside an existing org. */
  async function seedStaff(organisation: Organisation) {
    const email = `staff-${randomUUID()}@example.test`;
    let staffProfileId!: string;

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
      async (manager) => {
        let role = await manager.findOne(Role, { where: { organisationId: organisation.id, key: 'staff' } });
        if (!role) {
          const permission = await ensurePermission(PermissionFlag.OFFER_RESPOND, 'offer', 'respond');
          const roleResult = await manager.insert(Role, {
            organisationId: organisation.id,
            key: 'staff',
            name: 'Staff',
            isSystem: true,
          });
          role = await manager.findOneByOrFail(Role, { id: roleResult.identifiers[0]!.id as string });
          await manager.insert(RolePermission, { roleId: role.id, permissionId: permission.id, organisationId: organisation.id });
        }

        const passwordHash = await passwordHashing.hash(password);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: 'Staff',
          lastName: 'Member',
          status: UserStatus.ACTIVE,
        });
        const userId = userResult.identifiers[0]!.id as string;
        await manager.insert(UserRole, { userId, roleId: role.id, organisationId: organisation.id });

        const profile = await manager.save(StaffProfile, {
          organisationId: organisation.id,
          userId,
          staffRef: `STF-${randomUUID().slice(0, 8)}`,
        });
        staffProfileId = profile.id;
      },
    );

    return { email, staffProfileId };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/rest/v1/auth/login')
      .send({ email, password });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
  }

  async function seedJobRole(organisation: Organisation, ratePence = 1200): Promise<JobRole> {
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
      (manager) => manager.save(JobRole, { organisationId: organisation.id, name: `Role-${randomUUID()}`, defaultRatePence: ratePence }),
    );
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    passwordHashing = moduleRef.get(PasswordHashingService);
    tenantContext = moduleRef.get(TenantContextService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function makeAndPublishShift(
    organisation: Organisation,
    venue: Venue,
    adminToken: string,
    opts: { requiredCount?: number; startsAt?: Date; endsAt?: Date } = {},
  ) {
    const jobRole = await seedJobRole(organisation);
    const startsAt = opts.startsAt ?? new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = opts.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);

    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        venueId: venue.id,
        jobRoleId: jobRole.id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        requiredCount: opts.requiredCount ?? 1,
      });
    expect(createRes.status).toBe(201);

    const publishRes = await request(app.getHttpServer())
      .post(`/rest/v1/shifts/${createRes.body.id}/publish`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(publishRes.status).toBe(201);

    return createRes.body as { id: string };
  }

  const MANAGER_PERMS = [
    PermissionFlag.SCHEDULE_VIEW,
    PermissionFlag.SCHEDULE_CREATE,
    PermissionFlag.SCHEDULE_PUBLISH,
    PermissionFlag.OFFER_SEND,
    PermissionFlag.OFFER_CONFIRM,
  ];

  describe('two-step acceptance — staff accepting never confirms the shift', () => {
    it('staff accepting an offer moves it to staff_accepted, not manager_confirmed, and does not claim a seat', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });

      const accept = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/accept`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(accept.status).toBe(201);
      expect(accept.body.status).toBe('staff_accepted');

      const shiftAfter = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(shiftAfter.body.filledCount).toBe(0);
      expect(shiftAfter.body.status).not.toBe('fully_filled');
    });

    it('staff cannot confirm their own accepted offer — the endpoint requires OFFER_CONFIRM, which staff never has', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/accept`)
        .set('Authorization', `Bearer ${staffToken}`);

      const confirmAttempt = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/confirm`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(confirmAttempt.status).toBe(403);
    });

    it('a manager cannot confirm an offer that is still pending (staff has not accepted yet)', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });

      const confirmAttempt = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirmAttempt.status).toBe(409);
    });

    it('manager confirm completes the flow: shift is filled only after MANAGER_CONFIRMED, not after STAFF_ACCEPTED', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/accept`)
        .set('Authorization', `Bearer ${staffToken}`);

      const confirm = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirm.status).toBe(201);
      expect(confirm.body.status).toBe('manager_confirmed');

      const shiftAfter = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(shiftAfter.body.filledCount).toBe(1);
      expect(shiftAfter.body.status).toBe('fully_filled');
    });

    it('manager reject after staff acceptance leaves the shift unfilled and the offer terminally rejected', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/accept`)
        .set('Authorization', `Bearer ${staffToken}`);

      const reject = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Venue cancelled the shift' });
      expect(reject.status).toBe(201);
      expect(reject.body.status).toBe('manager_rejected');
      expect(reject.body.rejectionReason).toBe('Venue cancelled the shift');

      const shiftAfter = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(shiftAfter.body.filledCount).toBe(0);

      // Terminal — a second confirm/reject attempt must not succeed.
      const secondConfirm = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(secondConfirm.status).toBe(409);
    });
  });

  describe('race-safe confirm — the last-seat race', () => {
    it('two staff can both accept the same single-seat shift; exactly one manager-confirm succeeds, the loser gets a clean 409', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });

      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);

      const offerA = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffA.staffProfileId });
      const offerB = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffB.staffProfileId });

      const tokenA = await login(staffA.email);
      const tokenB = await login(staffB.email);

      // Both accept — staff-accept never checks capacity, so both succeed.
      const acceptA = await request(app.getHttpServer()).post(`/rest/v1/offers/${offerA.body.id}/accept`).set('Authorization', `Bearer ${tokenA}`);
      const acceptB = await request(app.getHttpServer()).post(`/rest/v1/offers/${offerB.body.id}/accept`).set('Authorization', `Bearer ${tokenB}`);
      expect(acceptA.status).toBe(201);
      expect(acceptB.status).toBe(201);

      // The manager races to confirm both — this is where capacity is actually claimed now.
      const [resA, resB] = await Promise.all([
        request(app.getHttpServer()).post(`/rest/v1/offers/${offerA.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`),
        request(app.getHttpServer()).post(`/rest/v1/offers/${offerB.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`),
      ]);

      const results = [resA, resB];
      const winners = results.filter((r) => r.status === 201 || r.status === 200);
      const losers = results.filter((r) => r.status === 409);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.body.message).toMatch(/SHIFT_FULL/);

      const finalShift = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(finalShift.body.status).toBe('fully_filled');
      expect(finalShift.body.filledCount).toBe(1);
    });
  });

  describe('double-booking guard (GiST exclusion constraint)', () => {
    it('confirming an offer that overlaps an already-confirmed shift is rejected with 409, not a raw DB error', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const start1 = new Date(Date.now() + 72 * 3600 * 1000);
      const end1 = new Date(start1.getTime() + 8 * 3600 * 1000);
      const start2 = new Date(start1.getTime() + 4 * 3600 * 1000); // overlaps shift1
      const end2 = new Date(start2.getTime() + 8 * 3600 * 1000);

      const shift1 = await makeAndPublishShift(organisation, venue, adminToken, { startsAt: start1, endsAt: end1, requiredCount: 2 });
      const shift2 = await makeAndPublishShift(organisation, venue, adminToken, { startsAt: start2, endsAt: end2, requiredCount: 2 });

      const offer1 = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift1.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      const offer2 = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift2.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });

      // Staff can accept both overlapping offers — staff-accept doesn't check overlap either.
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer1.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer2.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`);

      const confirm1 = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer1.body.id}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirm1.status).toBe(201);

      const confirm2 = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer2.body.id}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirm2.status).toBe(409);
      expect(confirm2.body.message).not.toMatch(/ExclusionViolation|duplicate key|SQLSTATE/i);
    });
  });

  describe('cross-tenant isolation — 404, not 403', () => {
    it("org B cannot view org A's shift", async () => {
      const orgA = await seedOrg(MANAGER_PERMS);
      const orgB = await seedOrg([PermissionFlag.SCHEDULE_VIEW]);
      const tokenA = await login(orgA.adminEmail);
      const tokenB = await login(orgB.adminEmail);

      const shift = await makeAndPublishShift(orgA.organisation, orgA.venue, tokenA);

      const res = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });

    it("org B cannot send an offer against org A's shift", async () => {
      const orgA = await seedOrg(MANAGER_PERMS);
      const orgB = await seedOrg([PermissionFlag.OFFER_SEND]);
      const tokenA = await login(orgA.adminEmail);
      const tokenB = await login(orgB.adminEmail);

      const shift = await makeAndPublishShift(orgA.organisation, orgA.venue, tokenA);
      const staffB = await seedStaff(orgB.organisation);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ staffProfileId: staffB.staffProfileId });
      expect(res.status).toBe(404);
    });

    it("org B cannot confirm org A's staff-accepted offer", async () => {
      const orgA = await seedOrg(MANAGER_PERMS);
      const orgB = await seedOrg(MANAGER_PERMS);
      const tokenA = await login(orgA.adminEmail);
      const tokenB = await login(orgB.adminEmail);

      const shift = await makeAndPublishShift(orgA.organisation, orgA.venue, tokenA);
      const staffA = await seedStaff(orgA.organisation);
      const staffTokenA = await login(staffA.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ staffProfileId: staffA.staffProfileId });
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${staffTokenA}`);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/confirm`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });
  });

  describe('permission denial — 403', () => {
    it('a role without OFFER_SEND cannot send an offer', async () => {
      const org = await seedOrg([PermissionFlag.SCHEDULE_VIEW, PermissionFlag.SCHEDULE_CREATE, PermissionFlag.SCHEDULE_PUBLISH]);
      const adminToken = await login(org.adminEmail);
      const shift = await makeAndPublishShift(org.organisation, org.venue, adminToken);
      const staff = await seedStaff(org.organisation);

      // The admin here deliberately lacks OFFER_SEND.
      const res = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      expect(res.status).toBe(403);
    });

    it('a role without SCHEDULE_CREATE cannot create a shift', async () => {
      const org = await seedOrg([PermissionFlag.SCHEDULE_VIEW]);
      const token = await login(org.adminEmail);
      const jobRole = await seedJobRole(org.organisation);

      const res = await request(app.getHttpServer())
        .post('/rest/v1/shifts')
        .set('Authorization', `Bearer ${token}`)
        .send({
          venueId: org.venue.id,
          jobRoleId: jobRole.id,
          startsAt: new Date(Date.now() + 3600 * 1000).toISOString(),
          endsAt: new Date(Date.now() + 7200 * 1000).toISOString(),
          requiredCount: 1,
        });
      expect(res.status).toBe(403);
    });

    it('a role without OFFER_CONFIRM cannot confirm a staff-accepted offer', async () => {
      const org = await seedOrg([
        PermissionFlag.SCHEDULE_VIEW,
        PermissionFlag.SCHEDULE_CREATE,
        PermissionFlag.SCHEDULE_PUBLISH,
        PermissionFlag.OFFER_SEND,
      ]);
      const adminToken = await login(org.adminEmail);
      const shift = await makeAndPublishShift(org.organisation, org.venue, adminToken);
      const staff = await seedStaff(org.organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`);

      // This admin role deliberately lacks OFFER_CONFIRM.
      const res = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('state machine — invalid transitions are rejected, not silently accepted', () => {
    it('publishing an already-published shift returns 409, not 200', async () => {
      const org = await seedOrg(MANAGER_PERMS);
      const token = await login(org.adminEmail);
      const shift = await makeAndPublishShift(org.organisation, org.venue, token);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/publish`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(409);
    });
  });

  describe('row-level security — the fail-closed guarantee', () => {
    it('a query with no tenant context bound returns zero rows for every new scheduling table', async () => {
      await expect(dataSource.manager.find(Shift)).resolves.toEqual([]);
      await expect(dataSource.manager.find(ShiftAssignment)).resolves.toEqual([]);
      await expect(dataSource.manager.find(JobOffer)).resolves.toEqual([]);
      await expect(dataSource.manager.find(JobRole)).resolves.toEqual([]);
    });
  });
});
