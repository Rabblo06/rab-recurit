import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { AdminAuditService } from '../../engine/core-modules/platform-admin/admin-audit.service';
import { AdminConfigService } from '../../engine/core-modules/platform-admin/admin-config.service';
import { ADMIN_HEALTH_CACHE_KEY, AdminHealthService } from '../../engine/core-modules/platform-admin/admin-health.service';
import { AdminQueuesService } from '../../engine/core-modules/platform-admin/admin-queues.service';
import { AdminUsersService } from '../../engine/core-modules/platform-admin/admin-users.service';
import { AdminWorkspacesService } from '../../engine/core-modules/platform-admin/admin-workspaces.service';
import { FileService } from '../../engine/core-modules/storage/file.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Crewflow Platform Admin Panel — HTTP surface abuse cases (plan §6): every new route is 401 unauthenticated and 403 for a
 * non-admin holding every permission; every service refuses a non-admin called directly (layer 2, no guard); a mutation
 * under the Admin Inspect header is refused; client-sent `organisationId` / unknown fields are 400; responses carry no
 * secret / hash / token / payload / metadata keys; "Sign out everywhere" needs step-up + reason, never self, revokes the
 * target's sessions and refresh tokens cross-organisation, bumps the security version and is audited in both
 * organisations; searches are audited (D10) without the raw query; the environment view never echoes a planted secret,
 * URL or host; health probes are bounded and never return raw error text.
 */
const RUN = Boolean(process.env.DATABASE_URL && process.env.REDIS_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const GET_ROUTES = [
  '/rest/v1/admin/users/search?q=example',
  `/rest/v1/admin/users/${randomUUID()}/summary`,
  '/rest/v1/admin/platform-admins',
  '/rest/v1/admin/lookup/organisations?q=test',
  `/rest/v1/admin/lookup/organisations/${randomUUID()}/summary`,
  '/rest/v1/admin/queues',
  '/rest/v1/admin/queues/rab-email/jobs?state=failed',
  '/rest/v1/admin/overview',
  '/rest/v1/admin/migrations',
  '/rest/v1/admin/workspaces',
  '/rest/v1/admin/audit',
  '/rest/v1/admin/health/report',
  '/rest/v1/admin/config/environment',
  '/rest/v1/admin/config/email',
  '/rest/v1/admin/security',
];
const POST_ROUTES: Array<[string, Record<string, unknown>]> = [
  [`/rest/v1/admin/users/${randomUUID()}/sessions/revoke`, { reason: 'abuse case' }],
  ['/rest/v1/admin/queues/rab-email/jobs/retry', { jobIds: ['1'], reason: 'abuse case' }],
  ['/rest/v1/admin/queues/rab-email/jobs/delete', { jobIds: ['1'], reason: 'abuse case' }],
  ['/rest/v1/admin/config/email/test', {}],
];

/** Keys that must never appear anywhere in an Admin Panel response body. */
const FORBIDDEN_KEY = /password|hash|secret|token|rendered|pence|amount|stack|failedreason|metadata|^data$|^payload$|^body$|^returnvalue$|useragent|ipaddress/i;
function forbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  }
  return [];
}

