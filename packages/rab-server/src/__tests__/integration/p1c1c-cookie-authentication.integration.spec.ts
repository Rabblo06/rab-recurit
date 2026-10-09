import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentityFactory } from './helpers/test-identities';

/**
 * P1C.1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9) — genuine cookie-first browser authentication.
 * Real Postgres, real HTTP, no mocked cookie transport — the whole point of this suite is proving
 * the `crewflow_session` cookie ACTUALLY authenticates through `core.auth_find_session_by_web_token_hash`
 * and the unmodified `AuthSecuritySnapshotService`, not merely that the code compiles.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
jest.setTimeout(60_000);

const WEB_SESSION_COOKIE_NAME = 'crewflow_session';
const CORS_ORIGIN = 'http://localhost:5173';

describeIfDb('P1C.1C — cookie-first web authentication', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let adminDataSource: DataSource;
  let tenantContext: TenantContextService;
  let factory: TestIdentityFactory;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    dataSource = moduleRef.get(DataSource);
    tenantContext = moduleRef.get(TenantContextService);
    adminDataSource = createAdminDataSource();
    await adminDataSource.initialize();
    factory = new TestIdentityFactory({ app, dataSource, adminDataSource, tenantContext, passwordHashing: moduleRef.get(PasswordHashingService) });
  });

  afterAll(async () => {
    await app.close();
    await adminDataSource.destroy();
  });

  function extractCookie(res: request.Response, name: string): string | undefined {
    const raw = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const line = raw.find((c) => c.startsWith(`${name}=`));
    if (!line) return undefined;
    return decodeURIComponent(line.split(';')[0]!.slice(name.length + 1));
  }

  async function loginAndGetCookie(manager: Awaited<ReturnType<TestIdentityFactory['createInternalManager']>>) {
    const res = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = extractCookie(res, WEB_SESSION_COOKIE_NAME);
    if (!cookie) throw new Error('login did not set crewflow_session');
    return { cookie, body: res.body as { sessionExpiresAt: string; accessToken: string; mustResetPassword: boolean } };
  }

  // ============================================================================ A. ISSUANCE
  describe('A. Issuance', () => {
    it('password login sets crewflow_session, HttpOnly, and the hash (never the raw value) lands in core.user_session', async () => {
      const org = await factory.createOrganisation('p1c1c-issue');
      const manager = await factory.createInternalManager(org);
      const res = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      expect(res.status).toBe(200);

      const setCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${WEB_SESSION_COOKIE_NAME}=`))!;
      expect(setCookie).toContain('HttpOnly');
      const cookie = extractCookie(res, WEB_SESSION_COOKIE_NAME)!;
      expect(cookie.startsWith('crewflow_sess_')).toBe(true);

      const expectedHash = createHash('sha256').update(cookie).digest('hex');
      const [row] = await adminDataSource.query('SELECT web_session_token_hash FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [manager.userId]);
      expect(row.web_session_token_hash).toBe(expectedHash);
      expect(row.web_session_token_hash).not.toBe(cookie); // never the raw value
    });

    it('mobile (staff) login never sets crewflow_session, and the session row keeps web_session_token_hash NULL', async () => {
      const org = await factory.createOrganisation('p1c1c-mobile-null');
      const manager = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner: manager });
      const res = await factory.loginRaw(staff, { mobile: true });
      expect(res.status).toBe(200);
      expect(extractCookie(res, WEB_SESSION_COOKIE_NAME)).toBeUndefined();

      const [row] = await adminDataSource.query('SELECT web_session_token_hash FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [staff.userId]);
      expect(row.web_session_token_hash).toBeNull();
    });

    it('a refresh does not rotate or (re)issue a web session credential', async () => {
      const org = await factory.createOrganisation('p1c1c-no-rotate');
      const manager = await factory.createInternalManager(org);
      const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const rabRt = extractCookie(loginRes, 'rab_rt')!;

      const refreshRes = await request(app.getHttpServer()).post('/rest/v1/auth/refresh').set('Origin', CORS_ORIGIN).set('Cookie', [`rab_rt=${rabRt}`]);
      expect(refreshRes.status).toBe(200);
      // Whatever the refresh outcome, it must never attempt to set crewflow_session again.
      expect(extractCookie(refreshRes, WEB_SESSION_COOKIE_NAME)).toBeUndefined();
    });

    it('a well-formed but never-issued cookie value is rejected — historical/forged sessions get no authority', async () => {
      const forged = `crewflow_sess_${randomBytes(32).toString('base64url')}`;
      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${forged}`]);
      expect(res.status).toBe(401);
    });
  });

  // ============================================================================ B. VALIDATION
  describe('B. Validation', () => {
    it('a valid cookie authenticates /auth/me with NO Authorization header at all', async () => {
      const org = await factory.createOrganisation('p1c1c-valid');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);

      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(manager.userId);
      expect(res.body.sessionId).toBeTruthy();
      expect(res.body.applicationTarget).toBe('manager_web');
      // P1C.1C-F: the cookie-first frontend bootstrap has no login/refresh response of its own to
      // read the session deadline from any more — /auth/me carries it instead, same non-secret
      // value `AuthTokens.sessionExpiresAt` already exposes on login/refresh.
      expect(new Date(res.body.sessionExpiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('a malformed cookie (wrong shape) is rejected without ever reaching the database lookup', async () => {
      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=not-a-real-token`]);
      expect(res.status).toBe(401);
    });

    it('revoking the session (password change -> revokeAllForUser) denies the VERY NEXT cookie-authenticated request', async () => {
      const org = await factory.createOrganisation('p1c1c-revoke-next');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);

      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, (m) =>
        m.query(`UPDATE core.user_session SET revoked_at = now(), revoked_reason = 'test', security_version = security_version + 1 WHERE user_id = $1 AND revoked_at IS NULL`, [manager.userId]),
      );

      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(res.status).toBe(401);
    });

    it('a permission removed from the role denies the cookie-authenticated request too — same snapshot, no divergence from the JWT path', async () => {
      const org = await factory.createOrganisation('p1c1c-perm-removed');
      const manager = await factory.createInternalManager(org, { permissions: ['staff.view'] });
      const { cookie } = await loginAndGetCookie(manager);

      const staffViaCookie = await request(app.getHttpServer()).get('/rest/v1/staff').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(staffViaCookie.status).toBe(200);

      await tenantContext.runInTenantContext({ organisationId: org.id, workspaceId: manager.workspaceId, userId: manager.userId, role: '' }, (m) =>
        m.query(`DELETE FROM core.role_permission WHERE role_id = (SELECT id FROM core.role WHERE organisation_id = $1 AND key = $2)`, [org.id, manager.roleKey]),
      );

      const after = await request(app.getHttpServer()).get('/rest/v1/staff').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(after.status).toBe(403);
    });
  });

  // ============================================================================ C. REVOCATION
  describe('C. Revocation', () => {
    it('logout revokes the session; replaying the OLD cookie afterward fails', async () => {
      const org = await factory.createOrganisation('p1c1c-logout-replay');
      const manager = await factory.createInternalManager(org);
      const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const cookie = extractCookie(loginRes, WEB_SESSION_COOKIE_NAME)!;
      const rabRt = extractCookie(loginRes, 'rab_rt')!;
      const accessToken = loginRes.body.accessToken as string;

      const logoutRes = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .set('Origin', CORS_ORIGIN)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', [`rab_rt=${rabRt}`]);
      expect(logoutRes.status).toBe(204);
      expect(extractCookie(logoutRes, WEB_SESSION_COOKIE_NAME)).toBe(''); // cleared

      const replay = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(replay.status).toBe(401);
    });

    it('revoking a DIFFERENT device (ProfileService.revokeSession) invalidates THAT cookie while this one stays valid', async () => {
      const org = await factory.createOrganisation('p1c1c-revoke-device');
      const manager = await factory.createInternalManager(org);
      const session1 = await loginAndGetCookie(manager);
      const session2 = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const cookie2 = extractCookie(session2, WEB_SESSION_COOKIE_NAME)!;
      const sessionId2 = session2.body.accessToken ? decodeAccessTokenSid(session2.body.accessToken as string) : undefined;

      // Revoke session 2 from session 1's own authenticated context.
      const revokeRes = await request(app.getHttpServer())
        .delete(`/rest/v1/profile/sessions/${sessionId2}`)
        .set('Origin', CORS_ORIGIN)
        .set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${session1.cookie}`]);
      expect(revokeRes.status).toBe(204);

      const stillValid = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${session1.cookie}`]);
      expect(stillValid.status).toBe(200);

      const revoked = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie2}`]);
      expect(revoked.status).toBe(401);
    });

    function decodeAccessTokenSid(token: string): string {
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      return payload.sid as string;
    }
  });

  // ============================================================================ D. CREDENTIAL CONFUSION
  describe('D. Credential confusion', () => {
    it('a crewflow_session value is never accepted as a Bearer token', async () => {
      const org = await factory.createOrganisation('p1c1c-cred-confusion-1');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);

      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Authorization', `Bearer ${cookie}`);
      expect(res.status).toBe(401);
    });

    it('an invalid cookie is never silently replaced by a valid Bearer header on the SAME request', async () => {
      const org = await factory.createOrganisation('p1c1c-cred-confusion-2');
      const manager = await factory.createInternalManager(org);
      const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const accessToken = loginRes.body.accessToken as string;

      const res = await request(app.getHttpServer())
        .get('/rest/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=crewflow_sess_${randomBytes(32).toString('base64url')}`]);
      // The cookie is present (even though invalid) -> authoritative -> rejected, NEVER falls
      // back to the perfectly valid Bearer token also attached.
      expect(res.status).toBe(401);
    });

    it('a mismatched X-Crewflow-Expected-Session-Id fences the request even though the cookie itself is valid', async () => {
      const org = await factory.createOrganisation('p1c1c-fence');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);

      const res = await request(app.getHttpServer())
        .get('/rest/v1/auth/me')
        .set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`])
        .set('X-Crewflow-Expected-Session-Id', '00000000-0000-0000-0000-000000000000');
      expect(res.status).toBe(401);
    });

    it('no expected-session-id header at all is fine (first-ever bootstrap has nothing to fence against)', async () => {
      const org = await factory.createOrganisation('p1c1c-no-fence');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);
      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(res.status).toBe(200);
    });

    it('a stale logout dispatched under session As own expected-session-id, replayed against a cookie that now resolves to a DIFFERENT, currently-valid session C, is rejected and never touches C', async () => {
      // The deterministic, server-side equivalent of the "Tab A's held /auth/logout released
      // after Tab B logs in as C on the shared cookie jar" scenario — attempted three times as a
      // real multi-tab Playwright test (packages/rab-e2e-testing/web/cookie-race.spec.ts) and
      // replaced with this instead: every one of those runs hit the SAME structural conflict with
      // the already-proven-correct cross-tab reload-on-foreign-broadcast reaction (session-race.spec.ts's
      // "multi-tab race 3"), which tears down the browser tab's JS context — and with it any
      // in-page fetch — the instant the OTHER tab's login succeeds, before the release can prove
      // anything about what the server does with the request. The property itself has no genuine
      // dependency on real browser cookie-reattachment timing: it is fully, deterministically
      // reproducible by constructing both sessions directly and presenting Cs cookie with As
      // asserted session id, exactly as a request already in flight when the ambient cookie
      // changed underneath it would arrive.
      const orgA = await factory.createOrganisation('p1c1c-stale-logout-a');
      const managerA = await factory.createInternalManager(orgA);
      const sessionA = await loginAndGetCookie(managerA);
      // `/auth/me` is the real source `api.ts` reads this header from (the login response itself
      // carries no sessionId) — resolve it the same way the frontend's own post-login bootstrap does.
      const meA = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${sessionA.cookie}`]);
      const resolvedASessionId = meA.body.sessionId as string;

      const orgC = await factory.createOrganisation('p1c1c-stale-logout-c');
      const managerC = await factory.createInternalManager(orgC);
      const sessionC = await loginAndGetCookie(managerC);

      // The exact released-request shape: Cs cookie (the ambient credential actually attached at
      // send time) plus As own fencing header (what the issuing tab still believed, captured
      // before the ambient identity changed underneath it).
      const staleLogout = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .set('Origin', CORS_ORIGIN)
        .set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${sessionC.cookie}`])
        .set('X-Crewflow-Expected-Session-Id', resolvedASessionId);
      expect(staleLogout.status).toBe(401);

      // Decisive: C is completely undisturbed.
      const cStillValid = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${sessionC.cookie}`]);
      expect(cStillValid.status).toBe(200);
      expect(cStillValid.body.id).toBe(managerC.userId);
    });
  });

  // ============================================================================ E. DATABASE SECURITY
  describe('E. Database security', () => {
    it('a query against core.user_session with no tenant context bound still returns zero rows over rab_app, despite NOT FORCE', async () => {
      const rows = await dataSource.query('SELECT * FROM core.user_session LIMIT 5');
      expect(rows).toEqual([]);
    });

    it('the pre-auth lookup function returns only the four documented columns, never a full row', async () => {
      const org = await factory.createOrganisation('p1c1c-narrow-lookup');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);
      const hash = createHash('sha256').update(cookie).digest('hex');

      const [row] = await adminDataSource.query('SELECT * FROM core.auth_find_session_by_web_token_hash($1)', [hash]);
      expect(Object.keys(row).sort()).toEqual(['applicationTarget', 'organisationId', 'sessionId', 'userId'].sort());
    });
  });

  // ============================================================================ F. CSRF
  describe('F. CSRF / Origin', () => {
    it('a cookie-authenticated unsafe (POST) request from a disallowed Origin is rejected', async () => {
      const org = await factory.createOrganisation('p1c1c-csrf-reject');
      const manager = await factory.createInternalManager(org);
      const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const cookie = extractCookie(loginRes, WEB_SESSION_COOKIE_NAME)!;
      const rabRt = extractCookie(loginRes, 'rab_rt')!;

      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .set('Origin', 'https://evil.example.com')
        .set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`, `rab_rt=${rabRt}`]);
      expect(res.status).toBe(403);
    });

    it('a cookie-authenticated unsafe request with a missing Origin is rejected', async () => {
      const org = await factory.createOrganisation('p1c1c-csrf-missing');
      const manager = await factory.createInternalManager(org);
      const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const cookie = extractCookie(loginRes, WEB_SESSION_COOKIE_NAME)!;

      const res = await request(app.getHttpServer()).post('/rest/v1/auth/logout').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(res.status).toBe(403);
    });

    it('a cookie-authenticated unsafe request with the real allowed Origin succeeds', async () => {
      const org = await factory.createOrganisation('p1c1c-csrf-allowed');
      const manager = await factory.createInternalManager(org);
      const loginRes = await factory.loginRaw(manager, { applicationTarget: 'manager_web' });
      const cookie = extractCookie(loginRes, WEB_SESSION_COOKIE_NAME)!;
      const rabRt = extractCookie(loginRes, 'rab_rt')!;

      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .set('Origin', CORS_ORIGIN)
        .set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`, `rab_rt=${rabRt}`]);
      expect(res.status).toBe(204);
    });

    it('a cookie-authenticated SAFE (GET) request needs no Origin header at all', async () => {
      const org = await factory.createOrganisation('p1c1c-csrf-safe');
      const manager = await factory.createInternalManager(org);
      const { cookie } = await loginAndGetCookie(manager);
      const res = await request(app.getHttpServer()).get('/rest/v1/auth/me').set('Cookie', [`${WEB_SESSION_COOKIE_NAME}=${cookie}`]);
      expect(res.status).toBe(200);
    });

    it('a mobile Bearer-authenticated unsafe request is unaffected by the cookie-only Origin requirement', async () => {
      const org = await factory.createOrganisation('p1c1c-csrf-mobile');
      const manager = await factory.createInternalManager(org);
      const staff = await factory.createStaff(org, { owner: manager });
      const token = await factory.loginTokens(staff);
      const res = await request(app.getHttpServer())
        .post('/rest/v1/auth/logout')
        .set('x-client-platform', 'mobile')
        .set('Authorization', `Bearer ${token.accessToken}`)
        .send({ refreshToken: token.refreshToken });
      // No Origin header at all, no cookie — must succeed purely on the Bearer credential.
      expect(res.status).toBe(204);
    });
  });
});
