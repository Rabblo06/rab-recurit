import 'reflect-metadata';
import { ManagerType, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import {
  AuditLog,
  Organisation,
  Permission,
  Role,
  RolePermission,
  User,
  UserRole,
} from '../../modules/identity/entities';
import { Notification } from '../../modules/notification/entities';
import { JobOffer } from '../../modules/offer/entities/job-offer.entity';
import { JobRole } from '../../modules/scheduling/entities/job-role.entity';
import { Shift } from '../../modules/scheduling/entities/shift.entity';
import { ShiftAssignment } from '../../modules/scheduling/entities/shift-assignment.entity';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { Venue } from '../../modules/venue/entities/venue.entity';
import { ManagerProfile } from '../../modules/manager/entities/manager-profile.entity';
import { ManagerWorkspace } from '../../modules/manager-workspace/entities/manager-workspace.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';

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
  let adminDataSource: DataSource;
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

    const orgInsert = await adminDataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await adminDataSource.manager.findOneByOrFail(Organisation, {
      id: orgInsert.identifiers[0]!.id as string,
    });

    let venue!: Venue;
    let adminUserId!: string;
    let workspaceId!: string;
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
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
        adminUserId = userResult.identifiers[0]!.id as string;
        await manager.insert(UserRole, { userId: adminUserId, roleId, organisationId: organisation.id });

        // A real ManagerWorkspace, otherwise this admin's resolved
        // workspaceId stays NULL forever and every Venue/StaffProfile they
        // create via the real API trips the combined org+workspace RLS
        // WITH CHECK (NULL = NULL is never true) — matching the fix already
        // applied to this session's other abuse-case specs.
        // manager_workspace_write's own WITH CHECK also requires
        // owner_user_id = current_uid() — rebind it to the real new admin
        // user, not this transaction's throwaway bootstrap identity.
        await manager.query(`SELECT set_config('rab.user_id', $1, true)`, [adminUserId]);
        const workspace = await manager.save(ManagerWorkspace, {
          organisationId: organisation.id,
          ownerUserId: adminUserId,
          name: `Test Workspace ${adminUserId}`,
          subdomain: `test-${adminUserId.slice(0, 8)}`,
          status: 'active',
        });
        await manager.insert(ManagerProfile, {
          organisationId: organisation.id,
          userId: adminUserId,
          type: ManagerType.INTERNAL,
          workspaceId: workspace.id,
        });
        workspaceId = workspace.id;
      },
    );

    // Second transaction, bound to the now-real workspace — Venue's
    // combined org+workspace RLS WITH CHECK needs the SESSION's bound
    // workspace context to match, not just the inserted row's own value.
    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: adminUserId, role: '' },
      async (manager) => {
        // Venue/JobRole are privately owned per Manager now — stamped to
        // this seed's own admin user so every test in this file (which
        // exclusively uses `adminToken` to create shifts) still passes the
        // new ownership check.
        venue = await manager.save(Venue, { organisationId: organisation.id, name: 'Test Venue', createdBy: adminUserId, workspaceId });
      },
    );

    return { organisation, adminEmail, venue };
  }

  /** Seeds a staff user (with OFFER_RESPOND) inside an existing org. */
  async function seedStaff(organisation: Organisation) {
    const email = `staff-${randomUUID()}@example.test`;
    let staffProfileId!: string;

    // The org's one ManagerWorkspace (created by seedOrg) — StaffProfile's
    // combined org+workspace RLS WITH CHECK needs the session bound to it.
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: randomUUID(), role: '' },
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
          workspaceId,
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

  async function seedJobRole(organisation: Organisation, createdBy: string, ratePence = 1200): Promise<JobRole> {
    const [{ id: workspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
      `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
      [organisation.id],
    );
    return tenantContext.runInTenantContext(
      { organisationId: organisation.id, workspaceId, userId: createdBy, role: '' },
      (manager) =>
        manager.save(JobRole, { organisationId: organisation.id, name: `Role-${randomUUID()}`, defaultRatePence: ratePence, workspaceId, createdBy }),
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
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function makeAndPublishShift(
    organisation: Organisation,
    venue: Venue,
    adminToken: string,
    opts: { requiredCount?: number; startsAt?: Date; endsAt?: Date } = {},
  ) {
    void organisation;
    // JobRole is privately owned per Manager now — created via `adminToken`'s
    // own POST (not `seedJobRole`'s throwaway seed context) so ownership
    // lines up with the caller creating the shift.
    const jobRoleRes = await request(app.getHttpServer())
      .post('/rest/v1/job-roles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `Role-${randomUUID()}`, defaultRatePence: 1200 });
    expect(jobRoleRes.status).toBe(201);
    const startsAt = opts.startsAt ?? new Date(Date.now() + 48 * 3600 * 1000);
    const endsAt = opts.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);

    const createRes = await request(app.getHttpServer())
      .post('/rest/v1/shifts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        venueId: venue.id,
        jobRoleId: jobRoleRes.body.id,
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

  describe('duplicate concurrent requests on the SAME offer — double-tap / network-retry safety', () => {
    it('two simultaneous confirms of the same offer: exactly one succeeds, the loser gets 409, and filled_count increments only once', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 3 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`);

      // The same manager double-clicks Confirm — two requests racing for the SAME offer.
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`),
        request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = res1.status === 409 ? res1 : res2;
      // Two valid messages depending on exact timing (see confirmOne's own
      // doc comment): if the loser's in-memory offer.status read happens
      // AFTER the winner's commit, assertTransition's generic
      // "Invalid transition" guard fires first, never reaching the atomic
      // UPDATE that produces the more specific message. Both are the same
      // correct security outcome — exactly one winner, the loser always
      // 409s, never a double-booking — the message text is timing-
      // dependent, not the behavior itself.
      expect(loser.body.message).toMatch(/already confirmed|no longer awaiting confirmation|invalid transition/i);

      // The critical assertion: filled_count must reflect exactly ONE real
      // confirmation, not two — this is the bug a missing atomic guard on
      // the offer's own status transition would otherwise allow (see
      // confirmOne's doc comment in offer.service.ts).
      const finalShift = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(finalShift.body.filledCount).toBe(1);
      expect(finalShift.body.status).toBe('partially_filled');
    });

    it('two simultaneous accepts of the same offer: exactly one succeeds, the loser gets 409', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });

      // Staff double-taps Accept — two requests racing for the SAME offer.
      const [res1, res2] = await Promise.all([
        request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`),
        request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);
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
      const jobRole = await seedJobRole(org.organisation, org.venue.createdBy!);

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

    it('a query with no tenant context bound returns zero rows even when filtering on shift.address (new column, same table, no new policy needed)', async () => {
      const rows = await dataSource.manager.query(`SELECT id FROM core.shift WHERE address IS NOT NULL`);
      expect(rows).toHaveLength(0);
    });
  });

  describe('bulk offer batch — one unified architecture (batch of 1 or batch of N)', () => {
    it('sendBulk returns a shared batchId, sends N offers in one call, and confirmAll confirms only the staff_accepted ones in that batch', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 3 });
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);
      const staffC = await seedStaff(organisation);

      const bulk = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers/bulk`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileIds: [staffA.staffProfileId, staffB.staffProfileId, staffC.staffProfileId] });
      expect(bulk.status).toBe(201);
      expect(bulk.body.batchId).toEqual(expect.any(String));
      expect(bulk.body.results).toHaveLength(3);
      expect(bulk.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

      const batchId = bulk.body.batchId as string;
      const offerIdFor = (staffProfileId: string) =>
        bulk.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === staffProfileId).offerId as string;

      const tokenA = await login(staffA.email);
      const tokenB = await login(staffB.email);
      // staffC deliberately never accepts — stays `pending`.
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offerIdFor(staffA.staffProfileId)}/accept`).set('Authorization', `Bearer ${tokenA}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offerIdFor(staffB.staffProfileId)}/accept`).set('Authorization', `Bearer ${tokenB}`);

      const confirmAll = await request(app.getHttpServer())
        .post(`/rest/v1/offers/batches/${batchId}/confirm-all`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirmAll.status).toBe(201);
      // Only the 2 staff_accepted offers were eligible — staffC's still-pending offer is untouched.
      expect(confirmAll.body.results).toHaveLength(2);
      expect(confirmAll.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

      const batch = await request(app.getHttpServer())
        .get(`/rest/v1/offers/batches/${batchId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(batch.status).toBe(200);
      expect(batch.body.counts.manager_confirmed).toBe(2);
      expect(batch.body.counts.pending).toBe(1);
    });

    it('sendBulk isolates one recipient\'s failure — the other two still persist in the same batch', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 5 });
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);
      const staffC = await seedStaff(organisation);

      // staffB already has an assignment on this shift — sendOne rejects it with a ConflictException.
      await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffB.staffProfileId });

      const bulk = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers/bulk`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileIds: [staffA.staffProfileId, staffB.staffProfileId, staffC.staffProfileId] });
      expect(bulk.status).toBe(201);

      const byStaff = (id: string) => bulk.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === id);
      expect(byStaff(staffA.staffProfileId).ok).toBe(true);
      expect(byStaff(staffB.staffProfileId).ok).toBe(false);
      expect(byStaff(staffC.staffProfileId).ok).toBe(true);

      // The shared transaction must not have been aborted by staffB's failure —
      // staffA's and staffC's bulk offers actually persisted (the pre-seeded
      // single-send offer to staffB is a separate, earlier batch — filter to
      // this bulk call's own batchId to isolate what this test is proving).
      const offers = await request(app.getHttpServer())
        .get('/rest/v1/offers')
        .set('Authorization', `Bearer ${adminToken}`);
      const persistedForBatch = offers.body.filter((o: { offerBatchId: string }) => o.offerBatchId === bulk.body.batchId);
      expect(persistedForBatch).toHaveLength(2);
    });

    it('confirmAll processes each recipient independently — one losing the last-seat check does not roll back a batch-mate\'s successful confirm', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);

      const bulk = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers/bulk`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileIds: [staffA.staffProfileId, staffB.staffProfileId] });
      const batchId = bulk.body.batchId as string;
      const offerIdFor = (staffProfileId: string) =>
        bulk.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === staffProfileId).offerId as string;

      const tokenA = await login(staffA.email);
      const tokenB = await login(staffB.email);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offerIdFor(staffA.staffProfileId)}/accept`).set('Authorization', `Bearer ${tokenA}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offerIdFor(staffB.staffProfileId)}/accept`).set('Authorization', `Bearer ${tokenB}`);

      const confirmAll = await request(app.getHttpServer())
        .post(`/rest/v1/offers/batches/${batchId}/confirm-all`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirmAll.status).toBe(201);

      const results = confirmAll.body.results as Array<{ ok: boolean; message?: string }>;
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0]!.message).toMatch(/SHIFT_FULL/);

      const finalShift = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${shift.id}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(finalShift.body.filledCount).toBe(1);
      expect(finalShift.body.status).toBe('fully_filled');
    });

    it('a role with OFFER_SEND but not OFFER_CONFIRM gets 403 on confirm-all', async () => {
      const sendOnlyPerms = [PermissionFlag.SCHEDULE_VIEW, PermissionFlag.SCHEDULE_CREATE, PermissionFlag.SCHEDULE_PUBLISH, PermissionFlag.OFFER_SEND, PermissionFlag.OFFER_WITHDRAW];
      const org = await seedOrg(sendOnlyPerms);
      const token = await login(org.adminEmail);
      const shift = await makeAndPublishShift(org.organisation, org.venue, token, { requiredCount: 1 });
      const staff = await seedStaff(org.organisation);

      const bulk = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers/bulk`)
        .set('Authorization', `Bearer ${token}`)
        .send({ staffProfileIds: [staff.staffProfileId] });
      expect(bulk.status).toBe(201);

      const res = await request(app.getHttpServer())
        .post(`/rest/v1/offers/batches/${bulk.body.batchId}/confirm-all`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it("org B guessing org A's real batch id gets 404, not 403 or an empty-but-200 body", async () => {
      const orgA = await seedOrg(MANAGER_PERMS);
      const orgB = await seedOrg(MANAGER_PERMS);
      const tokenA = await login(orgA.adminEmail);
      const tokenB = await login(orgB.adminEmail);

      const shift = await makeAndPublishShift(orgA.organisation, orgA.venue, tokenA, { requiredCount: 1 });
      const staffA = await seedStaff(orgA.organisation);
      const bulk = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers/bulk`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ staffProfileIds: [staffA.staffProfileId] });

      const res = await request(app.getHttpServer())
        .get(`/rest/v1/offers/batches/${bulk.body.batchId}`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);
    });

    it('staff (OFFER_RESPOND only, no SCHEDULE_VIEW) gets 403 viewing a batch — batch/activity views are manager-only', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const bulk = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers/bulk`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileIds: [staff.staffProfileId] });

      const res = await request(app.getHttpServer())
        .get(`/rest/v1/offers/batches/${bulk.body.batchId}`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('unified create-and-send — POST /shifts/with-offers (New Shift drawer)', () => {
    function shiftAndSendBody(venue: Venue, jobRole: JobRole, staffProfileIds: string[], overrides: Partial<{ startsAt: Date; endsAt: Date }> = {}) {
      // 52h default deliberately overlaps makeAndPublishShift's own default
      // window (48h-56h from now) — needed by the conflict-detection tests
      // below, which seed an earlier confirmed shift via that helper.
      const startsAt = overrides.startsAt ?? new Date(Date.now() + 52 * 3600 * 1000);
      const endsAt = overrides.endsAt ?? new Date(startsAt.getTime() + 8 * 3600 * 1000);
      return {
        venueId: venue.id,
        jobRoleId: jobRole.id,
        address: '123 Oxford Street, London W1D 2JE',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        staffProfileIds,
      };
    }

    it('single staff: create-and-send end to end to CONFIRMED', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const jobRole = await seedJobRole(organisation, venue.createdBy!);
      const staff = await seedStaff(organisation);

      const created = await request(app.getHttpServer())
        .post('/rest/v1/shifts/with-offers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(shiftAndSendBody(venue, jobRole, [staff.staffProfileId]));
      expect(created.status).toBe(201);
      expect(created.body.results).toHaveLength(1);
      expect(created.body.results[0].ok).toBe(true);

      const shiftAfter = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${created.body.shiftId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(shiftAfter.body.status).toBe('offered');
      expect(shiftAfter.body.requiredCount).toBe(1);
      expect(shiftAfter.body.address).toBe('123 Oxford Street, London W1D 2JE');

      const staffToken = await login(staff.email);
      const offerId = created.body.results[0].offerId as string;
      const accept = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offerId}/accept`)
        .set('Authorization', `Bearer ${staffToken}`);
      expect(accept.status).toBe(201);

      const confirm = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offerId}/confirm`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirm.status).toBe(201);
      expect(confirm.body.status).toBe('manager_confirmed');

      const finalShift = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${created.body.shiftId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(finalShift.body.status).toBe('fully_filled');
      expect(finalShift.body.filledCount).toBe(1);
    });

    it('multi staff: create-and-send to 3, mixed accept/decline, confirmAll confirms only the accepted one', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const jobRole = await seedJobRole(organisation, venue.createdBy!);
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);
      const staffC = await seedStaff(organisation);

      const created = await request(app.getHttpServer())
        .post('/rest/v1/shifts/with-offers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(shiftAndSendBody(venue, jobRole, [staffA.staffProfileId, staffB.staffProfileId, staffC.staffProfileId]));
      expect(created.status).toBe(201);
      expect(created.body.results).toHaveLength(3);
      expect(created.body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);

      const shiftAfter = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${created.body.shiftId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(shiftAfter.body.requiredCount).toBe(3);

      const offerIdFor = (staffProfileId: string) =>
        created.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === staffProfileId).offerId as string;

      const tokenA = await login(staffA.email);
      const tokenB = await login(staffB.email);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offerIdFor(staffA.staffProfileId)}/accept`).set('Authorization', `Bearer ${tokenA}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offerIdFor(staffB.staffProfileId)}/decline`).set('Authorization', `Bearer ${tokenB}`).send({});
      // staffC deliberately never responds — stays `pending`.

      const confirmAll = await request(app.getHttpServer())
        .post(`/rest/v1/offers/batches/${created.body.batchId}/confirm-all`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(confirmAll.status).toBe(201);
      expect(confirmAll.body.results).toHaveLength(1);
      expect(confirmAll.body.results[0].ok).toBe(true);

      const batch = await request(app.getHttpServer())
        .get(`/rest/v1/offers/batches/${created.body.batchId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(batch.body.counts.manager_confirmed).toBe(1);
      expect(batch.body.counts.declined).toBe(1);
      expect(batch.body.counts.pending).toBe(1);
    });

    it('a staff member with a pre-existing confirmed overlapping shift is skipped with a clear message, the other recipient still succeeds', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const jobRole = await seedJobRole(organisation, venue.createdBy!);
      const conflictedStaff = await seedStaff(organisation);
      const cleanStaff = await seedStaff(organisation);

      // Give conflictedStaff an existing CONFIRMED shift first, via the old flow.
      const earlierShift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const earlierOffer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${earlierShift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: conflictedStaff.staffProfileId });
      const conflictedToken = await login(conflictedStaff.email);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${earlierOffer.body.id}/accept`).set('Authorization', `Bearer ${conflictedToken}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${earlierOffer.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`);

      // New shift's time window deliberately overlaps earlierShift's default window.
      const created = await request(app.getHttpServer())
        .post('/rest/v1/shifts/with-offers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(shiftAndSendBody(venue, jobRole, [conflictedStaff.staffProfileId, cleanStaff.staffProfileId]));
      expect(created.status).toBe(201);

      const byStaff = (id: string) => created.body.results.find((r: { staffProfileId: string }) => r.staffProfileId === id);
      expect(byStaff(conflictedStaff.staffProfileId).ok).toBe(false);
      expect(byStaff(conflictedStaff.staffProfileId).message).toMatch(/already has a confirmed shift/);
      expect(byStaff(cleanStaff.staffProfileId).ok).toBe(true);

      // requiredCount corrected down to the 1 recipient who actually got an offer.
      const shiftAfter = await request(app.getHttpServer())
        .get(`/rest/v1/shifts/${created.body.shiftId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(shiftAfter.body.requiredCount).toBe(1);
    });

    it('every recipient failing rolls back the whole action — no dangling shift row is left behind', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const jobRole = await seedJobRole(organisation, venue.createdBy!);
      const staff = await seedStaff(organisation);

      const earlierShift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const earlierOffer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${earlierShift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      const staffToken = await login(staff.email);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${earlierOffer.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${earlierOffer.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`);

      const before = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.count(Shift, {}),
      );

      const created = await request(app.getHttpServer())
        .post('/rest/v1/shifts/with-offers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(shiftAndSendBody(venue, jobRole, [staff.staffProfileId]));
      expect(created.status).toBe(409);

      const after = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.count(Shift, {}),
      );
      expect(after).toBe(before);
    });

    it('a role without OFFER_SEND cannot use the unified create-and-send endpoint', async () => {
      const { organisation, adminEmail, venue } = await seedOrg([PermissionFlag.SCHEDULE_VIEW]);
      const adminToken = await login(adminEmail);
      const jobRole = await seedJobRole(organisation, venue.createdBy!);
      const staff = await seedStaff(organisation);

      const res = await request(app.getHttpServer())
        .post('/rest/v1/shifts/with-offers')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(shiftAndSendBody(venue, jobRole, [staff.staffProfileId]));
      expect(res.status).toBe(403);
    });
  });

  describe('activity log — every offer transition writes audit_log + notification rows', () => {
    const AUDIT_MANAGER_PERMS = [...MANAGER_PERMS, PermissionFlag.AUDIT_VIEW];

    it('sending and confirming an offer produces audit_log rows (entity_type=offer) and a notification for the counterpart party', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(AUDIT_MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/accept`).set('Authorization', `Bearer ${staffToken}`);
      await request(app.getHttpServer()).post(`/rest/v1/offers/${offer.body.id}/confirm`).set('Authorization', `Bearer ${adminToken}`);

      const auditRows = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.find(AuditLog, { where: { entityType: 'offer', entityId: offer.body.id } }),
      );
      const actions = auditRows.map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(['offer.sent', 'offer.accepted', 'offer.confirmed']));

      // GET /audit-logs (the endpoint TimelinePanel.tsx/AuditLog.tsx were built against) is actor-scoped
      // for a non-platform-admin caller (see audit-log-abuse-cases.integration.spec.ts) — adminToken here
      // is an ordinary manager account (seedOrg never claims platform admin), so it sees its own actions
      // (offer.sent, offer.confirmed) but not staff's own offer.accepted, even though all three rows
      // genuinely exist (asserted directly against the table above).
      const auditApi = await request(app.getHttpServer())
        .get('/rest/v1/audit-logs')
        .query({ entityType: 'offer', entityId: offer.body.id })
        .set('Authorization', `Bearer ${adminToken}`);
      expect(auditApi.status).toBe(200);
      const apiActions = auditApi.body.items.map((i: { action: string }) => i.action);
      expect(apiActions).toEqual(expect.arrayContaining(['offer.sent', 'offer.confirmed']));
      expect(apiActions).not.toContain('offer.accepted');

      const [{ id: sanityWorkspaceId2 }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
        [organisation.id],
      );
      const staffUserRow = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: sanityWorkspaceId2, userId: randomUUID(), role: '' },
        (manager) => manager.findOneByOrFail(StaffProfile, { id: staff.staffProfileId }),
      );
      const staffNotifications = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.find(Notification, { where: { userId: staffUserRow.userId, relatedEntityId: offer.body.id } }),
      );
      expect(staffNotifications.some((n) => n.type === 'offer_confirmed')).toBe(true);
    });

    it("org B guessing org A's real offer id on GET /audit-logs gets 404-equivalent — an empty items array, never org A's rows", async () => {
      const orgA = await seedOrg(AUDIT_MANAGER_PERMS);
      const orgB = await seedOrg(AUDIT_MANAGER_PERMS);
      const tokenA = await login(orgA.adminEmail);
      const tokenB = await login(orgB.adminEmail);

      const shift = await makeAndPublishShift(orgA.organisation, orgA.venue, tokenA, { requiredCount: 1 });
      const staffA = await seedStaff(orgA.organisation);
      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ staffProfileId: staffA.staffProfileId });

      const res = await request(app.getHttpServer())
        .get('/rest/v1/audit-logs')
        .query({ entityType: 'offer', entityId: offer.body.id })
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('a role without AUDIT_VIEW gets 403 on GET /audit-logs', async () => {
      const org = await seedOrg(MANAGER_PERMS); // deliberately no AUDIT_VIEW
      const token = await login(org.adminEmail);

      const res = await request(app.getHttpServer())
        .get('/rest/v1/audit-logs')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });
  });

  describe('in-app notifications', () => {
    it('a user cannot mark another user\'s notification read — 404, not a silent no-op or a cross-user update', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);
      const tokenB = await login(staffB.email);

      // Send staffA an offer — this creates exactly one notification for staffA.
      await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffA.staffProfileId });

      const [{ id: sanityWorkspaceId3 }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
        [organisation.id],
      );
      const staffAUserRow = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: sanityWorkspaceId3, userId: randomUUID(), role: '' },
        (manager) => manager.findOneByOrFail(StaffProfile, { id: staffA.staffProfileId }),
      );
      const notifications = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.find(Notification, { where: { userId: staffAUserRow.userId } }),
      );
      expect(notifications.length).toBeGreaterThan(0);
      const staffANotificationId = notifications[0]!.id;

      // staffB (a different user in the same org) tries to mark staffA's notification read.
      const res = await request(app.getHttpServer())
        .post(`/rest/v1/notifications/${staffANotificationId}/read`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(res.status).toBe(404);

      const stillUnread = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: null, userId: randomUUID(), role: '' },
        (manager) => manager.findOneByOrFail(Notification, { id: staffANotificationId }),
      );
      expect(stillUnread.readAt).toBeFalsy();
    });

    it("a user can list and mark their own notifications read, and unread-count reflects it", async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staff = await seedStaff(organisation);
      const staffToken = await login(staff.email);

      await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staff.staffProfileId });

      const before = await request(app.getHttpServer())
        .get('/rest/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(before.body.count).toBeGreaterThan(0);

      const list = await request(app.getHttpServer())
        .get('/rest/v1/notifications')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(list.status).toBe(200);
      expect(list.body.length).toBeGreaterThan(0);

      const markAll = await request(app.getHttpServer())
        .post('/rest/v1/notifications/read-all')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(markAll.status).toBe(204);

      const after = await request(app.getHttpServer())
        .get('/rest/v1/notifications/unread-count')
        .set('Authorization', `Bearer ${staffToken}`);
      expect(after.body.count).toBe(0);
    });
  });

  describe('GET /offers/mine — content isolation (mobile Staff Auth Foundation increment)', () => {
    it("staff A's /offers/mine never contains staff B's offer, and vice versa", async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shiftA = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const shiftB = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);

      const offerA = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftA.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffA.staffProfileId });
      const offerB = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shiftB.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffB.staffProfileId });

      const tokenA = await login(staffA.email);
      const tokenB = await login(staffB.email);

      const mineA = await request(app.getHttpServer())
        .get('/rest/v1/offers/mine')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(mineA.status).toBe(200);
      expect(mineA.body).toHaveLength(1);
      expect(mineA.body[0].id).toBe(offerA.body.id);
      expect(mineA.body.map((o: { id: string }) => o.id)).not.toContain(offerB.body.id);

      const mineB = await request(app.getHttpServer())
        .get('/rest/v1/offers/mine')
        .set('Authorization', `Bearer ${tokenB}`);
      expect(mineB.status).toBe(200);
      expect(mineB.body).toHaveLength(1);
      expect(mineB.body[0].id).toBe(offerB.body.id);
      expect(mineB.body.map((o: { id: string }) => o.id)).not.toContain(offerA.body.id);
    });

    it('a staff member with zero offers sent gets an empty array, never another staff member\'s data', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staffWithOffer = await seedStaff(organisation);
      const staffWithNone = await seedStaff(organisation);

      await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffWithOffer.staffProfileId });

      const tokenNone = await login(staffWithNone.email);
      const mine = await request(app.getHttpServer())
        .get('/rest/v1/offers/mine')
        .set('Authorization', `Bearer ${tokenNone}`);
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual([]);
    });

    it('staff B accepting/declining staff A\'s offer id by guessing it gets a 404, not a state change', async () => {
      const { organisation, adminEmail, venue } = await seedOrg(MANAGER_PERMS);
      const adminToken = await login(adminEmail);
      const shift = await makeAndPublishShift(organisation, venue, adminToken, { requiredCount: 1 });
      const staffA = await seedStaff(organisation);
      const staffB = await seedStaff(organisation);

      const offer = await request(app.getHttpServer())
        .post(`/rest/v1/shifts/${shift.id}/offers`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ staffProfileId: staffA.staffProfileId });

      const tokenB = await login(staffB.email);

      const acceptAttempt = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/accept`)
        .set('Authorization', `Bearer ${tokenB}`);
      expect(acceptAttempt.status).toBe(404);

      const declineAttempt = await request(app.getHttpServer())
        .post(`/rest/v1/offers/${offer.body.id}/decline`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ reason: 'not mine' });
      expect(declineAttempt.status).toBe(404);

      const [{ id: sanityWorkspaceId }] = await adminDataSource.manager.query<[{ id: string }]>(
        `SELECT id FROM core.manager_workspace WHERE organisation_id = $1`,
        [organisation.id],
      );
      const offerAfter = await tenantContext.runInTenantContext(
        { organisationId: organisation.id, workspaceId: sanityWorkspaceId, userId: randomUUID(), role: '' },
        (manager) => manager.findOneByOrFail(JobOffer, { id: offer.body.id }),
      );
      expect(offerAfter.status).toBe('pending');
    });
  });
});
