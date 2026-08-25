import 'reflect-metadata';
import { EmploymentStatus, PermissionFlag, UserStatus } from '@rab/shared';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { Organisation, Permission, Role, RolePermission, User, UserRole } from '../../modules/identity/entities';
import { StaffProfile } from '../../modules/staff/entities/staff-profile.entity';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * Covers the security-audit fixes that don't fit the existing suites'
 * focus: state-machine guards on `StaffProfile.employmentStatus`,
 * `User.status` and `Venue.status` (previously plain `manager.update()`
 * calls with no transition check at all — see EMPLOYMENT_STATUS_TRANSITIONS/
 * USER_STATUS_TRANSITIONS/VENUE_TRANSITIONS in @rab/shared), and the
 * pagination cap added to the previously-unbounded list endpoints.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('access control hardening (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;

  const ownerPassword = 'correct horse battery staple 1!';
  const OWNER_PERMISSIONS = [
    PermissionFlag.STAFF_CREATE,
    PermissionFlag.STAFF_VIEW,
    PermissionFlag.STAFF_DEACTIVATE,
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.VENUE_VIEW,
    PermissionFlag.VENUE_CREATE,
    PermissionFlag.VENUE_EDIT,
    PermissionFlag.SCHEDULE_VIEW,
  ];

  async function seedOrgWithOwner(): Promise<{ organisation: Organisation; ownerEmail: string }> {
    const slug = `test-${randomUUID()}`;
    const email = `owner-${randomUUID()}@example.test`;

    const insertResult = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, {
      id: insertResult.identifiers[0]!.id as string,
    });

    await tenantContext.runInTenantContext(
      { organisationId: organisation.id, userId: randomUUID(), role: '' },
      async (manager) => {
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

        const roleResult = await manager.insert(Role, {
          organisationId: organisation.id,
          key: `owner-${randomUUID()}`,
          name: 'Owner',
          isSystem: true,
        });
        const roleId = roleResult.identifiers[0]!.id as string;
        await manager.insert(
          RolePermission,
          permissions.map((permission) => ({ roleId, permissionId: permission.id, organisationId: organisation.id })),
        );

        const passwordHash = await passwordHashing.hash(ownerPassword);
        const userResult = await manager.insert(User, {
          organisationId: organisation.id,
          email,
          passwordHash,
          firstName: 'Test',
          lastName: 'Owner',
          status: UserStatus.ACTIVE,
        });
        await manager.insert(UserRole, {
          userId: userResult.identifiers[0]!.id as string,
          roleId,
          organisationId: organisation.id,
        });
      },
    );

    return { organisation, ownerEmail: email };
  }

  async function loginOwner(ownerEmail: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: ownerEmail, password: ownerPassword });
    expect(res.status).toBe(200);
    return res.body.accessToken as string;
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

  describe('EMPLOYMENT_STATUS_TRANSITIONS — StaffProfile.employmentStatus', () => {
    it('reactivate is rejected for a staff member who is still pending_compliance, not silently approved', async () => {
      const { organisation, ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'Test', lastName: 'User', staffRef: `STF-${randomUUID().slice(0, 8)}` });
      expect(createRes.status).toBe(201);

      // create() always sets ACTIVE directly — force PENDING_COMPLIANCE
      // to exercise the state a not-yet-vetted starter would actually be in.
      await tenantContext.runInTenantContext(
        { organisationId: organisation.id, userId: randomUUID(), role: '' },
        (manager) => manager.update(StaffProfile, createRes.body.id as string, { employmentStatus: EmploymentStatus.PENDING_COMPLIANCE }),
      );

      const reactivate = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${createRes.body.id}/reactivate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(reactivate.status).toBe(409);

      const after = await request(app.getHttpServer())
        .get(`/rest/v1/staff/${createRes.body.id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(after.body.employmentStatus).toBe('pending_compliance');
    });

    it('deactivate then reactivate still works normally for an active staff member', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/staff')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `staff-${randomUUID()}@example.test`, firstName: 'Test', lastName: 'User', staffRef: `STF-${randomUUID().slice(0, 8)}` });
      expect(createRes.status).toBe(201);

      const deactivate = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${createRes.body.id}/deactivate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(deactivate.status).toBe(201);

      const reactivate = await request(app.getHttpServer())
        .post(`/rest/v1/staff/${createRes.body.id}/reactivate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(reactivate.status).toBe(201);
      expect(reactivate.body.employmentStatus).toBe('active');
    });
  });

  describe('USER_STATUS_TRANSITIONS — User.status (manager accounts)', () => {
    it('deactivating an already-deactivated manager is rejected, not a silent no-op', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/managers')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ email: `mgr-${randomUUID()}@example.test`, firstName: 'Test', lastName: 'User', type: 'internal' });
      expect(createRes.status).toBe(201);

      const first = await request(app.getHttpServer())
        .post(`/rest/v1/managers/${createRes.body.id}/deactivate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post(`/rest/v1/managers/${createRes.body.id}/deactivate`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(second.status).toBe(409);
    });
  });

  describe('VENUE_TRANSITIONS — Venue.status', () => {
    it('archiving an already-archived venue is rejected, not a silent no-op', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const createRes = await request(app.getHttpServer())
        .post('/rest/v1/venues')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: `Venue ${randomUUID()}`, type: 'hotel' });
      expect(createRes.status).toBe(201);

      const first = await request(app.getHttpServer())
        .post(`/rest/v1/venues/${createRes.body.id}/archive`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post(`/rest/v1/venues/${createRes.body.id}/archive`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(second.status).toBe(409);
    });
  });

  describe('pagination cap', () => {
    it('rejects an oversized limit on GET /shifts instead of silently capping or returning everything', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const res = await request(app.getHttpServer())
        .get('/rest/v1/shifts?limit=1000001')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(400);
    });

    it('accepts a normal limit and paginates correctly', async () => {
      const { ownerEmail } = await seedOrgWithOwner();
      const ownerToken = await loginOwner(ownerEmail);

      const res = await request(app.getHttpServer())
        .get('/rest/v1/shifts?limit=10&page=1')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