describeIfDb('admin panel routes (integration)', () => {
  jest.setTimeout(300_000);
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let authRedis: AuthCacheRedisClientProvider;
  let throttlerRedis: ThrottlerRedisClientProvider;
  const overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;

  let admin: TestIdentity;
  let nonAdmin: TestIdentity;
  let target: TestIdentity;
  let adminToken: string;
  let nonAdminToken: string;

  async function staleToken(who: TestIdentity): Promise<string> {
    const token = await factory.login(who, { applicationTarget: 'manager_web' });
    await authRedis.client.del(`crewflow:test:step-up:${sha256(sidOf(token))}`);
    return token;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    const env = moduleRef.get(EnvironmentService);
    const realGet = env.get.bind(env);
    jest.spyOn(env, 'get').mockImplementation(((key: keyof EnvironmentVariables) => (key in overrides ? overrides[key] : realGet(key))) as EnvironmentService['get']);
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    authRedis = moduleRef.get(AuthCacheRedisClientProvider);
    throttlerRedis = moduleRef.get(ThrottlerRedisClientProvider);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const adminOrg = await factory.createOrganisation('aproutes-admin');
    admin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'aprtadm', platformAdmin: true });
    nonAdmin = await factory.createInternalManager(adminOrg, { permissions: 'all', label: 'aprtmgr' });
    const targetOrg = await factory.createOrganisation('aproutes-target');
    target = await factory.createInternalManager(targetOrg, { permissions: 'production', label: 'aprttgt' });
    adminToken = await factory.login(admin, { applicationTarget: 'manager_web' });
    nonAdminToken = await factory.login(nonAdmin, { applicationTarget: 'manager_web' });
  });

  afterEach(() => {
    for (const key of Object.keys(overrides)) delete overrides[key as keyof EnvironmentVariables];
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it('ABUSE: every new route is 401 without a session', async () => {
    for (const path of GET_ROUTES) expect({ path, status: (await http().get(path)).status }).toEqual({ path, status: 401 });
    for (const [path, body] of POST_ROUTES) expect({ path, status: (await http().post(path).send(body)).status }).toEqual({ path, status: 401 });
  });

  it('ABUSE: a non-platform-admin holding EVERY permission gets 403 on every new route, and nothing is written', async () => {
    const before = (await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action LIKE 'admin.%'`, [nonAdmin.userId]))[0].n;
    for (const path of GET_ROUTES) expect({ path, status: (await http().get(path).set(bearer(nonAdminToken))).status }).toEqual({ path, status: 403 });
    for (const [path, body] of POST_ROUTES) expect({ path, status: (await http().post(path).set(bearer(nonAdminToken)).send(body)).status }).toEqual({ path, status: 403 });
    const after = (await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE actor_user_id = $1 AND action LIKE 'admin.%'`, [nonAdmin.userId]))[0].n;
    expect(after).toBe(before);
  });

  it('ABUSE layer 2: every Admin Panel service refuses a non-admin called directly (no guard: jobs, CLIs, other services)', async () => {
    const actor = { userId: nonAdmin.userId, organisationId: nonAdmin.organisationId, workspaceId: null, sessionId: undefined, inspectedBy: undefined };
    const users = app.get(AdminUsersService);
    const queues = app.get(AdminQueuesService);
    const workspaces = app.get(AdminWorkspacesService);
    const auditTimeline = app.get(AdminAuditService);
    const health = app.get(AdminHealthService);
    const config = app.get(AdminConfigService);
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['searchUsers', () => users.searchUsers(actor, target.email)],
      ['userSummary', () => users.userSummary(actor, target.userId)],
      ['revokeSessions', () => users.revokeSessions(actor, target.userId, 'layer two')],
      ['listPlatformAdmins', () => users.listPlatformAdmins(actor)],
      ['searchOrganisations', () => users.searchOrganisations(actor, 'aproutes')],
      ['organisationSummary', () => users.organisationSummary(actor, target.organisationId)],
      ['queues.overview', () => queues.overview(actor)],
      ['queues.listJobs', () => queues.listJobs(actor, 'rab-email', 'failed')],
      ['queues.retryJobs', () => queues.retryJobs(actor, 'rab-email', ['1'], 'layer two')],
      ['queues.deleteJobs', () => queues.deleteJobs(actor, 'rab-email', ['1'], 'layer two')],
      ['workspaces.overview', () => workspaces.overview(actor)],
      ['workspaces.coreMigrations', () => workspaces.coreMigrations(actor)],
      ['workspaces.listWorkspaces', () => workspaces.listWorkspaces(actor, {})],
      ['audit.listAudit', () => auditTimeline.listAudit(actor, {})],
      ['health.report', () => health.report(actor)],
      ['config.environment', () => config.environment(actor)],
      ['config.email', () => config.email(actor)],
      ['config.sendTestEmail', () => config.sendTestEmail(actor)],
      ['config.security', () => config.security(actor)],
    ];
    for (const [name, call] of calls) await expect(call().catch((e: { status?: number }) => ({ name, status: e.status }))).resolves.toEqual({ name, status: 403 });
  });

  it('ABUSE: a mutation under the Admin Inspect header is refused (INSPECT_READ_ONLY), and the service refuses an inspect context too', async () => {
    for (const [path, body] of POST_ROUTES) {
      const res = await http().post(path).set(bearer(adminToken)).set('X-Inspect-Session-Id', randomUUID()).send(body);
      expect({ path, status: res.status, code: res.body.code }).toEqual({ path, status: 403, code: 'INSPECT_READ_ONLY' });
    }
    const inspecting = { userId: admin.userId, organisationId: admin.organisationId, workspaceId: null, inspectedBy: admin.userId };
    await expect(app.get(AdminUsersService).revokeSessions(inspecting, target.userId, 'inspect')).rejects.toMatchObject({ status: 403 });
    await expect(app.get(AdminQueuesService).retryJobs(inspecting, 'rab-email', ['1'], 'inspect')).rejects.toMatchObject({ status: 403 });
    await expect(app.get(AdminConfigService).sendTestEmail(inspecting)).rejects.toMatchObject({ status: 403 });
  });

  it('ABUSE mass assignment: organisationId / userId / unknown fields in a body or query are 400; bad reason 400; >100 job ids 400', async () => {
    const url = `/rest/v1/admin/users/${target.userId}/sessions/revoke`;
    expect((await http().post(url).set(bearer(adminToken)).send({ reason: 'valid reason', organisationId: randomUUID() })).status).toBe(400);
    expect((await http().post(url).set(bearer(adminToken)).send({})).status).toBe(400);
    expect((await http().post(url).set(bearer(adminToken)).send({ reason: 'ab' })).status).toBe(400);
    expect((await http().post(url).set(bearer(adminToken)).send({ reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await http().get('/rest/v1/admin/users/search?q=abc&organisationId=' + randomUUID()).set(bearer(adminToken))).status).toBe(400);
    expect((await http().get('/rest/v1/admin/users/search?role=superuser').set(bearer(adminToken))).status).toBe(400);
    const ids = Array.from({ length: 101 }, (_, i) => `job-${i}`);
    expect((await http().post('/rest/v1/admin/queues/rab-email/jobs/retry').set(bearer(adminToken)).send({ jobIds: ids, reason: 'too many' })).status).toBe(400);
    expect((await http().post('/rest/v1/admin/queues/rab-email/jobs/retry').set(bearer(adminToken)).send({ jobIds: ['bad id*'], reason: 'glob' })).status).toBe(400);
    expect((await http().post(`/rest/v1/admin/organisations/${randomUUID()}/ceo-invite/resend`).set(bearer(adminToken)).send({ reason: 'ab' })).status).toBe(400);
  });

  it('response snapshots: no secret / hash / token / payload / metadata key in any Admin Panel GET', async () => {
    const paths = [
      '/rest/v1/admin/users/search',
      `/rest/v1/admin/users/search?q=${encodeURIComponent(target.email)}`,
      `/rest/v1/admin/users/${target.userId}/summary`,
      '/rest/v1/admin/platform-admins',
      '/rest/v1/admin/lookup/organisations?q=aproutes',
      `/rest/v1/admin/lookup/organisations/${target.organisationId}/summary`,
      '/rest/v1/admin/queues',
      '/rest/v1/admin/queues/rab-email/jobs?state=failed',
      '/rest/v1/admin/overview',
      '/rest/v1/admin/migrations',
      '/rest/v1/admin/workspaces',
      '/rest/v1/admin/audit',
      '/rest/v1/admin/health/report',
      '/rest/v1/admin/config/environment',
      '/rest/v1/admin/config/email',
      '/rest/v1/admin/security',
      '/rest/v1/admin/general',
    ];
    for (const path of paths) {
      const res = await http().get(path).set(bearer(adminToken));
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect({ path, keys: forbiddenKeys(res.body) }).toEqual({ path, keys: [] });
    }
  });

  it('user search: cross-organisation result with 2FA state and roles; audited (D10) with ids + counts, never the raw query', async () => {
    const res = await http().get(`/rest/v1/admin/users/search?q=${encodeURIComponent(target.email)}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: target.userId, organisationId: target.organisationId, twoFactor: { enabled: false, enabledAt: null, recoveryCodesRemaining: null }, isPlatformAdmin: false });
    expect(res.body[0].roleKeys).toContain('manager');
    const [audit] = await owner.query(
      `SELECT organisation_id, target_user_id, metadata FROM core.audit_log WHERE actor_user_id = $1 AND action = 'admin.user_searched' ORDER BY created_at DESC LIMIT 1`,
      [admin.userId],
    );
    expect(audit).toMatchObject({ organisation_id: admin.organisationId, target_user_id: target.userId, metadata: { kind: 'email', resultCount: 1, resultUserIds: [target.userId] } });
    expect(JSON.stringify(audit.metadata)).not.toContain(target.email);
    expect((await http().get('/rest/v1/admin/users/search?q=ab').set(bearer(adminToken))).status).toBe(400);
  });

  it('user summary: identity, sessions by app, last provider, failed sign-ins (24 h); 404 for unknown / malformed ids', async () => {
    await factory.login(target, { applicationTarget: 'manager_web' });
    const res = await http().get(`/rest/v1/admin/users/${target.userId}/summary`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: target.userId, lastSignInProvider: 'password', failedSignIns24h: expect.any(Number) });
    expect(res.body.sessions.managerWeb).toBeGreaterThanOrEqual(1);
    expect((await http().get(`/rest/v1/admin/users/${randomUUID()}/summary`).set(bearer(adminToken))).status).toBe(404);
    expect((await http().get(`/rest/v1/admin/users/not-a-uuid/summary`).set(bearer(adminToken))).status).toBe(404);
  });

  it('ABUSE sign out everywhere: a STALE session is refused 403 STEP_UP_REQUIRED and nothing is revoked', async () => {
    await factory.login(target, { applicationTarget: 'manager_web' });
    const stale = await staleToken(admin);
    const res = await http().post(`/rest/v1/admin/users/${target.userId}/sessions/revoke`).set(bearer(stale)).send({ reason: 'stale session attempt' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [target.userId]);
    expect(n).toBeGreaterThan(0);
  });

  it('sign out everywhere: after step-up, every session + refresh token of a user in ANOTHER organisation is revoked, version bumped, audited in both orgs', async () => {
    const targetTokens = await factory.loginTokens(target);
    const targetAccess = await factory.login(target, { applicationTarget: 'manager_web' });
    const [{ v: versionBefore }] = await owner.query(`SELECT security_version::int AS v FROM core."user" WHERE id = $1`, [target.userId]);
    const stale = await staleToken(admin);
    const stepUp = await http().post('/rest/v1/auth/step-up').set(bearer(stale)).set('Origin', ORIGIN).send({ currentPassword: admin.password });
    expect(stepUp.status).toBe(200);
    const res = await http().post(`/rest/v1/admin/users/${target.userId}/sessions/revoke`).set(bearer(stale)).send({ reason: 'Support ticket 4411: lost laptop' });
    expect(res.status).toBe(200);
    expect(res.body.revokedSessions).toBeGreaterThanOrEqual(2);
    expect(Object.keys(res.body).sort()).toEqual(['revokedRefreshTokens', 'revokedSessions']);
    const [{ live }] = await owner.query(`SELECT count(*)::int AS live FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [target.userId]);
    expect(live).toBe(0);
    const [{ reason }] = await owner.query(`SELECT revoked_reason AS reason FROM core.user_session WHERE user_id = $1 ORDER BY revoked_at DESC LIMIT 1`, [target.userId]);
    expect(reason).toBe('admin_signed_out_everywhere');
    const [{ liveTokens }] = await owner.query(`SELECT count(*)::int AS "liveTokens" FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL`, [target.userId]);
    expect(liveTokens).toBe(0);
    const [{ v: versionAfter }] = await owner.query(`SELECT security_version::int AS v FROM core."user" WHERE id = $1`, [target.userId]);
    expect(versionAfter).toBeGreaterThan(versionBefore);
    const audits = await owner.query(
      `SELECT organisation_id, metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'admin.sessions_revoked' AND actor_user_id = $1 AND target_user_id = $2 ORDER BY organisation_id`,
      [admin.userId, target.userId],
    );
    expect(audits.map((a: { organisation_id: string }) => a.organisation_id).sort()).toEqual([admin.organisationId, target.organisationId].sort());
    for (const a of audits) expect(a.reason).toBe('Support ticket 4411: lost laptop');
    expect((await http().get('/rest/v1/auth/me').set(bearer(targetAccess))).status).toBe(401);
    expect((await http().post('/rest/v1/auth/refresh').set('Origin', ORIGIN).send({ refreshToken: targetTokens.refreshToken })).status).toBe(401);
  });

  it('ABUSE sign out everywhere: never on yourself (409), unknown user 404', async () => {
    const self = await http().post(`/rest/v1/admin/users/${admin.userId}/sessions/revoke`).set(bearer(adminToken)).send({ reason: 'sign myself out' });
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('SESSIONS_REVOKE_SELF');
    const fresh = await factory.login(admin, { applicationTarget: 'manager_web' });
    expect((await http().post(`/rest/v1/admin/users/${randomUUID()}/sessions/revoke`).set(bearer(fresh)).send({ reason: 'nobody here' })).status).toBe(404);
  });

  it('organisation lookup + summary: counts only; audited when a query is given', async () => {
    const res = await http().get(`/rest/v1/admin/lookup/organisations?q=${encodeURIComponent(target.organisationId)}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.map((o: { id: string }) => o.id)).toEqual([target.organisationId]);
    const summary = await http().get(`/rest/v1/admin/lookup/organisations/${target.organisationId}/summary`).set(bearer(adminToken));
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ id: target.organisationId, members: { active: expect.any(Number) }, workspaces: { total: expect.any(Number) } });
    expect(summary.body.workspaces.total).toBeGreaterThanOrEqual(1);
    const [audit] = await owner.query(`SELECT metadata FROM core.audit_log WHERE actor_user_id = $1 AND action = 'admin.organisation_searched' ORDER BY created_at DESC LIMIT 1`, [admin.userId]);
    expect(audit.metadata).toMatchObject({ kind: 'id', resultCount: 1 });
    expect((await http().get(`/rest/v1/admin/lookup/organisations/${randomUUID()}/summary`).set(bearer(adminToken))).status).toBe(404);
  });

  it('platform admins list marks "you" and never includes a revoked admin', async () => {
    const res = await http().get('/rest/v1/admin/platform-admins').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const me = res.body.find((a: { userId: string }) => a.userId === admin.userId);
    expect(me).toMatchObject({ isYou: true, twoFactorEnabled: false });
    expect(res.body.length).toBeLessThanOrEqual(50);
    const former = await factory.createInternalManager({ id: admin.organisationId }, { permissions: 'all', label: 'aprtformer', platformAdmin: true });
    await owner.query(`UPDATE core.platform_admin SET revoked_at = now(), revoked_by = $2 WHERE user_id = $1`, [former.userId, admin.userId]);
    const after = await http().get('/rest/v1/admin/platform-admins').set(bearer(adminToken));
    expect(after.body.map((a: { userId: string }) => a.userId)).not.toContain(former.userId);
  });

  it('environment view: secrets, URLs and hosts are Set / Not set only — planted values never appear', async () => {
    overrides.APP_SECRET = 'planted-app-secret-0123456789abcdef';
    overrides.DATABASE_URL = 'postgres://planted_user:planted_pw@planted-db-host.internal:5432/rab';
    overrides.S3_ENDPOINT = 'https://planted-s3-host.internal';
    overrides.EMAIL_SMTP_HOST = 'planted-smtp-host.internal';
    overrides.EMAIL_FROM_ADDRESS = 'https://planted-from-url.internal/x';
    overrides.S3_BUCKET = 'planted-bucket';
    const res = await http().get('/rest/v1/admin/config/environment').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    for (const planted of ['planted-app-secret', 'planted_pw', 'planted_user', 'planted-db-host', 'planted-s3-host', 'planted-smtp-host', 'planted-from-url']) expect(raw).not.toContain(planted);
    const row = (key: string) => res.body.find((r: { key: string }) => r.key === key);
    expect(row('APP_SECRET')).toMatchObject({ state: 'set', value: null });
    expect(row('DATABASE_URL')).toMatchObject({ state: 'set', value: null });
    expect(row('EMAIL_FROM_ADDRESS')).toMatchObject({ state: 'set', value: null });
    expect(row('S3_BUCKET')).toMatchObject({ state: 'value', value: 'planted-bucket' });
    expect(row('NODE_ENV')).toMatchObject({ state: 'value', value: 'test' });
  });

  it('security view: switch states + key ids only — never the signing secret', async () => {
    const res = await http().get('/rest/v1/admin/security').set(bearer(adminToken));
    expect(res.status).toBe(200);
    const secret = app.get(EnvironmentService).get('APP_SECRET');
    expect(JSON.stringify(res.body)).not.toContain(secret);
    expect(res.body.switches.map((s: { variable: string }) => s.variable)).toEqual(expect.arrayContaining(['APP_JWT_LEGACY_VERIFY_ENABLED', 'AUTH_COOKIE_HOST_PREFIX_ENABLED', 'AUTH_MFA_ENROLMENT_ENABLED']));
    for (const k of res.body.signingKeys) expect(k.verified24h).toBeNull();
  });

  it('health probes: bounded at 2 s, fixed detail text — a hung or failing probe never leaks its error text', async () => {
    const files = app.get(FileService);
    await throttlerRedis.client.del(ADMIN_HEALTH_CACHE_KEY);
    const failing = jest.spyOn(files, 'healthProbe').mockRejectedValueOnce(new Error('ECONNREFUSED planted-storage-host.internal:9000 key=planted-key'));
    let res = await http().get('/rest/v1/admin/health/report').set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/planted|ECONNREFUSED/);
    expect(res.body.cards.find((c: { key: string }) => c.key === 'storage')).toMatchObject({ status: 'unavailable', detail: 'Not reachable.' });
    failing.mockRestore();
    await throttlerRedis.client.del(ADMIN_HEALTH_CACHE_KEY);
    const hung = jest.spyOn(files, 'healthProbe').mockImplementationOnce(() => new Promise<void>(() => undefined));
    const started = Date.now();
    res = await http().get('/rest/v1/admin/health/report').set(bearer(adminToken));
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(res.body.cards.find((c: { key: string }) => c.key === 'storage')).toMatchObject({ status: 'unavailable', detail: 'No answer within 2 seconds.' });
    hung.mockRestore();
    // Cached for 10 s: a second read does not probe again.
    const spy = jest.spyOn(files, 'healthProbe');
    await http().get('/rest/v1/admin/health/report').set(bearer(adminToken));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await throttlerRedis.client.del(ADMIN_HEALTH_CACHE_KEY);
  });

  it('send test email to me: the configured (test: Logger) driver, the admin\'s own address only, masked in the reply, audited', async () => {
    const res = await http().post('/rest/v1/admin/config/email/test').set(bearer(adminToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sent: true, driver: 'LOGGER' });
    expect(res.body.to).not.toBe(admin.email);
    expect((await http().post('/rest/v1/admin/config/email/test').set(bearer(adminToken)).send({ to: 'someone-else@example.test' })).status).toBe(400);
    const [audit] = await owner.query(`SELECT target_user_id FROM core.audit_log WHERE actor_user_id = $1 AND action = 'admin.test_email_sent' ORDER BY created_at DESC LIMIT 1`, [admin.userId]);
    expect(audit).toEqual({ target_user_id: admin.userId });
  });

  it('audit timeline: admin actions only, ≤50 per page, tampered cursor 400, action outside the allowlist 400', async () => {
    const res = await http().get(`/rest/v1/admin/audit?user=${target.userId}`).set(bearer(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { action: string }) => i.action)).toEqual(expect.arrayContaining(['admin.sessions_revoked']));
    expect(res.body.items.length).toBeLessThanOrEqual(50);
    expect((await http().get('/rest/v1/admin/audit?cursor=not-a-real-cursor!').set(bearer(adminToken))).status).toBe(400);
    expect((await http().get(`/rest/v1/admin/audit?cursor=${Buffer.from('2026-01-01T00:00:00.000Z|x').toString('base64url')}`).set(bearer(adminToken))).status).toBe(400);
    expect((await http().get('/rest/v1/admin/audit?action=user.created').set(bearer(adminToken))).status).toBe(400);
    expect((await http().get('/rest/v1/admin/audit?limit=51').set(bearer(adminToken))).status).toBe(400);
  });

  it('workspaces + overview + migrations: counts, safe error labels, keyset cursor', async () => {
    const overview = await http().get('/rest/v1/admin/overview').set(bearer(adminToken));
    expect(overview.status).toBe(200);
    expect(overview.body.organisations.total).toBeGreaterThanOrEqual(2);
    const migrations = await http().get('/rest/v1/admin/migrations').set(bearer(adminToken));
    expect(migrations.body).toMatchObject({ applied: expect.any(Number), latest: expect.any(String) });
    expect(migrations.body.applied).toBeGreaterThan(200);
    const list = await http().get(`/rest/v1/admin/workspaces?organisationId=${target.organisationId}`).set(bearer(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.items.map((w: { workspaceId: string }) => w.workspaceId)).toContain(target.workspaceId);
    expect((await http().get('/rest/v1/admin/workspaces?status=BOGUS').set(bearer(adminToken))).status).toBe(400);
  });

  it('reactivate + maintenance carry the admin\'s reason onto the audit row', async () => {
    const org = await factory.createOrganisation('aproutes-susp');
    const [{ slug }] = await owner.query(`SELECT slug FROM core.organisation WHERE id = $1`, [org.id]);
    const token = await factory.login(admin, { applicationTarget: 'manager_web' });
    expect((await http().post(`/rest/v1/admin/organisations/${org.id}/suspend`).set(bearer(token)).send({ reason: 'test suspend', confirmSlug: slug, currentPassword: admin.password })).status).toBe(201);
    expect((await http().post(`/rest/v1/admin/organisations/${org.id}/reactivate`).set(bearer(token)).send({ currentPassword: admin.password, reason: 'Contract renewed' })).status).toBe(200);
    const [row] = await owner.query(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'organisation.reactivated' AND entity_id = $1`, [org.id]);
    expect(row.reason).toBe('Contract renewed');
    expect((await http().post(`/rest/v1/admin/organisations/${org.id}/reactivate`).set(bearer(token)).send({ currentPassword: admin.password, reason: 'ab' })).status).toBe(400);
    const on = await http().patch('/rest/v1/admin/config/maintenance-mode').set(bearer(token)).send({ enabled: true, reason: 'Planned upgrade' });
    expect(on.status).toBe(200);
    const off = await http().patch('/rest/v1/admin/config/maintenance-mode').set(bearer(token)).send({ enabled: false, reason: 'Upgrade done' });
    expect(off.status).toBe(200);
    const reasons = await owner.query(
      `SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'platform_config.maintenance_mode_changed' AND actor_user_id = $1 ORDER BY created_at DESC LIMIT 2`,
      [admin.userId],
    );
    expect(reasons.map((r: { reason: string }) => r.reason).sort()).toEqual(['Planned upgrade', 'Upgrade done']);
  });
});
