import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { integrationTestDatabaseReady } from '../../database/typeorm/core/integration-test-database-gate';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { applyGlobalValidationPipe } from '../../engine/utils/global-validation-pipe';
import { createAdminDataSource } from './helpers/admin-datasource';
import { samplePool } from './helpers/pool-probe';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Load-test §4.3 (HIGH, availability), against real Postgres with a deliberately SMALL runtime pool.
 *
 * Before the fix, `RefreshTokenService.rotate()` held its transaction's connection (and the refresh token's FOR UPDATE row
 * lock) while asking `PlatformAdminService.isPlatformAdmin()`, which opened a second transaction on a second pool
 * connection. One refresh token presented a few times at once was enough: the first request held the lock and waited for a
 * second connection, the other requests held the remaining connections while waiting for that lock, and nothing moved until
 * the pool's connection timeout (10 s) failed them with 500 — for every request on the instance, every tenant.
 *
 * After the fix every lookup inside the rotation runs on its own transaction's connection. The same burst must therefore
 * finish well inside the connection timeout with no 5xx: exactly one presentation rotates (200), every other one is the
 * already-existing reuse detection (401, family revoked), and the API keeps serving afterwards.
 */
const RUN = integrationTestDatabaseReady();
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(90_000);

const POOL_MAX = 3;
const CONCURRENT = POOL_MAX * 3;
/** pg-pool's connection timeout (PG_CONNECT_TIMEOUT_MS) is 10 s; a deadlocked burst cannot finish before it. */
const WELL_INSIDE_CONNECT_TIMEOUT_MS = 8_000;

describeIfDb(
  'POST /auth/refresh never deadlocks the connection pool (load-test §4.3)',
  () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let adminDataSource: DataSource;
    let factory: TestIdentityFactory;
    let staff: TestIdentity;
    let otherStaff: TestIdentity;
    const previousPoolMax = process.env.PG_POOL_MAX_CONNECTIONS;

    const refreshWith = (token: string) =>
      request(app.getHttpServer())
        .post('/rest/v1/auth/refresh')
        .set('x-client-platform', 'mobile')
        .send({ refreshToken: token });

    beforeAll(async () => {
      // Read lazily by core.datasource.ts when the runtime DataSource is built, so it must be set before AppModule compiles.
      process.env.PG_POOL_MAX_CONNECTIONS = String(POOL_MAX);
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = applyGlobalValidationPipe(moduleRef.createNestApplication());
      await app.init();
      dataSource = moduleRef.get(DataSource);
      adminDataSource = createAdminDataSource();
      await adminDataSource.initialize();
      factory = new TestIdentityFactory({
        app,
        dataSource,
        adminDataSource,
        tenantContext: moduleRef.get(TenantContextService),
        passwordHashing: moduleRef.get(PasswordHashingService),
      });
      const org = await factory.createOrganisation('refresh-pool');
      const owner = await factory.createInternalManager(org);
      staff = await factory.createStaff(org, { owner });
      otherStaff = await factory.createStaff(org, { owner });
    });

    afterAll(async () => {
      await app?.close();
      await adminDataSource?.destroy();
      if (previousPoolMax === undefined)
        delete process.env.PG_POOL_MAX_CONNECTIONS;
      else process.env.PG_POOL_MAX_CONNECTIONS = previousPoolMax;
    });

    it('runs on the small pool this test asked for (otherwise the burst below proves nothing)', () => {
      const options = (
        dataSource.driver as unknown as {
          master?: { options?: { max?: number } };
        }
      ).master?.options;
      expect(options?.max).toBe(POOL_MAX);
    });

    it(`one refresh token presented ${CONCURRENT} times at once on a ${POOL_MAX}-connection pool: no 5xx, one rotation, the rest reuse-detected, inside the connection timeout`, async () => {
      const { refreshToken } = await factory.loginTokens(staff);

      const started = Date.now();
      const responses = await Promise.all(
        Array.from({ length: CONCURRENT }, () => refreshWith(refreshToken)),
      );
      const elapsed = Date.now() - started;

      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 401)).toHaveLength(CONCURRENT - 1);
      for (const r of responses.filter((x) => x.status === 401))
        expect(r.body.message).toMatch(/reuse/i);
      expect(elapsed).toBeLessThan(WELL_INSIDE_CONNECT_TIMEOUT_MS);
    });

    it('the API keeps serving right after the burst: an unrelated session refreshes normally and the pool has drained', async () => {
      const { refreshToken } = await factory.loginTokens(otherStaff);
      const res = await refreshWith(refreshToken);
      expect(res.status).toBe(200);
      const pool = samplePool(dataSource);
      expect(pool?.waitingCount ?? 0).toBe(0);
    });
  },
);
