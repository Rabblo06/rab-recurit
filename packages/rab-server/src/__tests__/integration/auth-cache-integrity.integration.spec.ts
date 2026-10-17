import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * F-06 (SECURITY_FINDINGS.md): "Redis is inside the authentication trust boundary". Both auth caches ON, real Redis (an isolated
 * DB index), real PostgreSQL. An attacker who can WRITE Redis but holds neither a victim's cookie nor APP_SECRET must gain nothing:
 *  - cache 1 (usersession): a forged entry mapping an attacker-chosen cookie to a victim's live session id → 401, because the
 *    authoritative session check now binds the presented cookie hash to the session row;
 *  - cache 2 (authctx): a forged snapshot under the current version key claiming platform admin → ignored (HMAC fails), the
 *    snapshot is rebuilt from PostgreSQL, and no privilege is granted.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';

describeIfDb('auth cache integrity with Redis caches enabled (F-06)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let redis: Redis;
  let factory: TestIdentityFactory;
  let victim: TestIdentity;
  let victimSession: string;

  const http = () => request(app.getHttpServer());
  const cookie = (session: string) => ({ Cookie: `crewflow_session=${session}`, Origin: ORIGIN });
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

  beforeAll(async () => {
    process.env.USER_SESSION_CACHE_ENABLED = 'true';
    process.env.AUTH_CONTEXT_CACHE_ENABLED = 'true';
    redis = new Redis(process.env.REDIS_URL!);
    const { AppModule } = await import('../../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const { TenantContextService } = await import('../../engine/core-modules/tenant/tenant-context.service');
    const { PasswordHashingService } = await import('../../engine/core-modules/auth/services/password-hashing.service');
    factory = new TestIdentityFactory({
      app,
      dataSource: app.get(DataSource),
      adminDataSource: owner,
      tenantContext: app.get(TenantContextService),
      passwordHashing: app.get(PasswordHashingService),
    });
    victim = await factory.createInternalManager(await factory.createOrganisation('f06'), { permissions: 'production' });
    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: victim.email, password: victim.password, applicationTarget: 'manager_web' });
    expect(login.status).toBe(200);
    victimSession = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('crewflow_session='))!.split(';')[0]!.split('=')[1]!;
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
    await redis?.quit();
  });

  it('the genuine cookie path works and really populates both caches (the protections below are not vacuous)', async () => {
    expect((await http().get('/rest/v1/auth/me').set(cookie(victimSession))).status).toBe(200);
    expect((await http().get('/rest/v1/auth/me').set(cookie(victimSession))).status).toBe(200);
    expect(await redis.exists(`crewflow:test:usersession:${sha256(victimSession)}`)).toBe(1);
    expect((await redis.keys('crewflow:test:authctx:*')).length).toBeGreaterThan(0);
  });

  it('cache 1: a forged entry mapping an attacker-chosen cookie to the victim’s LIVE session is refused (401)', async () => {
    const genuine = JSON.parse((await redis.get(`crewflow:test:usersession:${sha256(victimSession)}`))!);
    const attackerCookie = `crewflow_sess_${randomBytes(32).toString('base64url')}`;
    await redis.set(`crewflow:test:usersession:${sha256(attackerCookie)}`, JSON.stringify(genuine), 'EX', 300);

    const res = await http().get('/rest/v1/auth/me').set(cookie(attackerCookie));
    expect(res.status).toBe(401);
    expect(res.body.id).toBeUndefined();
    // The victim's own session is unaffected (the mismatch denies without touching or bumping their row).
    expect((await http().get('/rest/v1/auth/me').set(cookie(victimSession))).status).toBe(200);
  });

  it('cache 2: a forged snapshot under the CURRENT version key claiming platform admin is ignored — no privilege is granted', async () => {
    expect((await http().get('/rest/v1/admin/organisations').set(cookie(victimSession))).status).toBe(403);
    const keys = await redis.keys('crewflow:test:authctx:*');
    expect(keys.length).toBeGreaterThan(0);
    const forged = {
      accountStatus: 'active', mustResetPassword: false, roles: ['manager'], isPlatformAdmin: true,
      maintenanceModeEnabled: false, organisationSuspended: false, effectivePermissions: ['manager.manage', 'role.manage'],
    };
    // `/auth/me` reports the SNAPSHOT's own isPlatformAdmin (PlatformAdminGuard re-checks PostgreSQL separately), so it shows
    // directly whether a forged snapshot was trusted. Both the legacy plain format and an envelope with a made-up MAC are tried.
    for (const forge of [(k: string) => JSON.stringify(forged), (k: string) => JSON.stringify({ d: JSON.stringify(forged), m: k.length ? 'ab'.repeat(32) : '' })]) {
      for (const key of await redis.keys('crewflow:test:authctx:*')) await redis.set(key, forge(key), 'EX', 300);
      const me = await http().get('/rest/v1/auth/me').set(cookie(victimSession));
      expect(me.status).toBe(200);
      expect(me.body.isPlatformAdmin).toBe(false);
      expect((await http().get('/rest/v1/admin/organisations').set(cookie(victimSession))).status).toBe(403);
    }
  });

  it('after logout the session cannot be revived through any cache entry', async () => {
    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: victim.email, password: victim.password, applicationTarget: 'manager_web' });
    const session = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('crewflow_session='))!.split(';')[0]!.split('=')[1]!;
    expect((await http().get('/rest/v1/auth/me').set(cookie(session))).status).toBe(200);
    const cached = await redis.get(`crewflow:test:usersession:${sha256(session)}`);
    expect((await http().post('/rest/v1/auth/logout').set(cookie(session)).send({})).status).toBeLessThan(300);
    if (cached) await redis.set(`crewflow:test:usersession:${sha256(session)}`, cached, 'EX', 300); // re-plant the old entry
    expect((await http().get('/rest/v1/auth/me').set(cookie(session))).status).toBe(401);
  });
});
