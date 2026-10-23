import 'reflect-metadata';

// Wave 2 lane A2 (B2 key separation, B3 `__Host-` cookies). Booted once with the defaults (prefix OFF); the cookie flags are
// switched per block by wrapping EnvironmentService.get — the cookie layer reads them per request (auth-cookie-policy.ts).
const ORIGINAL_CORS = process.env.CORS_ORIGINS;
process.env.CORS_ORIGINS = 'http://localhost:5173';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const TRUSTED = 'http://localhost:5173';

interface SetCookie {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
  raw: string;
}

function setCookies(res: request.Response): SetCookie[] {
  const lines = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return lines.map((raw) => {
    const [pair, ...rest] = raw.split(';').map((p) => p.trim());
    const eq = pair.indexOf('=');
    const attrs: Record<string, string | true> = {};
    for (const a of rest) {
      const i = a.indexOf('=');
      if (i === -1) attrs[a.toLowerCase()] = true;
      else attrs[a.slice(0, i).toLowerCase()] = a.slice(i + 1);
    }
    return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attrs, raw };
  });
}

const byName = (res: request.Response, name: string) => setCookies(res).filter((c) => c.name === name);
const isClear = (c: SetCookie) => c.value === '' && typeof c.attrs.expires === 'string' && new Date(c.attrs.expires).getTime() < Date.now();

