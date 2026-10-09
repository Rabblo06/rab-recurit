// AUTH_CONTEXT_CACHE_ENABLED must be set before Nest's ConfigModule reads process.env at module
// compile time — this import-time assignment runs before any other module in this file resolves.
process.env.AUTH_CONTEXT_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthContextCacheService } from '../../engine/core-modules/auth/services/auth-context-cache.service';
import { AuthSecuritySnapshotService } from '../../engine/core-modules/auth/services/auth-security-snapshot.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { RefreshTokenService } from '../../engine/core-modules/auth/token/services/refresh-token.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { Role, RolePermission, Permission } from '../../modules/identity/entities';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { generateFixturePassword } from './helpers/fixture-password';

const FIXTURE_PASSWORD = generateFixturePassword();

/**
 * P1E — the Redis AuthContext cache, exercised with `AUTH_CONTEXT_CACHE_ENABLED=true`. A
 * SEPARATE file from every other auth suite deliberately — the flag is read once at Nest module
 * compile time, so it cannot be toggled per-test within a single `AppModule` instance.
 *
 * Proves the version-in-the-key design (see `AuthContextCacheService`'s own doc comment) actually
 * closes the owner's named races, not just that the code compiles: a stale entry is never read
 * after the version that would select it has moved on, and a Redis outage never fails a request.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('P1E AuthContext cache (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let factory: TestIdentityFactory;
  let snapshotService: AuthSecuritySnapshotService;
  let cacheService: AuthContextCacheService;
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
    cacheService = moduleRef.get(AuthContextCacheService);
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

  /** A real session row + a sid this suite controls directly, bypassing login/HTTP entirely — build() only needs a resolvable sid/sub/org triple. */
  async function seedSession(identity: TestIdentity): Promise<string> {
    const sid = randomUUID();
    await tenantContext.runInTenantContext(
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
    return sid;
  }

  it('sanity: the flag is actually on for this suite', () => {
    expect(cacheService.isEnabled()).toBe(true);
  });

  describe('cold miss then warm hit', () => {
    it('the first build() misses and populates Redis; the second, identical build() reads the same cached payload', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const identity = managers[0]!;
      const sid = await seedSession(identity);

      const first = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(first).not.toBeNull();

      // Prove a key now actually exists in Redis — not just that build() returned a plausible value.
      const keys = await redisProvider.client.keys(`crewflow:*:authctx:${identity.organisationId}:*`);
      expect(keys.length).toBeGreaterThan(0);

      const second = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(second!.roles).toEqual(first!.roles);
      expect([...second!.effectivePermissions]).toEqual([...first!.effectivePermissions]);
      expect(second!.isPlatformAdmin).toBe(first!.isPlatformAdmin);
    });
  });

  describe('Race A/B analogue — a permission change invalidates the NEXT read without touching the stale entry', () => {
    it('removing a permission from a held role is reflected on the very next build(), and the pre-change cache entry is left behind unread, not deleted', async () => {
      const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: ['staff.view', 'staff.create'] });
      const identity = managers[0]!;
      const sid = await seedSession(identity);

      const before = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect([...before!.effectivePermissions]).toContain('staff.create');

      const staleKeys = await redisProvider.client.keys(`crewflow:*:authctx:${organisation.id}:*`);
      expect(staleKeys.length).toBe(1);
      const staleKey = staleKeys[0]!;

      // Remove staff.create from the role directly against core.role_permission + bump
      // role.permission_version — the exact write RoleService.setPermissions performs.
      const roleRow = await adminDataSource.query<Array<{ id: string }>>(`SELECT id FROM core.role WHERE key = $1 AND organisation_id = $2`, [
        identity.roleKey,
        organisation.id,
      ]);
      const roleId = roleRow[0]!.id;
      const permRow = await adminDataSource.query<Array<{ id: string }>>(`SELECT id FROM core.permission WHERE key = 'staff.create'`);
      await adminDataSource.query(`DELETE FROM core.role_permission WHERE role_id = $1 AND permission_id = $2`, [roleId, permRow[0]!.id]);
      await adminDataSource.query(`UPDATE core.role SET permission_version = permission_version + 1 WHERE id = $1`, [roleId]);

      const after = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect([...after!.effectivePermissions]).not.toContain('staff.create');
      expect([...after!.effectivePermissions]).toContain('staff.view');

      // The pre-change entry is still sitting in Redis under its OLD (now unreachable) key — proving
      // correctness here never depended on an explicit delete that might not have run.
      const stillThere = await redisProvider.client.get(staleKey);
      expect(stillThere).not.toBeNull();
      expect(JSON.parse(stillThere!).effectivePermissions).toContain('staff.create');

      // And the NEW key (post-bump) is a genuinely different key from the stale one.
      const newKeys = await redisProvider.client.keys(`crewflow:*:authctx:${organisation.id}:*`);
      expect(newKeys).toContain(staleKey);
      expect(newKeys.length).toBe(2);
      void RolePermission;
      void Role;
      void Permission;
    });
  });

  describe('Race E analogue — a reintroduced stale key is never read once the version has moved on', () => {
    it('writing fabricated elevated data under an OLD version-keyed entry after a real revoke does not leak it', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const identity = managers[0]!;
      const sid = await seedSession(identity);

      const before = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(before!.isPlatformAdmin).toBe(false);
      const preBumpKeys = await redisProvider.client.keys(`crewflow:*:authctx:${identity.organisationId}:*`);
      const preBumpKey = preBumpKeys[0]!;

      // Bump the user's own version directly (the real effect of e.g. a password change), simulating
      // the version having moved on since preBumpKey was cached.
      await adminDataSource.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [identity.userId]);

      // An attacker (or a restored backup, or a bug) reintroduces fabricated, elevated data under the
      // STALE pre-bump key.
      await redisProvider.client.set(
        preBumpKey,
        JSON.stringify({
          accountStatus: 'active',
          mustResetPassword: false,
          roles: [identity.roleKey],
          isPlatformAdmin: true,
          maintenanceModeEnabled: false,
          effectivePermissions: ['platform.admin.impersonate'],
        }),
        'EX',
        900,
      );

      const after = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
      expect(after!.isPlatformAdmin).toBe(false);
      expect([...after!.effectivePermissions]).not.toContain('platform.admin.impersonate');
    });
  });

  describe('Race C — Redis outage never fails the request', () => {
    it('a build() against an unreachable cache client still returns the correct, live result, falling through to Postgres', async () => {
      const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production' });
      const identity = managers[0]!;
      const sid = await seedSession(identity);

      // A second Redis client pointed at a port nothing listens on, standing in for an outage,
      // swapped into the SAME AuthContextCacheService instance the running snapshotService uses.
      const unreachable = { client: new (await import('ioredis')).default('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 150 }) };
      const realClient = (redisProvider as unknown as { client: unknown }).client;
      (redisProvider as unknown as { client: unknown }).client = unreachable.client;
      try {
        const started = Date.now();
        const result = await snapshotService.build({ sid, sub: identity.userId, org: identity.organisationId });
        const elapsedMs = Date.now() - started;
        expect(result).not.toBeNull();
        expect(result!.userId).toBe(identity.userId);
        // Bounded, not hung — well under a request timeout even with the client's own connect/command timeouts added up.
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        (redisProvider as unknown as { client: unknown }).client = realClient;
        // .disconnect() (not .quit()) — against an unreachable host there is nothing to gracefully
        // negotiate a QUIT with; .disconnect() just drops the local socket/retry timer immediately,
        // which is also what stops this client's reconnect loop from becoming a dangling open
        // handle that keeps the whole Jest process alive after this test finishes.
        unreachable.client.disconnect();
      }
    });
  });
});
