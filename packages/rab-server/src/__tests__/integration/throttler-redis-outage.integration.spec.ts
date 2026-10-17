import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, Server, Socket } from 'node:net';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * CF-17 (owner decision 2026-10-15): when the throttler's Redis is unavailable, credential-issuing and credential-recovery
 * routes fail closed with 503 within bounded time (never an unlimited guessing window, never a hang), while ordinary
 * authorised requests keep working (they are authenticated against PostgreSQL on every call). Before: the throttler's
 * client queued commands forever, so EVERY request hung during an outage.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const BOUND_MS = 3_000;

describeIfDb('CF-17 throttler Redis outage policy (integration)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let owner: DataSource;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let managerToken: string;
  let staffToken: string;
  let staffRefresh: string;
  const originalFlag = process.env.RAB_DISABLE_RATE_LIMIT;

  const http = () => request(app.getHttpServer());
  const timed = async (fn: () => Promise<request.Response>) => {
    const t0 = Date.now();
    const res = await fn();
    return { res, ms: Date.now() - t0 };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'cf17' });
    manager = seeded.managers[0]!;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'cf17s' });
    managerToken = await factory.login(manager);
    const tokens = await factory.loginTokens(staff);
    staffToken = tokens.accessToken;
    staffRefresh = tokens.refreshToken;

    // Enforce the real throttler for this file only, then take its Redis away (manual disconnect: no reconnect).
    process.env.RAB_DISABLE_RATE_LIMIT = 'false';
    moduleRef.get(ThrottlerRedisClientProvider).client.disconnect();
  });

  afterAll(async () => {
    process.env.RAB_DISABLE_RATE_LIMIT = originalFlag;
    await owner?.destroy();
    await app?.close();
  });

  it('login, refresh and password recovery fail closed with 503 within bounded time, and set no cookie', async () => {
    const cases: Array<[string, () => Promise<request.Response>]> = [
      ['login', () => http().post('/rest/v1/auth/login').send({ email: manager.email, password: manager.password })],
      ['refresh', () => http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: staffRefresh })],
      ['forgot', () => http().post('/rest/v1/auth/forgot-password').send({ email: manager.email })],
      ['reset', () => http().post('/rest/v1/auth/reset-password').send({ token: 'x'.repeat(64), newPassword: 'Correct-Horse-42-battery' })], // gitleaks:allow (test-only fixture password)
    ];
    for (const [name, call] of cases) {
      const { res, ms } = await timed(call);
      expect({ name, status: res.status, code: res.body?.code }).toEqual({ name, status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
      expect(ms).toBeLessThan(BOUND_MS);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['retry-after']).toBe('5');
    }
  });

  it('a refused refresh does not consume or revoke the mobile refresh token (no session is cleared by the outage)', async () => {
    const [row] = await owner.query(
      `SELECT count(*)::int AS live FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL AND replaced_by IS NULL`,
      [staff.userId],
    );
    expect(row.live).toBeGreaterThanOrEqual(1);
  });

  it('ordinary authorised requests keep working (PostgreSQL-authoritative), within bounded time', async () => {
    for (const [token, path] of [
      [managerToken, '/rest/v1/auth/me'],
      [managerToken, '/rest/v1/staff'],
      [staffToken, '/rest/v1/auth/me'],
      [staffToken, '/rest/v1/attendance/me/active'],
    ] as const) {
      const { res, ms } = await timed(() => http().get(path).set('Authorization', `Bearer ${token}`));
      expect({ path, ok: res.status < 400 }).toEqual({ path, ok: true });
      expect(ms).toBeLessThan(BOUND_MS);
    }
  });

  it('Staff clock-in / clock-out stay available while the rate-limit store is down (no 5xx, bounded time)', async () => {
    // No shift is assigned to this fixture, so the attendance service answers with its own domain refusal (4xx). What
    // matters is that the request is not blocked by the unavailable throttle store (previously a 500, before that a hang).
    for (const path of ['/rest/v1/attendance/clock-in', '/rest/v1/attendance/clock-out']) {
      const { res, ms } = await timed(() => http().post(path).set('Authorization', `Bearer ${staffToken}`).send({}));
      expect({ path, serverError: res.status >= 500 }).toEqual({ path, serverError: false });
      expect(ms).toBeLessThan(BOUND_MS);
    }
  });

  it('a hung Redis (accepts the connection, never answers) is bounded by the client timeout, not waited on forever', async () => {
    const sockets: Socket[] = [];
    const blackHole: Server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const port = (blackHole.address() as { port: number }).port;
    const env = { get: (key: string) => (key === 'REDIS_URL' ? `redis://127.0.0.1:${port}` : undefined) } as unknown as EnvironmentService;
    const provider = new ThrottlerRedisClientProvider(env);
    try {
      const t0 = Date.now();
      await expect(provider.client.incr('cf17:probe')).rejects.toBeTruthy();
      expect(Date.now() - t0).toBeLessThan(BOUND_MS);
    } finally {
      provider.client.disconnect();
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
    }
  });
});
