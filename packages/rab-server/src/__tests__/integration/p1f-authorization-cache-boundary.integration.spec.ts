// AUTH_CONTEXT_CACHE_ENABLED must be set before Nest's ConfigModule reads process.env at module
// compile time — same constraint as the P1E suite, hence its own separate file/AppModule instance.
process.env.AUTH_CONTEXT_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthSecuritySnapshotService } from '../../engine/core-modules/auth/services/auth-security-snapshot.service';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { ManagerService } from '../../modules/manager/services/manager.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * P1F — this checkpoint's own scope turned out to be mostly already satisfied by P1E: effective
 * permissions and platform-admin status are FIELDS on the one `AuthSecuritySnapshot` the P1E
 * cache already stores, version-keyed by the exact same six-domain vector — building SEPARATE
 * permission/platform-admin caches would have been the "separate caching framework for every
 * domain" the owner's own brief explicitly says not to build (§5, "use the same Redis provider,
 * same versioning approach... do not create separate caching frameworks for every domain"). See
 * `docs/P1-MASTER-EXECUTION-STATUS.md`'s P1F entry for the full reasoning, including why a
 * separate workspace-metadata cache was investigated and NOT added (no measured hot path).
 *
 * What genuinely needed its OWN proof, beyond P1D/P1E's own tests: the owner's §5.6 invalidation
 * matrix for logout and suspension specifically exercised THROUGH the cache (not just the version
 * bump in isolation), and explicit cross-user namespacing. That is this file's whole job.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('P1F authorization cache boundary (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let snapshotService: AuthSecuritySnapshotService;
  let authService: AuthService;
  let managerService: ManagerService;
  let redisProvider: AuthCacheRedisClientProvider;
  let tenantContext: TenantContextService;
  let refreshTokenService: RefreshTokenService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    snapshotService = moduleRef.get(AuthSecuritySnapshotService);
    authService = moduleRef.get(AuthService);
    managerService = moduleRef.get(ManagerService);
    redisProvider = moduleRef.get(AuthCacheRedisClientProvider);
    refreshTokenService = moduleRef.get(RefreshTokenService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource,
      adminDataSource,
      tenantContext,
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  async function seedSessionWithToken(identity: TestIdentity): Promise<{ sid: string; rawToken: string }> {
    const sid = randomUUID();
    const issued = await tenantContext.runInTenantContext(
      { organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' },
      (m) =>
        refreshTokenService.issue(m, {
          userId: identity.userId,
          organisationId: identity.organisationId,
          applicationTarget: 'manager_web',
          familyId: sid,
          roles: [identity.roleKey],
          authProvider: 'password',
        }),
    );
    return { sid, rawToken: issued.token };
  }

  describe('§5.6 invalidation matrix — logout', () => {
    it('a cached, then logged-out session can never produce a cache hit again — build() fails closed, not stale-valid', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const identity = managers[0]!;
      const { sid, rawToken } = await seedSessionWithToken(identity);

      const before = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(before).not.toBeNull();
      const cachedKeys = await redisProvider.client.keys(`crewflow:*:authctx:${identity.organisationId}:*`);
      expect(cachedKeys.length).toBeGreaterThan(0);

      await authService.logout({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, rawToken);

      // The session is now revoked. `resolve_membership_for_session` no longer resolves it at
      // all (the same fail-closed "unknown session -> null" path JwtAuthGuard already treats as
      // a 401 for every revoked/foreign sid, documented on `build()` itself) — the cache is never
      // even reached for this sid again, let alone read stale, regardless of whether the entry
      // cached above is ever explicitly deleted.
      const result = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(result).toBeNull();
    });
  });

  describe('§5.6 invalidation matrix — account suspension', () => {
    it('suspending a Manager through the real service invalidates their cached AuthContext end-to-end', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const identity = managers[0]!;
      const { sid } = await seedSessionWithToken(identity);

      const before = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(before!.accountStatus).toBe('active');

      const ctx = { organisationId: organisation.id, workspaceId: null, userId: identity.userId, role: '' };
      // Lane D (M10-2): deactivation needs a recent step-up of the caller's REAL session (a fresh sign-in provides it).
      await managerService.setActive({ ...ctx, sessionId: (await factory.signedInContext(identity)).sessionId }, identity.profileId!, false);

      // ManagerService.setActive(false) revokes every session for this user as part of suspension
      // — the same real-service call path a Manager Settings "Deactivate" button triggers, not a
      // raw SQL shortcut. The cached pre-suspension snapshot is never read again — the revoked
      // session fails the same "unknown session" resolution the logout test above proves.
      const result = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(result).toBeNull();
    });
  });

  describe('cross-user namespacing', () => {
    it('two different users in the SAME organisation and workspace get two distinct, non-colliding cache entries, each reflecting only their own data', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true });
      const owner = managers[0]!;
      const staff = await factory.createStaff(organisation, { owner, label: 'p1f-staff' });

      const ownerSession = await seedSessionWithToken(owner);
      const staffSession = await seedSessionWithToken(staff);

      const ownerSnapshot = await snapshotService.build({ sid: ownerSession.sid, sub: owner.userId, org: organisation.id });
      const staffSnapshot = await snapshotService.build({ sid: staffSession.sid, sub: staff.userId, org: organisation.id });

      expect(ownerSnapshot!.userId).toBe(owner.userId);
      expect(staffSnapshot!.userId).toBe(staff.userId);
      expect(ownerSnapshot!.roles).not.toEqual(staffSnapshot!.roles);

      const allKeysForOrg = await redisProvider.client.keys(`crewflow:*:authctx:${organisation.id}:*`);
      expect(allKeysForOrg.length).toBeGreaterThanOrEqual(2);
      // Fetching each entry back directly must return exactly the data for that user, never the other's.
      const values = await Promise.all(allKeysForOrg.map((k) => redisProvider.client.get(k)));
      // Values are an integrity envelope { d: <snapshot JSON>, m: <HMAC> } since the F-06 fix; the snapshot itself is unchanged.
      const parsed = values.filter(Boolean).map((v) => JSON.parse((JSON.parse(v!) as { d: string }).d));
      const ownerEntry = parsed.find((p) => p.roles.includes(owner.roleKey));
      const staffEntry = parsed.find((p) => p.roles.includes(staff.roleKey));
      expect(ownerEntry).toBeDefined();
      expect(staffEntry).toBeDefined();
      expect(ownerEntry).not.toEqual(staffEntry);
    });
  });
});
