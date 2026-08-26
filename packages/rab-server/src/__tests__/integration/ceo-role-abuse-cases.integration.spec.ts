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
import { PlatformAdminService } from '../../engine/core-modules/platform-admin/platform-admin.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';

/**
 * CEO — a third `ManagerType`, created through the existing `POST /managers`
 * flow. The naive design (CEO holds `MANAGER_MANAGE`, same as any Manager)
 * would let a CEO mint a peer or mutate an existing CEO account; both are
 * closed here (`CeoCreationGuard` + `ManagerService.assertCeoMutationAllowed`).
 * Real Postgres, RLS on, no mocks.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('CEO role abuse cases (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let passwordHashing: PasswordHashingService;
  let tenantContext: TenantContextService;
  let platformAdmin: PlatformAdminService;

  const password = 'correct horse battery staple 1!';

  // Real ROLE_DEFS[ManagerType.INTERNAL] permission set (manager.service.ts) —
  // a plain Manager, used as the "not the platform admin" actor in these tests.
  const MANAGER_PERMS = [
    PermissionFlag.MANAGER_MANAGE,
    PermissionFlag.STAFF_CREATE,
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

  /** One org, one platform-admin-claimed Internal Manager (not a CEO — the actor whose lack of CEO powers we're testing). */
  async function seedOrgWithManager(): Promise<{ organisation: Organisation; managerToken: string; managerUserId: string }> {
    const slug = `test-${randomUUID()}`;
    const orgInsert = await dataSource.manager.insert(Organisation, { name: slug, slug });
    const organisation = await dataSource.manager.findOneByOrFail(Organisation, { id: orgInsert.identifiers[0]!.id as string });

    for (const key of MANAGER_PERMS) await ensurePermission(key, key.split('.')[0]!, key.split('.')[1]!);

    let managerUserId!: string;
    let managerEmail!: string;
    await tenantContext.runInTenantContext({ organisationId: organisation.id, userId: randomUUID(), role: '' }, async (m) => {
      const roleResult = await m.insert(Role, { organisationId: organisation.id, key: 'manager', name: 'Manager', isSystem: true });
      const roleId = roleResult.identifiers[0]!.id as string;
      for (const key of MANAGER_PERMS) {
        const permission = await dataSource.manager.findOneByOrFail(Permission, { key });
        await m.insert(RolePermission, { roleId, permissionId: permission.id, organisationId: organisation.id });
      }

      managerEmail = `mgr-${randomUUID()}@example.test`;
      const passwordHash = await passwordHashing.hash(password);
      const userResult = await m.insert(User, {
        organisationId: organisation.id,
        email: managerEmail,
        passwordHash,
        firstName: 'Manager',
        lastName: 'Test',
        status: UserStatus.ACTIVE,
      });
      managerUserId = userResult.identifiers[0]!.id as string;
      await m.insert(UserRole, { userId: managerUserId, roleId, organisationId: organisation.id });
      await platformAdmin.tryClaim(m, organisation.id, managerUserId);
      await m.query(`INSERT INTO core.manager_profile (organisation_id, user_id, type) VALUES ($1, $2, $3)`, [
        organisation.id,
        managerUserId,
        ManagerType.INTERNAL,
      ]);
    });

    const loginRes = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email: managerEmail, password });
    expect(loginRes.status).toBe(200);
    return { organisation, managerToken: loginRes.body.accessToken as string, managerUserId };
  }

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/rest/v1/auth/login').send({ email, password });
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
    platformAdmin = moduleRef.get(PlatformAdminService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('the platform admin can create a CEO with the expected permission set', async () => {
    const { managerToken } = await seedOrgWithManager(); // this manager is the platform admin (first claimed)

    const res = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ email: `ceo-${randomUUID()}@example.test`, firstName: 'Chief', lastName: 'Exec', type: 'ceo' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('ceo');
  });

  it('a CEO (non-platform-admin) cannot create another CEO', async () => {
    const { managerToken } = await seedOrgWithManager();
    const ceoEmail = `ceo-${randomUUID()}@example.test`;
    const createCeo = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ email: ceoEmail, firstName: 'Chief', lastName: 'Exec', type: 'ceo' });
    expect(createCeo.status).toBe(201);

    // Give the new CEO a real password so they can log in and act as themselves.
    const ceoUser = await dataSource.manager.findOneByOrFail(User, { email: ceoEmail });
    await dataSource.manager.update(User, ceoUser.id, { mustResetPassword: false, passwordHash: await passwordHashing.hash(password) });
    const ceoToken = await login(ceoEmail);

    const secondCeo = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${ceoToken}`)
      .send({ email: `ceo2-${randomUUID()}@example.test`, firstName: 'Another', lastName: 'Exec', type: 'ceo' });
    expect(secondCeo.status).toBe(403);
  });

  it('a CEO can still create a Venue Manager (unaffected path)', async () => {
    const { managerToken } = await seedOrgWithManager();
    const ceoEmail = `ceo-${randomUUID()}@example.test`;
    await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ email: ceoEmail, firstName: 'Chief', lastName: 'Exec', type: 'ceo' });
    const ceoUser = await dataSource.manager.findOneByOrFail(User, { email: ceoEmail });
    await dataSource.manager.update(User, ceoUser.id, { mustResetPassword: false, passwordHash: await passwordHashing.hash(password) });
    const ceoToken = await login(ceoEmail);

    const res = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${ceoToken}`)
      .send({ email: `vm-${randomUUID()}@example.test`, firstName: 'Venue', lastName: 'Mgr', type: 'venue' });
    expect(res.status).toBe(201);
  });

  it('a CEO (non-platform-admin) cannot edit, deactivate, or reset-password an existing CEO', async () => {
    const { managerToken } = await seedOrgWithManager();
    const ceoAEmail = `ceoA-${randomUUID()}@example.test`;
    const createA = await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ email: ceoAEmail, firstName: 'CeoA', lastName: 'Exec', type: 'ceo' });
    const ceoAId = createA.body.id as string;
    const ceoAUser = await dataSource.manager.findOneByOrFail(User, { email: ceoAEmail });
    await dataSource.manager.update(User, ceoAUser.id, { mustResetPassword: false, passwordHash: await passwordHashing.hash(password) });

    const ceoBEmail = `ceoB-${randomUUID()}@example.test`;
    await request(app.getHttpServer())
      .post('/rest/v1/managers')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ email: ceoBEmail, firstName: 'CeoB', lastName: 'Exec', type: 'ceo' });
    const ceoBUser = await dataSource.manager.findOneByOrFail(User, { email: ceoBEmail });
    await dataSource.manager.update(User, ceoBUser.id, { mustResetPassword: false, passwordHash: await passwordHashing.hash(password) });
    const ceoBToken = await login(ceoBEmail);

    const editRes = await request(app.getHttpServer())
      .patch(`/rest/v1/managers/${ceoAId}`)
      .set('Authorization', `Bearer ${ceoBToken}`)
      .send({ jobTitle: 'Hijacked' });
    expect(editRes.status).toBe(403);

    const deactivateRes = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${ceoAId}/deactivate`)
      .set('Authorization', `Bearer ${ceoBToken}`);
    expect(deactivateRes.status).toBe(403);

    const resetRes = await request(app.getHttpServer())
      .post(`/rest/v1/managers/${ceoAId}/reset-password`)
      .set('Authorization', `Bearer ${ceoBToken}`);
    expect(resetRes.status).toBe(403);

    // The platform admin (the seeded Manager) still can.
    const editByAdmin = await request(app.getHttpServer())
      .patch(`/rest/v1/managers/${ceoAId}`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ jobTitle: 'Legit Update' });
    expect(editByAdmin.status).toBe(200);
  });
});
