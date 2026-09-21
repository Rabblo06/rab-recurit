import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserStatus } from '@rab/shared';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Organisation, Role, User, UserRole } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TEST_PASSWORD, TestIdentityFactory, TestSetupError } from './helpers/test-identities';

/**
 * Proves the shared identity factory models PRODUCTION identities, and — as
 * the root-cause regression for the historical "18 suites 403 at login"
 * failure — that the production application-access gate was NOT loosened:
 * canonical identities are admitted to exactly the applications the role
 * model allows, and a synthetic role key (`owner-<uuid>`, `manager-<uuid>`,
 * `everything`) is still denied with APPLICATION_ACCESS_DENIED.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('shared test identity factory + application access (integration)', () => {
  let app: INestApplication;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  const TARGETS = ['manager_web', 'venue_manager_app', 'staff_app'] as const;

  async function applicationMatrix(identity: Parameters<TestIdentityFactory['loginRaw']>[0]) {
    const out: Record<string, number> = {};
    for (const applicationTarget of TARGETS) out[applicationTarget] = (await factory.loginRaw(identity, { applicationTarget })).status;
    return out;
  }

  describe('canonical identities are admitted to exactly the applications the role model allows', () => {
    it('Staff -> staff app only', async () => {
      const org = await factory.createOrganisation();
      const owner = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner });
      expect(await applicationMatrix(staff)).toEqual({ manager_web: 403, venue_manager_app: 403, staff_app: 200 });
      // ...and the real mobile login (platform header, no explicit target) works.
      await expect(factory.login(staff)).resolves.toEqual(expect.any(String));
    });

    it('Venue Manager -> venue app only', async () => {
      const org = await factory.createOrganisation();
      const owner = await factory.createInternalManager(org);
      const vm = await factory.createVenueManager(org, { owner });
      expect(await applicationMatrix(vm)).toEqual({ manager_web: 403, venue_manager_app: 200, staff_app: 403 });
      await expect(factory.login(vm)).resolves.toEqual(expect.any(String));
    });

    it('Internal Manager -> every application (intentional multi-app access)', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org);
      expect(await applicationMatrix(manager)).toEqual({ manager_web: 200, venue_manager_app: 200, staff_app: 200 });
      await expect(factory.login(manager)).resolves.toEqual(expect.any(String));
    });

    it('CEO -> every application', async () => {
      const org = await factory.createOrganisation();
      const ceo = await factory.createCeo(org);
      expect(await applicationMatrix(ceo)).toEqual({ manager_web: 200, venue_manager_app: 200, staff_app: 200 });
    });
  });

  describe('ROOT-CAUSE REGRESSION: the production gate was not loosened', () => {
    /** Reproduces exactly what the 16 broken suites did: a user whose ONLY role has a synthetic key. */
    async function syntheticRoleUser(org: Organisation, roleKey: string) {
      const email = `synthetic-${randomUUID()}@example.test`;
      const hash = await new PasswordHashingService().hash(TEST_PASSWORD);
      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: null, userId: randomUUID(), role: '' }, async (m) => {
        const role = await m.save(Role, { organisationId: org.id, key: roleKey, name: roleKey, isSystem: true });
        const user = await m.save(User, { organisationId: org.id, email, passwordHash: hash, firstName: 'S', lastName: 'U', status: UserStatus.ACTIVE });
        await m.insert(UserRole, { userId: user.id, roleId: role.id, organisationId: org.id });
      });
      return { kind: 'internal_manager' as const, email, password: TEST_PASSWORD };
    }

    it.each([`manager-${randomUUID()}`, `owner-${randomUUID()}`, 'everything', 'Manager', 'MANAGER', 'manager '])(
      'a user whose only role key is %j is DENIED the manager console with APPLICATION_ACCESS_DENIED (no wildcard/prefix matching)',
      async (roleKey) => {
        const org = await factory.createOrganisation();
        const res = await factory.loginRaw(await syntheticRoleUser(org, roleKey));
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPLICATION_ACCESS_DENIED');
        expect(res.body.accessToken).toBeUndefined();
      },
    );

    it('the same person as a canonical Internal Manager is admitted — the identity was the problem, not the gate', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org, { permissions: 'all' });
      expect((await factory.loginRaw(manager)).status).toBe(200);
    });

    it('login failures inside the factory surface as TestSetupError, never as a silent/looking-like-an-assertion failure', async () => {
      const org = await factory.createOrganisation();
      const owner = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner });
      await expect(factory.login(staff, { applicationTarget: 'manager_web' })).rejects.toBeInstanceOf(TestSetupError);
      await expect(factory.login(staff, { applicationTarget: 'manager_web' })).rejects.toThrow(/TEST SETUP FAILED.*APPLICATION_ACCESS_DENIED/);
    });
  });

  describe('identities work end to end against protected endpoints', () => {
    it('Internal Manager and Staff tokens reach their own endpoints and are refused the other role’s', async () => {
      const org = await factory.createOrganisation();
      const manager = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner: manager });
      const managerToken = await factory.login(manager);
      const staffToken = await factory.login(staff);

      const venues = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${managerToken}`);
      expect(venues.status).toBe(200);
      const active = await request(app.getHttpServer()).get('/rest/v1/attendance/me/active').set('Authorization', `Bearer ${staffToken}`);
      expect(active.status).toBe(200);
      expect(active.body.attendance).toBeNull();

      const staffOnVenues = await request(app.getHttpServer()).get('/rest/v1/venues').set('Authorization', `Bearer ${staffToken}`);
      expect(staffOnVenues.status).toBe(403);
      const managerOnClock = await request(app.getHttpServer()).get('/rest/v1/attendance/me/active').set('Authorization', `Bearer ${managerToken}`);
      expect(managerOnClock.status).toBe(403);
    });

    it('a Venue Manager token resolves the owner’s workspace and is refused Internal-Manager-only permissions', async () => {
      const org = await factory.createOrganisation();
      const owner = await factory.createInternalManager(org);
      const vm = await factory.createVenueManager(org, { owner });
      const token = await factory.login(vm);
      const create = await request(app.getHttpServer()).post('/rest/v1/venues').set('Authorization', `Bearer ${token}`).send({ name: 'x', type: 'hotel' });
      expect(create.status).toBe(403);
    });
  });

  describe('factory guard rails', () => {
    it('two identities sharing a canonical role in one organisation must share its permissions — a mismatch is a loud setup error', async () => {
      const org = await factory.createOrganisation();
      await factory.createInternalManager(org, { permissions: ['venue.view'] });
      await expect(factory.createInternalManager(org, { permissions: ['venue.view', 'venue.edit'] })).rejects.toBeInstanceOf(TestSetupError);
    });

    it('a second identity of the same kind with the same permissions reuses the org role', async () => {
      const org = await factory.createOrganisation();
      const a = await factory.createInternalManager(org);
      const b = await factory.createInternalManager(org);
      expect(a.userId).not.toBe(b.userId);
      expect(a.workspaceId).not.toBe(b.workspaceId);
    });
  });
});
