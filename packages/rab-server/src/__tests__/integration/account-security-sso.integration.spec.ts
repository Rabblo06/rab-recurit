import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createAdminDataSource } from './helpers/admin-datasource';
import { codeAt, earlyInStep, secretFromOtpauth } from './helpers/mfa-test-kit';
import { MockAccount, MockOidcProvider } from './helpers/mock-oidc-provider';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Account security step 1 — Google / Microsoft: (#7) an enrolled account signing in with a provider is verified, and
 * (P6) SSO re-authentication as the step-up proof for an account that may have NO password, through the REAL routes and
 * the REAL openid-client validation against a local deterministic OpenID provider (mock-oidc-provider.ts). The REAL
 * second-factor policy is used (no override). Handoff mode on.
 *
 * P6 denials covered: wrong identity, unlinked identity, stale / missing / future auth_time, replayed state, open-redirect
 * attempts, a different session (or none) at the callback, Google (cannot guarantee auth_time) refused, missing/evil
 * Origin, and "re-auth never signs anyone in". #16 for SSO-only accounts: turning 2FA off needs a fresh re-auth + code.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const GOOGLE_CLIENT = 'google-test-client';
const GOOGLE_SECRET = 'google-test-secret';
const MS_CLIENT = 'microsoft-test-client';
const MS_SECRET = 'microsoft-test-secret';
const ORIGIN = 'http://localhost:5173';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describeIfDb('account security step 1 — provider sign-in is verified; SSO re-authentication step-up (integration, mock OIDC)', () => {
  jest.setTimeout(300_000);

  const google = new MockOidcProvider(GOOGLE_CLIENT, GOOGLE_SECRET);
  const microsoft = new MockOidcProvider(MS_CLIENT, MS_SECRET);
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let appUrl: string;
  let redisGet: (key: string) => Promise<string | null>;
  let redisDel: (key: string) => Promise<unknown>;

  const http = () => request(app.getHttpServer());
  const cookieValue = (res: request.Response, name: string): string | undefined => {
    const line = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).split(';')[0];
    return value || undefined;
  };
  const isLiveCookie = (res: request.Response, name: string) =>
    ([] as string[]).concat(res.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${name}=`) && !/Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c) && c.slice(name.length + 1).split(';')[0] !== '');

  // ---------------------------------------------------------------- provider helpers

  type Provider = 'google' | 'microsoft';
  const idp = (p: Provider) => (p === 'google' ? google : microsoft);
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function msAccount(who: Pick<TestIdentity, 'email'>, ids: { tid: string; oid: string }, extra: Record<string, unknown> = {}): MockAccount {
    return { sub: randomUUID(), email: who.email, extra: { tid: ids.tid, oid: ids.oid, xms_edov: true, ...extra } };
  }

  /** Full provider sign-in (start → callback → handoff complete). Returns the completion response. */
  async function providerSignIn(p: Provider, account: MockAccount) {
    const started = await http().get(`/rest/v1/auth/${p}`);
    expect(started.status).toBe(302);
    const tx = cookieValue(started, 'crewflow_oauth_tx')!;
    const { code, state } = idp(p).issueCode(started.headers.location, account);
    const cb = await http().get(`/rest/v1/auth/${p}/callback`).query({ code, state }).set('Cookie', `crewflow_oauth_tx=${tx}`);
    const handoff = cookieValue(cb, 'crewflow_oauth_handoff');
    expect(handoff).toBeDefined();
    return http().post('/rest/v1/auth/oauth/complete').set('Origin', ORIGIN).set('Cookie', `crewflow_oauth_handoff=${handoff}`).send({});
  }

  async function ssoSession(p: Provider, account: MockAccount): Promise<string> {
    const done = await providerSignIn(p, account);
    if (done.status !== 200) throw new Error(`provider sign-in returned ${done.status} ${JSON.stringify(done.body)}`);
    return cookieValue(done, 'crewflow_session')!;
  }

  const sessionIdOf = async (sessionCookie: string) =>
    (await owner.query(`SELECT id FROM core.user_session WHERE web_session_token_hash = $1`, [sha256(sessionCookie)]))[0].id as string;
  const grantKey = (sid: string) => `crewflow:test:step-up:${sha256(sid)}`;
  const grantOf = async (sessionCookie: string) => {
    const raw = await redisGet(grantKey(await sessionIdOf(sessionCookie)));
    return raw ? (JSON.parse(raw) as { u: string; mfa: boolean; at: number; via?: string }) : null;
  };
  const expireGrant = async (sessionCookie: string) => redisDel(grantKey(await sessionIdOf(sessionCookie)));

  const withSession = (req: request.Test, sessionCookie: string, extraCookie = '') => req.set('Origin', ORIGIN).set('Cookie', [`crewflow_session=${sessionCookie}`, extraCookie].filter(Boolean).join('; '));

  async function startReauth(p: Provider, sessionCookie: string, body: Record<string, string> = {}, origin: string | null = ORIGIN) {
    const req = http().post(`/rest/v1/auth/${p}/reauthenticate`).type('form');
    if (origin) req.set('Origin', origin);
    return req.set('Cookie', `crewflow_session=${sessionCookie}`).send(body);
  }

  /** Completes a started re-auth at the provider as `account`; `sessionCookie: null` = the callback carries no session. */
  async function finishReauth(started: request.Response, account: MockAccount, sessionCookie: string | null) {
    const tx = cookieValue(started, 'crewflow_oauth_tx')!;
    const { code, state } = microsoft.issueCode(started.headers.location, account);
    const cookies = [`crewflow_oauth_tx=${tx}`, sessionCookie ? `crewflow_session=${sessionCookie}` : ''].filter(Boolean).join('; ');
    const res = await http().get('/rest/v1/auth/microsoft/callback').query({ code, state }).set('Cookie', cookies);
    return { res, tx, code, state };
  }

  const failures = async (userId: string, reason: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = 'auth.sso_reauth_failed' AND target_user_id = $1 AND metadata->>'reason' = $2`, [userId, reason]))[0].n as number;
  const liveSessions = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].n as number;

  /** A manager whose ONLY credential is a linked Microsoft identity (no password), signed in through Microsoft. */
  async function ssoOnlyManager(label: string, opts: { platformAdmin?: boolean } = {}) {
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label, firstIsPlatformAdmin: opts.platformAdmin });
    const who = seeded.managers[0]!;
    await owner.query(`UPDATE core.organisation SET google_auth_enabled = true, microsoft_auth_enabled = true WHERE id = $1`, [seeded.organisation.id]);
    await owner.query(`UPDATE core."user" SET password_hash = NULL WHERE id = $1`, [who.userId]);
    const ids = { tid: randomUUID(), oid: randomUUID() };
    const account = msAccount(who, ids);
    const session = await ssoSession('microsoft', account);
    return { ...seeded, who, account, ids, session };
  }

  // ---------------------------------------------------------------- lifecycle

  beforeAll(async () => {
    process.env.AUTH_GOOGLE_ISSUER_URL = await google.start();
    process.env.AUTH_MICROSOFT_ISSUER_URL = await microsoft.start();
    process.env.AUTH_GOOGLE_CLIENT_ID = GOOGLE_CLIENT;
    process.env.AUTH_GOOGLE_CLIENT_SECRET = GOOGLE_SECRET;
    process.env.AUTH_MICROSOFT_CLIENT_ID = MS_CLIENT;
    process.env.AUTH_MICROSOFT_CLIENT_SECRET = MS_SECRET;
    process.env.AUTH_OAUTH_HANDOFF_ENABLED = 'true';
    // The environment is validated when AppModule is first evaluated, so it is imported only now.
    const { AppModule } = await import('../../app.module');
    const { TenantContextService } = await import('../../engine/core-modules/tenant/tenant-context.service');
    const { PasswordHashingService } = await import('../../engine/core-modules/auth/services/password-hashing.service');
    const { EnvironmentService } = await import('../../engine/core-modules/environment/environment.service');
    const { AuthCacheRedisClientProvider } = await import('../../engine/core-modules/auth/services/auth-cache-redis-client.provider');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    appUrl = moduleRef.get(EnvironmentService).get('APP_URL');
    const redis = moduleRef.get(AuthCacheRedisClientProvider);
    redisGet = (key) => redis.client.get(key);
    redisDel = (key) => redis.client.del(key);
    const [{ present }] = await owner.query(`SELECT to_regclass('core.oauth_transaction_state') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'oauth_transaction_state' AND column_name = 'reauth_session_hash') AS present`);
    if (!present) throw new Error('apply OAuthReauthenticateIntent1786720030000 before running this suite');
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
    await google.stop();
    await microsoft.stop();
  });

  // ---------------------------------------------------------------- #7

  it('#7: an ENROLLED account signing in with Microsoft or Google gets 409 SECOND_FACTOR_REQUIRED at completion — no session until the code', async () => {
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ass1' });
    const who = seeded.managers[0]!;
    await owner.query(`UPDATE core.organisation SET google_auth_enabled = true, microsoft_auth_enabled = true WHERE id = $1`, [seeded.organisation.id]);
    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: who.email, password: who.password });
    const token = login.body.accessToken as string;
    const started = await http().post('/rest/v1/auth/mfa/enrolment').set('Authorization', `Bearer ${token}`).send({ currentPassword: who.password });
    const secret = secretFromOtpauth(started.body.otpauthUri);
    await earlyInStep(8);
    expect((await http().post('/rest/v1/auth/mfa/enrolment/confirm').set('Authorization', `Bearer ${token}`).send({ code: codeAt(secret, -1) })).status).toBe(200);

    const ms = msAccount(who, { tid: randomUUID(), oid: randomUUID() });
    const g: MockAccount = { sub: `g-${randomUUID()}`, email: who.email, email_verified: true };
    for (const [p, account, step] of [['microsoft', ms, 0], ['google', g, 1]] as const) {
      const before = await liveSessions(who.userId);
      const done = await providerSignIn(p, account);
      expect({ p, status: done.status, code: done.body.code, requirement: done.body.requirement }).toEqual({ p, status: 409, code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
      expect(isLiveCookie(done, 'crewflow_session')).toBe(false);
      expect(await liveSessions(who.userId)).toBe(before);
      // The first-time provider link is written only once the factor is proven.
      expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE user_id = $1 AND provider = $2`, [who.userId, p])).toHaveLength(0);
      const verified = await http().post('/rest/v1/auth/mfa/challenge/verify').set('Origin', ORIGIN).send({ challengeToken: done.body.challengeToken, code: codeAt(secret, step) });
      expect(verified.status).toBe(200);
      expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE user_id = $1 AND provider = $2`, [who.userId, p])).toHaveLength(1);
    }
  });

  // ---------------------------------------------------------------- P6 happy path + #16 SSO-only

  it('P6 / #16: an SSO-only account proves itself with a forced Microsoft re-authentication (prompt=login, max_age=0, fresh auth_time, linked identity) — then enrols, and turning 2FA off needs a fresh re-auth AND a code', async () => {
    const { who, account, session } = await ssoOnlyManager('ass2');
    const status = await withSession(http().get('/rest/v1/auth/mfa'), session);
    expect(status.body).toMatchObject({ hasPassword: false, linkedProviders: ['microsoft'], ssoReauthProviders: ['microsoft'], enabled: false });

    // A fresh SSO sign-in counts for an account WITHOUT a password (trade-off, see report); once it is older, it does not.
    await expireGrant(session);
    const stale = await withSession(http().post('/rest/v1/auth/mfa/enrolment'), session).send({});
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe('STEP_UP_REQUIRED');

    const sessionsBefore = await liveSessions(who.userId);
    const identitiesBefore = (await owner.query(`SELECT count(*)::int AS n FROM core.user_auth_identity WHERE user_id = $1`, [who.userId]))[0].n;
    const started = await startReauth('microsoft', session, { returnTo: '/settings/account' });
    expect(started.status).toBe(302);
    const url = new URL(started.headers.location);
    expect(url.origin).toBe(new URL(process.env.AUTH_MICROSOFT_ISSUER_URL!).origin);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const [tx] = await owner.query(`SELECT intent, reauth_user_id, reauth_session_hash, handoff_token_hash FROM core.oauth_transaction_state WHERE id = $1`, [url.searchParams.get('state')]);
    expect(tx).toEqual({ intent: 'reauthenticate', reauth_user_id: who.userId, reauth_session_hash: sha256(await sessionIdOf(session)), handoff_token_hash: null });

    const { res } = await finishReauth(started, { ...account, extra: { ...account.extra, auth_time: nowSeconds() } }, session);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${appUrl}/settings/account?reauth=ok`);
    // Never a sign-in: no session / refresh / handoff cookie, no new session row, no new link.
    for (const name of ['crewflow_session', 'rab_rt', 'crewflow_oauth_handoff']) expect(isLiveCookie(res, name)).toBe(false);
    expect(await liveSessions(who.userId)).toBe(sessionsBefore);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_auth_identity WHERE user_id = $1`, [who.userId]))[0].n).toBe(identitiesBefore);
    expect(await grantOf(session)).toMatchObject({ u: who.userId, mfa: false, via: 'sso_reauth' });

    const enrol = await withSession(http().post('/rest/v1/auth/mfa/enrolment'), session).send({});
    expect(enrol.status).toBe(200);
    const secret = secretFromOtpauth(enrol.body.otpauthUri);
    await earlyInStep(6);
    const confirmed = await withSession(http().post('/rest/v1/auth/mfa/enrolment/confirm'), session).send({ code: codeAt(secret, -1) });
    expect(confirmed.status).toBe(200);
    // From now on every Microsoft sign-in of this account is verified (#7 for an SSO-only account).
    expect((await providerSignIn('microsoft', account)).body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });

    // #16 SSO-only: turning off needs a FRESH re-auth (grant) AND a current code.
    await expireGrant(session);
    expect((await withSession(http().post('/rest/v1/auth/mfa/disable'), session).send({ code: codeAt(secret, 0) })).body.code).toBe('STEP_UP_REQUIRED');
    const again = await startReauth('microsoft', session);
    expect((await finishReauth(again, { ...account, extra: { ...account.extra, auth_time: nowSeconds() } }, session)).res.headers.location).toBe(`${appUrl}/settings/account?reauth=ok`);
    expect((await withSession(http().post('/rest/v1/auth/mfa/disable'), session).send({})).body.code).toBe('STEP_UP_MFA_INVALID');
    expect((await owner.query(`SELECT totp_enabled FROM core."user" WHERE id = $1`, [who.userId]))[0].totp_enabled).toBe(true);
    const off = await withSession(http().post('/rest/v1/auth/mfa/disable'), session).send({ code: codeAt(secret, 0) });
    expect(off.status).toBe(204);
    const [row] = await owner.query(`SELECT totp_enabled, totp_secret_encrypted, totp_last_used_step FROM core."user" WHERE id = $1`, [who.userId]);
    expect(row).toEqual({ totp_enabled: false, totp_secret_encrypted: null, totp_last_used_step: null });
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1`, [who.userId]))[0].n).toBe(0);
  });

  it('P6: for an ENROLLED SSO-only account the re-auth grant alone does not pass a gated action — the code completes it via POST /auth/step-up (never without the re-auth)', async () => {
    const { who, account, session } = await ssoOnlyManager('ass3');
    const enrol = await withSession(http().post('/rest/v1/auth/mfa/enrolment'), session).send({}); // fresh SSO sign-in grant, no password
    expect(enrol.status).toBe(200);
    const secret = secretFromOtpauth(enrol.body.otpauthUri);
    await earlyInStep(6);
    expect((await withSession(http().post('/rest/v1/auth/mfa/enrolment/confirm'), session).send({ code: codeAt(secret, -1) })).status).toBe(200);
    const roleBody = () => ({ name: `SSO ${randomUUID().slice(0, 6)}`, assignableToMembers: true, readAllObjects: false, objects: [] });

    await expireGrant(session);
    // No re-auth yet: a code alone is no step-up.
    expect((await withSession(http().post('/rest/v1/auth/step-up'), session).send({ code: codeAt(secret, 0) })).status).toBe(403);
    const started = await startReauth('microsoft', session);
    await finishReauth(started, { ...account, extra: { ...account.extra, auth_time: nowSeconds() } }, session);
    const refused = await withSession(http().post('/rest/v1/roles'), session).send(roleBody());
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'STEP_UP_REQUIRED', mfa: true });
    const before = (await grantOf(session))!;
    const stepped = await withSession(http().post('/rest/v1/auth/step-up'), session).send({ code: codeAt(secret, 0) });
    expect(stepped.status).toBe(200);
    expect(stepped.body.mfa).toBe(true);
    const after = (await grantOf(session))!;
    expect(after).toMatchObject({ mfa: true, via: 'sso_reauth', at: before.at }); // upgraded, never extended
    expect((await withSession(http().post('/rest/v1/roles'), session).send(roleBody())).status).toBe(201);
    void who;
  });

  // ---------------------------------------------------------------- P6 denials

  it('P6 (abuse): a DIFFERENT identity at the provider (another user\'s, or an unlinked one) is refused, audited, and grants nothing', async () => {
    const victim = await ssoOnlyManager('ass4a');
    const other = await ssoOnlyManager('ass4b');
    await expireGrant(victim.session);
    for (const [label, account] of [
      ['another user\'s linked identity', { ...other.account, extra: { ...other.account.extra, auth_time: nowSeconds() } }],
      ['an unlinked identity', msAccount(victim.who, { tid: randomUUID(), oid: randomUUID() }, { auth_time: nowSeconds() })],
      ['same tenant, other object id', msAccount(victim.who, { tid: victim.ids.tid, oid: randomUUID() }, { auth_time: nowSeconds() })],
    ] as Array<[string, MockAccount]>) {
      const { res } = await finishReauth(await startReauth('microsoft', victim.session), account, victim.session);
      expect({ label, location: res.headers.location }).toEqual({ label, location: `${appUrl}/settings/account?reauth=failed` });
      expect(await grantOf(victim.session)).toBeNull();
    }
    expect(await failures(victim.who.userId, 'identity_mismatch')).toBe(3);
    expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE user_id = $1 AND provider_subject <> $2`, [victim.who.userId, `${victim.ids.tid}:${victim.ids.oid}`])).toHaveLength(0);
  });

  it('P6 (abuse): auth_time is REQUIRED and must be fresh — missing, stale (before the transaction) or in the future is refused', async () => {
    const { who, account, session } = await ssoOnlyManager('ass5');
    await expireGrant(session);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['auth_time_missing', {}],
      ['auth_time_stale', { auth_time: nowSeconds() - 10 * 60 }],
      ['auth_time_future', { auth_time: nowSeconds() + 10 * 60 }],
    ];
    for (const [reason, extra] of cases) {
      const base = { ...account, extra: { tid: (account.extra as { tid: string }).tid, oid: (account.extra as { oid: string }).oid, xms_edov: true, ...extra } };
      const { res } = await finishReauth(await startReauth('microsoft', session), base, session);
      expect({ reason, location: res.headers.location }).toEqual({ reason, location: `${appUrl}/settings/account?reauth=failed` });
      expect(await failures(who.userId, reason)).toBe(1);
      expect(await grantOf(session)).toBeNull();
    }
  });

  it('P6 (abuse): a replayed state (second callback for the same transaction) is refused generically and records nothing new', async () => {
    const { account, session } = await ssoOnlyManager('ass6');
    await expireGrant(session);
    const started = await startReauth('microsoft', session);
    const fresh = { ...account, extra: { ...account.extra, auth_time: nowSeconds() } };
    const first = await finishReauth(started, fresh, session);
    expect(first.res.headers.location).toBe(`${appUrl}/settings/account?reauth=ok`);
    const granted = (await grantOf(session))!;
    await new Promise((r) => setTimeout(r, 1100));
    // The attacker replays the same state with a brand-new code from the provider and the same browser binding.
    const { code } = microsoft.issueCode(started.headers.location, fresh);
    const replay = await http().get('/rest/v1/auth/microsoft/callback').query({ code, state: first.state }).set('Cookie', `crewflow_oauth_tx=${first.tx}; crewflow_session=${session}`);
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe(`${appUrl}/login?oauthError=1`);
    expect(await grantOf(session)).toEqual(granted); // not refreshed, not extended
  });

  it('P6 (abuse): the return URL is a fixed same-origin allowlist — absolute, protocol-relative, scheme and unknown paths all land on the default', async () => {
    const { account, session } = await ssoOnlyManager('ass7');
    for (const [returnTo, expected] of [
      ['https://evil.example/steal', '/settings/account'],
      ['//evil.example', '/settings/account'],
      ['/\\evil.example', '/settings/account'],
      ['javascript:alert(1)', '/settings/account'],
      ['/settings/account?next=https://evil.example', '/settings/account'],
      ['/shifts', '/settings/account'],
      ['/settings/admin', '/settings/admin'],
    ]) {
      const started = await startReauth('microsoft', session, { returnTo });
      const [tx] = await owner.query(`SELECT return_to_path FROM core.oauth_transaction_state WHERE id = $1`, [new URL(started.headers.location).searchParams.get('state')]);
      expect({ returnTo, stored: tx.return_to_path }).toEqual({ returnTo, stored: expected });
      const { res } = await finishReauth(started, { ...account, extra: { ...account.extra, auth_time: nowSeconds() } }, session);
      expect({ returnTo, location: res.headers.location }).toEqual({ returnTo, location: `${appUrl}${expected}?reauth=ok` });
    }
  });

  it('P6 (abuse): the callback must present the SAME session the re-auth was started for — another session of the same user, or none, grants nothing', async () => {
    const { who, account, session } = await ssoOnlyManager('ass8');
    const second = await ssoSession('microsoft', account);
    await expireGrant(session);
    await expireGrant(second);
    const fresh = () => ({ ...account, extra: { ...account.extra, auth_time: nowSeconds() } });
    expect((await finishReauth(await startReauth('microsoft', session), fresh(), second)).res.headers.location).toBe(`${appUrl}/settings/account?reauth=failed`);
    expect((await finishReauth(await startReauth('microsoft', session), fresh(), null)).res.headers.location).toBe(`${appUrl}/settings/account?reauth=failed`);
    expect(await grantOf(session)).toBeNull();
    expect(await grantOf(second)).toBeNull();
    expect(await failures(who.userId, 'session_mismatch')).toBe(1);
    expect(await failures(who.userId, 'session_missing')).toBe(1);
  });

  it('P6: Google re-auth is refused (it cannot guarantee auth_time) and an unlinked provider is refused — both audited, no transaction; the start needs a trusted Origin', async () => {
    const { who, session } = await ssoOnlyManager('ass9');
    const statesBefore = (await owner.query(`SELECT count(*)::int AS n FROM core.oauth_transaction_state WHERE reauth_user_id = $1`, [who.userId]))[0].n;
    const g = await startReauth('google', session, { returnTo: '/settings/profile' });
    expect(g.status).toBe(302);
    expect(g.headers.location).toBe(`${appUrl}/settings/profile?reauth=failed`);
    expect(cookieValue(g, 'crewflow_oauth_tx')).toBeUndefined();
    expect(await failures(who.userId, 'provider_unsupported')).toBe(1);

    const passwordUser = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ass9p' })).managers[0]!;
    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: passwordUser.email, password: passwordUser.password });
    const pwSession = cookieValue(login, 'crewflow_session')!;
    expect((await startReauth('microsoft', pwSession)).headers.location).toBe(`${appUrl}/settings/account?reauth=failed`);
    expect(await failures(passwordUser.userId, 'identity_mismatch')).toBe(1);

    // CSRF: a cookie-authenticated start without a trusted Origin never reaches the provider.
    expect((await startReauth('microsoft', session, {}, null)).status).toBe(403);
    expect((await startReauth('microsoft', session, {}, 'https://evil.example')).status).toBe(403);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.oauth_transaction_state WHERE reauth_user_id = $1`, [who.userId]))[0].n).toBe(statesBefore);
  });

  it('P4 via P6: an SSO-only platform administrator can reset another account\'s factor after a fresh Microsoft re-authentication (never forced to have a password or enrol)', async () => {
    const { who: admin, account, session } = await ssoOnlyManager('ass10', { platformAdmin: true });
    const target = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ass10t' })).managers[0]!;
    const login = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: target.email, password: target.password });
    const started = await http().post('/rest/v1/auth/mfa/enrolment').set('Authorization', `Bearer ${login.body.accessToken}`).send({ currentPassword: target.password });
    await earlyInStep(8);
    expect((await http().post('/rest/v1/auth/mfa/enrolment/confirm').set('Authorization', `Bearer ${login.body.accessToken}`).send({ code: codeAt(secretFromOtpauth(started.body.otpauthUri), -1) })).status).toBe(200);

    await expireGrant(session);
    expect((await withSession(http().post(`/rest/v1/admin/users/${target.userId}/mfa/reset`), session).send({ reason: 'lost phone' })).body.code).toBe('STEP_UP_REQUIRED');
    await finishReauth(await startReauth('microsoft', session, { returnTo: '/settings/admin' }), { ...account, extra: { ...account.extra, auth_time: nowSeconds() } }, session);
    const reset = await withSession(http().post(`/rest/v1/admin/users/${target.userId}/mfa/reset`), session).send({ reason: 'lost phone' });
    expect(reset.status).toBe(200);
    expect(reset.body.reset).toBe(true);
    expect((await owner.query(`SELECT totp_enabled FROM core."user" WHERE id = $1`, [target.userId]))[0].totp_enabled).toBe(false);
    void admin;
  });
});