describeIfDb('wave 2 lane A2 — purpose-separated JWT keys and __Host- auth cookies (integration)', () => {
  jest.setTimeout(240_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let flags = { hostPrefix: false, legacyMigration: true };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const env = moduleRef.get(EnvironmentService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) => {
      if (key === 'AUTH_COOKIE_HOST_PREFIX_ENABLED') return flags.hostPrefix;
      if (key === 'AUTH_COOKIE_LEGACY_MIGRATION_ENABLED') return flags.legacyMigration;
      return realGet(key);
    }) as EnvironmentService['get']);
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
    process.env.CORS_ORIGINS = ORIGINAL_CORS;
  });

  beforeEach(() => {
    flags = { hostPrefix: false, legacyMigration: true };
  });

  async function manager(label: string): Promise<TestIdentity> {
    const org = await factory.createOrganisation(`w2a2-${label}`);
    return factory.createInternalManager(org);
  }

  async function webLogin(identity: TestIdentity, cookieHeader?: string) {
    const req = http().post('/rest/v1/auth/login');
    if (cookieHeader) req.set('Cookie', cookieHeader);
    const res = await req.send({ email: identity.email, password: identity.password, applicationTarget: 'manager_web' });
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  }

  const me = (cookie: string) => http().get('/rest/v1/auth/me').set('Cookie', cookie);

  // ================================================================================================ A. flag OFF
  describe('A. AUTH_COOKIE_HOST_PREFIX_ENABLED=false (default) is identical to the pre-wave-2 cookies', () => {
    it('login sets exactly crewflow_session (Path=/rest/v1) and rab_rt (Path=/rest/v1/auth): HttpOnly, SameSite=Lax, no Domain, no __Host-', async () => {
      const res = await webLogin(await manager('off-login'));
      const all = setCookies(res);
      expect(all.map((c) => c.name).sort()).toEqual(['crewflow_session', 'rab_rt']);
      const session = byName(res, 'crewflow_session')[0];
      const refresh = byName(res, 'rab_rt')[0];
      expect(session.attrs).toMatchObject({ path: '/rest/v1', httponly: true, samesite: 'Lax' });
      expect(refresh.attrs).toMatchObject({ path: '/rest/v1/auth', httponly: true, samesite: 'Lax' });
      for (const c of all) {
        expect(c.attrs.domain).toBeUndefined();
        expect(c.attrs.secure).toBeUndefined(); // non-production, as before
      }
    });

    it('refresh rotates rab_rt only; logout clears exactly the two legacy cookies', async () => {
      const login = await webLogin(await manager('off-refresh'));
      const session = byName(login, 'crewflow_session')[0].value;
      const rt = byName(login, 'rab_rt')[0].value;
      const refresh = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${rt}`);
      expect(refresh.status).toBe(200);
      expect(setCookies(refresh).map((c) => c.name)).toEqual(['rab_rt']);

      const logout = await http().post('/rest/v1/auth/logout').set('Origin', TRUSTED).set('Cookie', `crewflow_session=${session}`).send({});
      expect(logout.status).toBe(204);
      const cleared = setCookies(logout);
      expect(cleared.map((c) => `${c.name}|${c.attrs.path}`).sort()).toEqual(['crewflow_session|/rest/v1', 'rab_rt|/rest/v1/auth']);
      expect(cleared.every(isClear)).toBe(true);
    });

    it('a __Host- named cookie is not a credential while the flag is off', async () => {
      const login = await webLogin(await manager('off-host-ignored'));
      const session = byName(login, 'crewflow_session')[0].value;
      const res = await me(`__Host-crewflow_session=${session}`);
      expect(res.status).toBe(401);
      expect(res.body.message).toBe('Missing credentials');
    });
  });

  // ================================================================================================ B. flag ON
  describe('B. AUTH_COOKIE_HOST_PREFIX_ENABLED=true', () => {
    it('login sets __Host-crewflow_session and __Host-rab_rt: Secure, Path=/, HttpOnly, no Domain, SameSite unchanged; no legacy names', async () => {
      flags.hostPrefix = true;
      const res = await webLogin(await manager('on-login'));
      const all = setCookies(res);
      expect(all.map((c) => c.name).sort()).toEqual(['__Host-crewflow_session', '__Host-rab_rt']);
      for (const c of all) {
        expect(c.attrs).toMatchObject({ path: '/', httponly: true, secure: true, samesite: 'Lax' });
        expect(c.attrs.domain).toBeUndefined();
      }
    });

    it('the __Host- session cookie authenticates; the SAME value under the legacy name does not (never a credential in host mode)', async () => {
      flags.hostPrefix = true;
      const login = await webLogin(await manager('on-auth'));
      const value = byName(login, '__Host-crewflow_session')[0].value;
      expect((await me(`__Host-crewflow_session=${value}`)).status).toBe(200);
      const legacy = await me(`crewflow_session=${value}`);
      expect(legacy.status).toBe(401);
      expect(legacy.body.message).toBe('Missing credentials'); // the web client's cue to try /auth/refresh (migration)
    });

    it('CSRF is retained: an unsafe cookie request with an untrusted or missing Origin is refused (403)', async () => {
      flags.hostPrefix = true;
      const login = await webLogin(await manager('on-csrf'));
      const cookie = `__Host-crewflow_session=${byName(login, '__Host-crewflow_session')[0].value}`;
      expect((await http().post('/rest/v1/auth/logout').set('Origin', 'https://evil.example').set('Cookie', cookie).send({})).status).toBe(403);
      expect((await http().post('/rest/v1/auth/logout').set('Cookie', cookie).send({})).status).toBe(403);
      // A cookie refresh with no / an untrusted Origin is refused too.
      const rt = `__Host-rab_rt=${byName(login, '__Host-rab_rt')[0].value}`;
      expect((await http().post('/rest/v1/auth/refresh').set('Cookie', rt)).status).toBe(403);
      expect((await http().post('/rest/v1/auth/refresh').set('Origin', 'https://evil.example').set('Cookie', rt)).status).toBe(403);
      expect((await me(cookie)).status).toBe(200); // the session is untouched by the refused requests
    });

    it('migration: legacy cookies from before the switch are accepted ONCE at /auth/refresh and rotated into __Host- names', async () => {
      const login = await webLogin(await manager('migrate')); // flag off: legacy cookies
      const legacySession = byName(login, 'crewflow_session')[0].value;
      const legacyRt = byName(login, 'rab_rt')[0].value;
      const sessionId = (await me(`crewflow_session=${legacySession}`)).body.sessionId as string;

      flags.hostPrefix = true;
      expect((await me(`crewflow_session=${legacySession}`)).body.message).toBe('Missing credentials');

      const refresh = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${legacyRt}; crewflow_session=${legacySession}`);
      expect(refresh.status).toBe(200);
      const newRt = byName(refresh, '__Host-rab_rt')[0];
      const promoted = byName(refresh, '__Host-crewflow_session')[0];
      expect(newRt.value).toBeTruthy();
      expect(newRt.value).not.toBe(legacyRt); // rotated, never copied
      expect(newRt.attrs).toMatchObject({ path: '/', secure: true, httponly: true });
      expect(promoted.value).toBe(legacySession); // same credential, same session row — renamed, nothing new minted
      expect(promoted.attrs).toMatchObject({ path: '/', secure: true, httponly: true });
      expect(Number(promoted.attrs['max-age'])).toBeGreaterThan(0);
      expect(byName(refresh, 'rab_rt').every(isClear)).toBe(true);
      expect(byName(refresh, 'rab_rt')[0].attrs.path).toBe('/rest/v1/auth');
      expect(byName(refresh, 'crewflow_session').every(isClear)).toBe(true);
      expect(byName(refresh, 'crewflow_session')[0].attrs.path).toBe('/rest/v1');

      const after = await me(`__Host-crewflow_session=${promoted.value}`);
      expect(after.status).toBe(200);
      expect(after.body.sessionId).toBe(sessionId);

      // The new refresh cookie works; the legacy refresh value was single-use: replaying it is reuse (whole family revoked).
      const second = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `__Host-rab_rt=${newRt.value}`);
      expect(second.status).toBe(200);
      const replay = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${legacyRt}`);
      expect(replay.status).toBe(401);
      expect((await me(`__Host-crewflow_session=${promoted.value}`)).status).toBe(401);
    });

    it('migration never promotes a legacy session cookie of a DIFFERENT session (planted cookie): cleared, not promoted', async () => {
      const victim = await webLogin(await manager('mismatch-victim'));
      const attacker = await webLogin(await manager('mismatch-attacker'));
      const attackerSession = byName(attacker, 'crewflow_session')[0].value;
      const victimRt = byName(victim, 'rab_rt')[0].value;

      flags.hostPrefix = true;
      const refresh = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${victimRt}; crewflow_session=${attackerSession}`);
      expect(refresh.status).toBe(200);
      expect(byName(refresh, '__Host-crewflow_session')).toEqual([]);
      expect(byName(refresh, 'crewflow_session').every(isClear)).toBe(true);
    });

    it('both names present: the __Host- cookie wins, the legacy copy is ignored and cleared', async () => {
      flags.hostPrefix = true;
      const login = await webLogin(await manager('both'));
      const hostRt = byName(login, '__Host-rab_rt')[0].value;
      const bogusLegacy = `crewflow_rt_${randomBytes(16).toString('hex')}`;
      const refresh = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${bogusLegacy}; __Host-rab_rt=${hostRt}`);
      expect(refresh.status).toBe(200);
      expect(byName(refresh, '__Host-rab_rt')[0].value).not.toBe(hostRt);
      expect(byName(refresh, 'rab_rt').every(isClear)).toBe(true);
    });

    it('a duplicated legacy refresh cookie (a tossed copy) is refused, never guessed', async () => {
      const login = await webLogin(await manager('dup'));
      const rt = byName(login, 'rab_rt')[0].value;
      flags.hostPrefix = true;
      const res = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${rt}; rab_rt=${rt}`);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('DUPLICATE_SESSION_COOKIE');
    });

    it('AUTH_COOKIE_LEGACY_MIGRATION_ENABLED=false: legacy names are never read (the session must sign in again)', async () => {
      const login = await webLogin(await manager('nomigrate'));
      const rt = byName(login, 'rab_rt')[0].value;
      flags.hostPrefix = true;
      flags.legacyMigration = false;
      const res = await http().post('/rest/v1/auth/refresh').set('Origin', TRUSTED).set('Cookie', `rab_rt=${rt}`);
      expect(res.status).toBe(401);
      expect(setCookies(res).filter((c) => c.name.startsWith('__Host-'))).toEqual([]);
    });

    it('a new login while the browser still holds a legacy session supersedes (revokes) it and clears the legacy cookies', async () => {
      const identity = await manager('supersede');
      const old = await webLogin(identity);
      const oldSession = byName(old, 'crewflow_session')[0].value;
      const oldRt = byName(old, 'rab_rt')[0].value;
      flags.hostPrefix = true;
      const fresh = await webLogin(identity, `crewflow_session=${oldSession}; rab_rt=${oldRt}`);
      expect(byName(fresh, 'crewflow_session').every(isClear)).toBe(true);
      expect(byName(fresh, 'rab_rt').every(isClear)).toBe(true);
      flags.hostPrefix = false;
      expect((await me(`crewflow_session=${oldSession}`)).status).toBe(401); // revoked server-side, not just renamed
    });

    it('logout clears BOTH the __Host- and the legacy names', async () => {
      flags.hostPrefix = true;
      const login = await webLogin(await manager('logout-both'));
      const cookie = `__Host-crewflow_session=${byName(login, '__Host-crewflow_session')[0].value}`;
      const res = await http().post('/rest/v1/auth/logout').set('Origin', TRUSTED).set('Cookie', cookie).send({});
      expect(res.status).toBe(204);
      const cleared = setCookies(res);
      expect(cleared.every(isClear)).toBe(true);
      expect(cleared.map((c) => `${c.name}|${c.attrs.path}`).sort()).toEqual([
        '__Host-crewflow_session|/',
        '__Host-rab_rt|/',
        'crewflow_session|/rest/v1',
        'rab_rt|/rest/v1/auth',
      ]);
      expect((await me(cookie)).status).toBe(401);
    });

    it('mobile is unaffected: no cookies issued, body refresh token, Bearer access', async () => {
      flags.hostPrefix = true;
      const org = await factory.createOrganisation('w2a2-mobile');
      const mgr = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner: mgr });
      const login = await factory.loginRaw(staff, { mobile: true });
      expect(login.status).toBe(200);
      expect(login.headers['set-cookie']).toBeUndefined();
      expect(typeof login.body.refreshToken).toBe('string');
      const refresh = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken: login.body.refreshToken });
      expect(refresh.status).toBe(200);
      expect(refresh.headers['set-cookie']).toBeUndefined();
      expect((await http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${refresh.body.accessToken}`)).status).toBe(200);
    });
  });

  // ================================================================================================ C. keys
  describe('C. purpose-separated JWT keys (no keyring configured in this environment)', () => {
    async function bearerSession() {
      const tokens = await factory.loginTokens(await manager('jwt'));
      const decoded = jwt.decode(tokens.accessToken, { complete: true }) as { header: { kid?: string }; payload: Record<string, unknown> };
      return { ...tokens, decoded };
    }
    const sign = (payload: Record<string, unknown>, secret: string, opts: jwt.SignOptions) =>
      jwt.sign({ sub: payload.sub, org: payload.org, roles: payload.roles, sid: payload.sid, applicationTarget: payload.applicationTarget }, secret, {
        algorithm: 'HS256',
        issuer: 'rab-auth',
        audience: 'rab-api',
        expiresIn: 600,
        ...opts,
      });
    const meBearer = (token: string) => http().get('/rest/v1/auth/me').set('Authorization', `Bearer ${token}`);

    it('new access tokens carry kid "derived-v1" and verify', async () => {
      const { accessToken, decoded } = await bearerSession();
      expect(decoded.header.kid).toBe('derived-v1');
      expect((await meBearer(accessToken)).status).toBe(200);
    });

    it('a token signed the pre-wave-2 way (raw APP_SECRET, kid "legacy" or no kid) still verifies — no abrupt invalidation', async () => {
      const { decoded } = await bearerSession();
      const secret = process.env.APP_SECRET as string;
      expect((await meBearer(sign(decoded.payload, secret, { keyid: 'legacy' }))).status).toBe(200);
      expect((await meBearer(sign(decoded.payload, secret, {}))).status).toBe(200);
    });

    it('a raw-APP_SECRET token claiming kid "derived-v1", an unknown kid and an expired token are all refused', async () => {
      const { decoded } = await bearerSession();
      const secret = process.env.APP_SECRET as string;
      expect((await meBearer(sign(decoded.payload, secret, { keyid: 'derived-v1' }))).status).toBe(401);
      expect((await meBearer(sign(decoded.payload, secret, { keyid: 'kid-nobody-has' }))).status).toBe(401);
      expect((await meBearer(sign(decoded.payload, secret, { keyid: 'legacy', expiresIn: -10 }))).status).toBe(401);
    });

    it('a valid token for a revoked session is refused (revocation is server-side, independent of the key)', async () => {
      const { accessToken, refreshToken } = await bearerSession();
      const logout = await http().post('/rest/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).set('x-client-platform', 'mobile').send({ refreshToken });
      expect(logout.status).toBe(204);
      expect((await meBearer(accessToken)).status).toBe(401);
    });
  });
});
