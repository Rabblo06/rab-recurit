// SC-03 runs with the auth-context cache ON, set before any NestJS module compiles (code default off; every other suite
// keeps it off). Same convention as p1e-auth-context-cache.integration.spec.ts.
process.env.AUTH_CONTEXT_CACHE_ENABLED = 'true';

import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PermissionFlag } from '@rab/shared';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthContextCacheService } from '../../engine/core-modules/auth/services/auth-context-cache.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { SecurityVersionService } from '../../engine/core-modules/auth/services/security-version.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';

/**
 * SC-03 (Phase X Stage 0, S0-C-caches.md): with AUTH_CONTEXT_CACHE_ENABLED on, the cached request snapshot (effective
 * permissions included) is keyed by the PostgreSQL version vector. `core.user_permission_override` had no term in that
 * vector, so a revoke by override kept the cached grant for up to 900 s. `readVector` now carries a content fingerprint
 * of the user's override rows (count + md5 of (permission_id, effect)), read in the same statement, so the very next
 * request computes a NEW key and rebuilds from PostgreSQL. Proven here against real PostgreSQL (FORCE RLS), real Redis
 * and real HTTP: with the cache warm, and with the cache's Redis unreachable.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('SC-03 a permission override takes effect on the next request with the auth-context cache ON', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let tenantContext: TenantContextService;
  let securityVersion: SecurityVersionService;
  let cache: AuthContextCacheService;
  let redisProvider: AuthCacheRedisClientProvider;
  let organisationId: string;

  const http = () => request(app.getHttpServer());
  const listStaff = (token: string) => http().get('/rest/v1/staff').set({ Authorization: `Bearer ${token}` });
  const setOverride = (userId: string, key: string, effect: 'grant' | 'revoke') =>
    owner.query(
      `INSERT INTO core.user_permission_override (user_id, permission_id, organisation_id, effect)
       SELECT $1, id, $2, $4 FROM core.permission WHERE key = $3
       ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
      [userId, organisationId, key, effect],
    );
  const clearOverrides = (userId: string) => owner.query(`DELETE FROM core.user_permission_override WHERE user_id = $1`, [userId]);
  const authctxKeys = async () => (await redisProvider.client.keys(`crewflow:*:authctx:${organisationId}:*`)).sort();
  const fingerprintOf = (identity: TestIdentity) =>
    tenantContext.runInTenantContext({ organisationId: identity.organisationId, workspaceId: identity.workspaceId, userId: identity.userId, role: '' }, async (m) =>
      (await securityVersion.readVector(m, { sessionId: '00000000-0000-0000-0000-000000000000', userId: identity.userId, organisationId: identity.organisationId, workspaceId: identity.workspaceId }))
        .permissionOverrideFingerprint,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = applyGlobalValidationPipe(moduleRef.createNestApplication());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    tenantContext = moduleRef.get(TenantContextService);
    securityVersion = moduleRef.get(SecurityVersionService);
    cache = moduleRef.get(AuthContextCacheService);
    redisProvider = moduleRef.get(AuthCacheRedisClientProvider);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'sc03' });
    organisationId = seeded.organisation.id;
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  const newManager = () => factory.createInternalManager({ id: organisationId }, { permissions: 'production', label: 'sc03' });

  it('runs with the auth-context cache ON (sanity check on the env override above)', () => {
    expect(cache.isEnabled()).toBe(true);
  });

  it('the fingerprint changes on every override write form: INSERT, UPDATE of effect, DELETE (and is stable otherwise)', async () => {
    const m = await newManager();
    const none = await fingerprintOf(m);
    expect(none).toBe('0-0');
    expect(await fingerprintOf(m)).toBe(none);

    await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'revoke');
    const inserted = await fingerprintOf(m);
    expect(inserted).toMatch(/^1-[0-9a-f]{32}$/);

    await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'grant'); // UPDATE effect
    const updated = await fingerprintOf(m);
    expect(updated).toMatch(/^1-[0-9a-f]{32}$/);
    expect(updated).not.toBe(inserted);

    await setOverride(m.userId, PermissionFlag.PAYROLL_VIEW, 'revoke'); // a second row
    const two = await fingerprintOf(m);
    expect(two).toMatch(/^2-/);

    await clearOverrides(m.userId); // DELETE
    expect(await fingerprintOf(m)).toBe(none);
  });

  it('a revoke by override is enforced on the very next request although the grant is cached (cache warm)', async () => {
    const m = await newManager();
    const token = await factory.login(m);
    expect((await listStaff(token)).status).toBe(200);
    const warm = await authctxKeys();
    expect((await listStaff(token)).status).toBe(200); // a cache HIT: no new key
    expect(await authctxKeys()).toEqual(warm);

    await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'revoke');
    expect((await listStaff(token)).status).toBe(403); // new vector → new key → rebuilt from PostgreSQL
    expect((await listStaff(token)).status).toBe(403); // and the rebuilt (revoked) entry is what is cached now

    await clearOverrides(m.userId);
    expect((await listStaff(token)).status).toBe(200); // the grant returns on the next request too
  });

  it('a grant by override is honoured on the very next request (no stale deny)', async () => {
    const m = await factory.createInternalManager({ id: organisationId }, { permissions: 'production', label: 'sc03-grant' });
    const token = await factory.login(m);
    await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'revoke');
    expect((await listStaff(token)).status).toBe(403);
    await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'grant');
    expect((await listStaff(token)).status).toBe(200);
    await clearOverrides(m.userId);
  });

  it('with the cache Redis DOWN the revoke is still enforced on the next request (PostgreSQL decides; a miss, never a stale hit)', async () => {
    const m = await newManager();
    const token = await factory.login(m);
    expect((await listStaff(token)).status).toBe(200); // a warm entry exists in the real Redis

    const unreachable = new (await import('ioredis')).default('redis://127.0.0.1:1', { lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 150, enableOfflineQueue: false });
    const realClient = (redisProvider as unknown as { client: unknown }).client;
    (redisProvider as unknown as { client: unknown }).client = unreachable;
    try {
      await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'revoke');
      expect((await listStaff(token)).status).toBe(403);
      await clearOverrides(m.userId);
      expect((await listStaff(token)).status).toBe(200);
      await setOverride(m.userId, PermissionFlag.STAFF_VIEW, 'revoke');
    } finally {
      (redisProvider as unknown as { client: unknown }).client = realClient;
      unreachable.disconnect();
    }
    // Redis back: the old warm (granting) entry is still in Redis under the OLD key; it must stay unreachable.
    expect((await listStaff(token)).status).toBe(403);
    await clearOverrides(m.userId);
  });
});
