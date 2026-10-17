import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Release gate J — member roles with BOTH auth caches ENABLED (USER_SESSION_CACHE_ENABLED, AUTH_CONTEXT_CACHE_ENABLED)
 * against a real Redis, with TWO API instances sharing that Redis and the same PostgreSQL (cross-instance staleness).
 *
 * Contract under test: PostgreSQL stays the authority. A warm cache never preserves access after a role definition
 * change, a Team role change, a suspension or a logout; a Redis flush or disconnect never grants or keeps access;
 * caches are keyed per organisation / session / workspace so another workspace's entries can never be served.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const STRONG = 'Correct-Horse-42-battery';
const ORIGIN = 'http://localhost:5173';

describeIfDb('Member roles with Redis auth caches enabled (two API instances, real Redis)', () => {
  jest.setTimeout(240_000);

  let appA: INestApplication;
  let appB: INestApplication;
  let owner: DataSource;
  let redis: Redis;
  let factory: TestIdentityFactory;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let tokenA: string;
  let tokenB: string;
  let staffLondon: TestIdentity;
  let clientB: Redis;

  const a = () => request(appA.getHttpServer());
  const b = () => request(appB.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const cookie = (session: string) => ({ Cookie: `crewflow_session=${session}`, Origin: ORIGIN });
  const definition = (name: string, objects: unknown[], extra: Record<string, unknown> = {}) => ({ name, assignableToMembers: true, readAllObjects: false, objects, ...extra });

  async function makeApp(): Promise<INestApplication> {
    const { AppModule } = await import('../../app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    return app;
  }

  /** Invite → accept → cookie sign-in on the manager web app (the cached cookie path). */
  async function onboardMember(roleId: string): Promise<{ userId: string; session: string; email: string }> {
    const email = `cache-${randomUUID().slice(0, 8)}@example.test`;
    const sent = await a().post('/rest/v1/member-invitations').set(bearer(tokenA)).send({ emails: [email], roleId });
    expect(sent.status).toBe(200);
    const [inv] = await owner.query(`SELECT id FROM core.member_invitation WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [email]);
    const [mail] = await owner.query(`SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id]);
    const raw = decodeURIComponent(/accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(mail.rendered_html as string)![1]!);
    expect((await a().post('/rest/v1/invitations/accept').send({ token: raw, firstName: 'Cache', lastName: 'Member', newPassword: STRONG })).status).toBe(200);
    const login = await a().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email, password: STRONG, applicationTarget: 'manager_web' });
    expect(login.status).toBe(200);
    const session = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('crewflow_session='))!.split(';')[0]!.split('=')[1]!;
    const [user] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [email]);
    return { userId: user.id, session, email };
  }

  async function role(objects: unknown[], extra: Record<string, unknown> = {}): Promise<{ id: string; name: string }> {
    const name = `Cache role ${randomUUID().slice(0, 6)}`;
    const res = await a().post('/rest/v1/roles').set(bearer(tokenA)).send(definition(name, objects, extra));
    expect(res.status).toBe(201);
    return { id: res.body.id, name };
  }

  const cacheKeys = async (kind: 'authctx' | 'usersession') => redis.keys(`crewflow:*:${kind}:*`);

  beforeAll(async () => {
    process.env.USER_SESSION_CACHE_ENABLED = 'true';
    process.env.AUTH_CONTEXT_CACHE_ENABLED = 'true';
    redis = new Redis(process.env.REDIS_URL!);
    await redis.flushdb();
    appA = await makeApp();
    appB = await makeApp();
    owner = createAdminDataSource();
    await owner.initialize();
    const { TenantContextService } = await import('../../engine/core-modules/tenant/tenant-context.service');
    const { PasswordHashingService } = await import('../../engine/core-modules/auth/services/password-hashing.service');
    const { AuthCacheRedisClientProvider } = await import('../../engine/core-modules/auth/services/auth-cache-redis-client.provider');
    clientB = appB.get(AuthCacheRedisClientProvider).client;
    factory = new TestIdentityFactory({
      app: appA,
      dataSource: appA.get(DataSource),
      adminDataSource: owner,
      tenantContext: appA.get(TenantContextService),
      passwordHashing: appA.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'cache' });
    [managerA, managerB] = seeded.managers as [TestIdentity, TestIdentity];
    tokenA = await factory.login(managerA);
    tokenB = await factory.login(managerB);
    staffLondon = await factory.createStaff(seeded.organisation, { owner: managerA, label: 'cache-staff' });
    await owner.query(`UPDATE core.staff_profile SET city = 'London' WHERE id = $1`, [staffLondon.profileId]);
    await owner.query(`UPDATE core."user" SET phone = '+447700900111' WHERE id = $1`, [staffLondon.userId]);
  });

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await owner?.destroy();
    await redis?.quit();
  });

  it('J1: the caches really are in use — a member request populates BOTH the session and the auth-context cache', async () => {
    const r = await role([{ object: 'staff', read: 'grant' }]);
    const member = await onboardMember(r.id);
    await redis.flushdb();
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(200);
    expect((await cacheKeys('usersession')).length).toBeGreaterThan(0);
    expect((await cacheKeys('authctx')).length).toBeGreaterThan(0);
    // Warm hit on the other instance still answers correctly.
    expect((await a().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(200);
  });

  it('J2: a role definition change on instance A applies on instance B immediately, despite B’s warm cache (fields, records, object)', async () => {
    const r = await role([{ object: 'staff', read: 'grant', fields: { phone: 'visible' } }]);
    const member = await onboardMember(r.id);
    const warm = await b().get(`/rest/v1/staff/${staffLondon.profileId}`).set(cookie(member.session));
    expect(warm.status).toBe(200);
    expect(warm.body.phone).toBe('+447700900111');
    await b().get(`/rest/v1/staff/${staffLondon.profileId}`).set(cookie(member.session)); // warm

    // Field revoked.
    expect((await a().put(`/rest/v1/roles/${r.id}`).set(bearer(tokenA)).send(definition(r.name, [{ object: 'staff', read: 'grant', fields: { phone: 'hidden' } }]))).status).toBe(200);
    expect((await b().get(`/rest/v1/staff/${staffLondon.profileId}`).set(cookie(member.session))).body).not.toHaveProperty('phone');

    // Record filter excludes the record.
    expect(
      (await a().put(`/rest/v1/roles/${r.id}`).set(bearer(tokenA)).send(definition(r.name, [{ object: 'staff', read: 'grant', recordFilter: { op: 'and', conditions: [{ field: 'city', operator: 'eq', value: 'Paris' }] } }]))).status,
    ).toBe(200);
    expect((await b().get(`/rest/v1/staff/${staffLondon.profileId}`).set(cookie(member.session))).status).toBe(404);

    // Object revoked: the route flag itself is gone (snapshot cache invalidated by role.permission_version).
    expect((await a().put(`/rest/v1/roles/${r.id}`).set(bearer(tokenA)).send(definition(r.name, [{ object: 'venue', read: 'grant' }]))).status).toBe(200);
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(403);
    expect((await a().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(403);
  });

  it('J3: a Team role change and a suspension apply on the next request on every instance; nothing cached survives', async () => {
    const staffRole = await role([{ object: 'staff', read: 'grant' }]);
    const venueRole = await role([{ object: 'venue', read: 'grant' }]);
    const member = await onboardMember(staffRole.id);
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(200);
    expect((await a().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(200);

    expect((await a().patch(`/rest/v1/members/${member.userId}/role`).set(bearer(tokenA)).send({ roleId: venueRole.id })).status).toBe(204);
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(403);
    expect((await b().get('/rest/v1/venues').set(cookie(member.session))).status).toBe(200);

    expect((await a().post(`/rest/v1/members/${member.userId}/suspend`).set(bearer(tokenA))).status).toBe(204);
    for (const app of [a, b]) expect([401, 403]).toContain((await app().get('/rest/v1/venues').set(cookie(member.session))).status);
  });

  it('J4: logout kills the cookie on every instance even though its identity is cached; a Redis flush never revives it', async () => {
    const member = await onboardMember((await role([{ object: 'staff', read: 'grant' }])).id);
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(200);
    expect((await a().post('/rest/v1/auth/logout').set(cookie(member.session)).send({})).status).toBe(204);
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(401);
    await redis.flushdb();
    expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(401);
  });

  it('J5: with instance B’s Redis connection DOWN, B still serves from PostgreSQL and still enforces revocations', async () => {
    const r = await role([{ object: 'staff', read: 'grant' }]);
    const member = await onboardMember(r.id);
    clientB.disconnect();
    try {
      expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(200);
      expect((await a().put(`/rest/v1/roles/${r.id}`).set(bearer(tokenA)).send(definition(r.name, [{ object: 'staff', read: 'deny' }, { object: 'venue', read: 'grant' }]))).status).toBe(200);
      expect((await b().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(403);
      expect((await a().post('/rest/v1/auth/logout').set(cookie(member.session)).send({})).status).toBe(204);
      expect((await b().get('/rest/v1/venues').set(cookie(member.session))).status).toBe(401);
    } finally {
      await clientB.connect().catch(() => undefined);
    }
  });

  it('J6: a revocation racing many concurrent reads — every request that starts after the change commits sees the new state', async () => {
    const r = await role([{ object: 'staff', read: 'grant' }]);
    const member = await onboardMember(r.id);
    const readers = Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b)().get('/rest/v1/staff').set(cookie(member.session)));
    const change = a().put(`/rest/v1/roles/${r.id}`).set(bearer(tokenA)).send(definition(r.name, [{ object: 'staff', read: 'deny' }, { object: 'venue', read: 'grant' }]));
    const results = await Promise.all([change, ...readers]);
    expect(results[0]!.status).toBe(200);
    // Any status is acceptable for reads that overlapped the commit; nothing after it may still be allowed.
    for (let i = 0; i < 10; i++) expect((await (i % 2 ? a : b)().get('/rest/v1/staff').set(cookie(member.session))).status).toBe(403);
  });

  it('J7: cache keys are per organisation / session / workspace — another workspace’s manager never gets workspace A’s role or records', async () => {
    const r = await role([{ object: 'staff', read: 'grant' }]);
    await onboardMember(r.id);
    // Warm caches for both managers on both instances.
    for (const app of [a, b]) {
      expect((await app().get(`/rest/v1/roles/${r.id}/definition`).set(bearer(tokenA))).status).toBe(200);
      expect((await app().get('/rest/v1/staff').set(bearer(tokenB))).status).toBe(200);
    }
    for (const app of [a, b]) {
      expect((await app().get(`/rest/v1/roles/${r.id}/definition`).set(bearer(tokenB))).status).toBe(404);
      expect((await app().get(`/rest/v1/staff/${staffLondon.profileId}`).set(bearer(tokenB))).status).toBe(404);
    }
    const keys = await cacheKeys('authctx');
    expect(keys.some((k) => k.includes(managerA.organisationId))).toBe(true);
    // No raw cookie or session token is ever part of a key.
    expect((await redis.keys('*crewflow_sess_*')).length).toBe(0);
  });
});
