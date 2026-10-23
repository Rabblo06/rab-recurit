import 'reflect-metadata';

// Wave 4 lane MFA × wave 3 lane H — cross-host login handoff on the REAL functions of lane DB5 (LoginHandoff1786719910000)
// and lane S2 (host-label registry). Host routing + registry-backed origin trust + the handoff are switched on for this
// suite only, with a test base domain.
const ORIGINAL = Object.fromEntries(
  ['WORKSPACE_BASE_DOMAIN', 'CORS_ORIGINS', 'WORKSPACE_HOST_ROUTING_ENABLED', 'WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED', 'AUTH_LOGIN_HANDOFF_ENABLED'].map((k) => [k, process.env[k]]),
);
process.env.WORKSPACE_BASE_DOMAIN = 'rab.test';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.WORKSPACE_HOST_ROUTING_ENABLED = 'true';
process.env.WORKSPACE_SUBDOMAIN_ORIGIN_TRUST_ENABLED = 'true';
process.env.AUTH_LOGIN_HANDOFF_ENABLED = 'true';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const DEFAULT_ORIGIN = 'http://localhost:5173';

describeIfDb('wave 4 lane MFA — cross-host login handoff (integration, real functions)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let a: TestIdentity;
  let b: TestIdentity;
  const labelA = `w4ha-${randomUUID().slice(0, 8)}`;
  const labelB = `w4hb-${randomUUID().slice(0, 8)}`;
  const http = () => request(app.getHttpServer());

  const sessionCookie = (res: request.Response): string | undefined =>
    ([] as string[])
      .concat(res.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('crewflow_session='))
      ?.split(';')[0];
  const rawSetCookie = (res: request.Response, name: string): string | undefined => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));

  async function signInDefault(who: TestIdentity): Promise<string> {
    const res = await http().post('/rest/v1/auth/login').set('Origin', DEFAULT_ORIGIN).send({ email: who.email, password: who.password });
    expect(res.status).toBe(200);
    return sessionCookie(res)!;
  }

  const createHandoff = (cookie: string, extra: Record<string, string> = {}) => {
    const req = http().post('/rest/v1/auth/login-handoff').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie);
    for (const [k, v] of Object.entries(extra)) req.set(k, v);
    return req.send({});
  };

  const exchange = (label: string | null, token: string, opts: { origin?: string | null; cookie?: string } = {}) => {
    const req = http().post('/rest/v1/auth/login-handoff/exchange');
    if (label) req.set('Host', `${label}.rab.test`);
    const origin = opts.origin === undefined ? (label ? `http://${label}.rab.test` : DEFAULT_ORIGIN) : opts.origin;
    if (origin) req.set('Origin', origin);
    if (opts.cookie) req.set('Cookie', opts.cookie);
    return req.send({ token });
  };

  const tokenOf = (redirectUrl: string) => new URL(redirectUrl).hash.replace(/^#t=/, '');

  async function readyWorkspace(who: TestIdentity, label: string): Promise<void> {
    const cookie = await signInDefault(who);
    const created = await http().post('/rest/v1/manager-workspaces').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie).send({ name: `Handoff ${label}`, subdomain: label });
    expect(created.status).toBe(201);
    expect(created.body.schemaStatus).toBe('READY');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.use(cookieParser());
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    const [{ present }] = await owner.query(`SELECT to_regprocedure('core.login_handoff_consume(text,text)') IS NOT NULL AS present`);
    if (!present) throw new Error('core.login_handoff_* functions are missing: apply LoginHandoff1786719910000 before running this suite');
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    a = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, label: 'w4ha' })).managers[0]!;
    b = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, label: 'w4hb' })).managers[0]!;
    await readyWorkspace(a, labelA);
    await readyWorkspace(b, labelB);
  });

  // Tests deliberately leave unconsumed handoffs behind; retire them so the per-user live cap (5) only bites where tested.
  afterEach(async () => {
    await owner.query(`UPDATE core.login_handoff SET consumed_at = now() WHERE consumed_at IS NULL AND user_id = ANY($1::uuid[])`, [[a.userId, b.userId]]);
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('default host → handoff to the VERIFIED canonical host → exchange issues a NEW host-only session; the source session ends', async () => {
    const source = await signInDefault(a);
    const created = await createHandoff(source);
    expect(created.status).toBe(200);
    const url = new URL(created.body.redirectUrl);
    expect(url.origin).toBe(`http://${labelA}.rab.test`);
    expect(url.pathname).toBe('/auth/handoff');
    expect(url.search).toBe(''); // never in the query string (logs, Referer)
    const token = tokenOf(created.body.redirectUrl);
    expect(token).toMatch(/^lho_[A-Za-z0-9_-]{43}$/);
    // Stored hashed only; TTL ≤ 60 s.
    const [row] = await owner.query(`SELECT token_hash, extract(epoch FROM expires_at - created_at) AS ttl FROM core.login_handoff WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.userId]);
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(Number(row.ttl)).toBeLessThanOrEqual(60);
    expect(JSON.stringify(await owner.query(`SELECT metadata FROM core.audit_log WHERE actor_user_id = $1`, [a.userId]))).not.toContain(token);

    const done = await exchange(labelA, token);
    expect(done.status).toBe(200);
    expect(Object.keys(done.body).sort()).toEqual(['mustResetPassword', 'sessionExpiresAt']); // no id, no token, no credential
    const fresh = sessionCookie(done)!;
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(source);
    expect(rawSetCookie(done, 'crewflow_session')).not.toMatch(/Domain=/i); // host-only
    expect(rawSetCookie(done, 'crewflow_session')).toMatch(/HttpOnly/i);
    // The new session works on its own host…
    expect((await http().get('/rest/v1/manager-workspaces/me').set('Host', `${labelA}.rab.test`).set('Cookie', fresh)).status).toBe(200);
    // …and the source session is gone.
    expect((await http().get('/rest/v1/auth/me').set('Cookie', source)).status).toBe(401);
    const exchanged = await owner.query(`SELECT action FROM core.audit_log WHERE actor_user_id = $1 AND action IN ('auth.login_handoff_created', 'auth.login_handoff_exchanged')`, [a.userId]);
    expect(exchanged.map((r: { action: string }) => r.action).sort()).toEqual(['auth.login_handoff_created', 'auth.login_handoff_exchanged']);
  });

  it('ABUSE: replay — a handoff is single use', async () => {
    const token = tokenOf((await createHandoff(await signInDefault(a))).body.redirectUrl);
    expect((await exchange(labelA, token)).status).toBe(200);
    const replay = await exchange(labelA, token);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('LOGIN_HANDOFF_INVALID');
    expect(sessionCookie(replay)).toBeUndefined();
  });

  it('ABUSE: expiry — an expired handoff is refused', async () => {
    const token = tokenOf((await createHandoff(await signInDefault(a))).body.redirectUrl);
    await owner.query(
      `UPDATE core.login_handoff SET created_at = created_at - interval '5 minutes', expires_at = expires_at - interval '5 minutes' WHERE token_hash = $1`,
      [createHash('sha256').update(token).digest('hex')],
    );
    expect((await exchange(labelA, token)).status).toBe(401);
  });

  it('ABUSE: wrong audience / cross-workspace use — A\'s handoff on B\'s host (or the default host, or an unknown host) fails, and is burned', async () => {
    const token = tokenOf((await createHandoff(await signInDefault(a))).body.redirectUrl);
    const onB = await exchange(labelB, token);
    expect(onB.status).toBe(401);
    expect(sessionCookie(onB)).toBeUndefined();
    // Single use even when the audience was wrong: it cannot be retried on the right host afterwards.
    expect((await exchange(labelA, token)).status).toBe(401);

    const token2 = tokenOf((await createHandoff(await signInDefault(a))).body.redirectUrl);
    expect((await exchange(null, token2)).status).toBe(401); // default host
    expect((await exchange(`ghost-${randomUUID().slice(0, 6)}`, token2, { origin: DEFAULT_ORIGIN })).status).toBe(401); // unknown host
    // A body field can never choose the audience.
    const smuggled = await http().post('/rest/v1/auth/login-handoff/exchange').set('Host', `${labelB}.rab.test`).set('Origin', `http://${labelB}.rab.test`).send({ token: token2, host: labelA });
    expect(smuggled.status).toBe(400);
  });

  it('ABUSE: open redirect — the target comes only from the registry/DB, never from Host, X-Forwarded-Host or the body', async () => {
    const cookie = await signInDefault(a);
    const extras: Array<Record<string, string>> = [{ Host: 'evil.example' }, { 'X-Forwarded-Host': 'evil.example' }, { 'X-Forwarded-Host': `${labelB}.rab.test` }];
    for (const extra of extras) {
      const res = await createHandoff(cookie, extra);
      if (res.status === 200 && res.body.redirectUrl) expect(new URL(res.body.redirectUrl).origin).toBe(`http://${labelA}.rab.test`);
      else expect([200, 404]).toContain(res.status);
    }
    const withBody = await http().post('/rest/v1/auth/login-handoff').set('Origin', DEFAULT_ORIGIN).set('Cookie', cookie).send({ redirectUrl: 'https://evil.example/', workspaceId: randomUUID() });
    if (withBody.status === 200) expect(new URL(withBody.body.redirectUrl).origin).toBe(`http://${labelA}.rab.test`);
  });

  it('ABUSE: login CSRF — an untrusted or missing Origin, or a non-JSON body, cannot create or exchange a handoff', async () => {
    const cookie = await signInDefault(a);
    expect((await http().post('/rest/v1/auth/login-handoff').set('Origin', 'http://evil.example').set('Cookie', cookie).send({})).status).toBe(403);
    const token = tokenOf((await createHandoff(cookie)).body.redirectUrl);
    expect((await exchange(labelA, token, { origin: 'http://evil.example' })).status).toBe(403);
    expect((await exchange(labelA, token, { origin: null })).status).toBe(403);
    const form = await http().post('/rest/v1/auth/login-handoff/exchange').set('Host', `${labelA}.rab.test`).set('Origin', `http://${labelA}.rab.test`).type('form').send({ token });
    expect([400, 403, 415]).toContain(form.status);
    // None of those refusals consumed it: the legitimate page still completes.
    expect((await exchange(labelA, token)).status).toBe(200);
  });

  it('ABUSE: session fixation — a session cookie the target host already holds (e.g. planted) is ended; the browser gets a brand-new one', async () => {
    const planted = await signInDefault(b); // an attacker's own session value
    const token = tokenOf((await createHandoff(await signInDefault(a))).body.redirectUrl);
    const done = await exchange(labelA, token, { cookie: planted });
    expect(done.status).toBe(200);
    const fresh = sessionCookie(done)!;
    expect(fresh).not.toBe(planted);
    expect((await http().get('/rest/v1/auth/me').set('Cookie', planted)).status).toBe(401);
    const me = await http().get('/rest/v1/auth/me').set('Host', `${labelA}.rab.test`).set('Cookie', fresh);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(a.userId);
  });

  it('no handoff when it does not apply: already on the own workspace host, no workspace (platform admin), Bearer mobile credential', async () => {
    const onOwn = await http().post('/rest/v1/auth/login').set('Host', `${labelA}.rab.test`).set('Origin', `http://${labelA}.rab.test`).send({ email: a.email, password: a.password });
    expect(onOwn.status).toBe(200);
    const ownCookie = sessionCookie(onOwn)!;
    const stay = await http().post('/rest/v1/auth/login-handoff').set('Host', `${labelA}.rab.test`).set('Origin', `http://${labelA}.rab.test`).set('Cookie', ownCookie).send({});
    expect(stay.status).toBe(200);
    expect(stay.body.redirectUrl).toBeNull();

    const admin = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: false, firstIsPlatformAdmin: true, label: 'w4hadm' })).managers[0]!;
    const adminStay = await createHandoff(await signInDefault(admin));
    expect(adminStay.status).toBe(200);
    expect(adminStay.body.redirectUrl).toBeNull();

    const mobile = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: a.email, password: a.password, applicationTarget: 'staff_app' });
    expect(mobile.status).toBe(200);
    const fromMobile = await http().post('/rest/v1/auth/login-handoff').set('Authorization', `Bearer ${mobile.body.accessToken}`).send({});
    expect(fromMobile.status).toBe(403);
  });

  it('ABUSE: flooding — at most 5 live handoffs per user (6th → 429), no unbounded token minting', async () => {
    const cookie = await signInDefault(b);
    for (let i = 0; i < 5; i += 1) expect((await createHandoff(cookie)).status).toBe(200);
    const sixth = await createHandoff(cookie);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('LOGIN_HANDOFF_RATE_LIMITED');
  });

  it('ABUSE: a handoff dies with its source session (logout) and with an account change (security version)', async () => {
    const source = await signInDefault(a);
    const token = tokenOf((await createHandoff(source)).body.redirectUrl);
    expect((await http().post('/rest/v1/auth/logout').set('Origin', DEFAULT_ORIGIN).set('Cookie', source).send({})).status).toBe(204);
    expect((await exchange(labelA, token)).status).toBe(401);

    const token2 = tokenOf((await createHandoff(await signInDefault(a))).body.redirectUrl);
    await owner.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [a.userId]);
    expect((await exchange(labelA, token2)).status).toBe(401);
  });
});
