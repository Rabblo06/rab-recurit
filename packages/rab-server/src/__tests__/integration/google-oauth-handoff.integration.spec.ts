import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { createAdminDataSource } from './helpers/admin-datasource';
import { MockAccount, MockOidcProvider, Tamper } from './helpers/mock-oidc-provider';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Google (and Microsoft) sign-in through the REAL HTTP routes and the REAL openid-client validation, against a local
 * deterministic OpenID provider (mock-oidc-provider.ts) — never real Google. Handoff mode (AUTH_OAUTH_HANDOFF_ENABLED).
 *
 * Covers: browser binding (login CSRF), one-time state, PKCE / nonce / signature / issuer / audience validation,
 * email_verified, identity resolution and linking (incl. races and ambiguity), organisation provider settings,
 * account status, workspace membership re-validation, the one-time handoff (replay, concurrency, expiry, Origin),
 * Google invitation acceptance, session issuance and supersession, and the Microsoft verified-email rule (nOAuth).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

const GOOGLE_CLIENT = 'google-test-client';
const GOOGLE_SECRET = 'google-test-secret';
const MS_CLIENT = 'microsoft-test-client';
const MS_SECRET = 'microsoft-test-secret';
const ORIGIN = 'http://localhost:5173';

describeIfDb('Google / Microsoft sign-in with one-time handoff (integration, mock OIDC provider)', () => {
  jest.setTimeout(180_000);

  const google = new MockOidcProvider(GOOGLE_CLIENT, GOOGLE_SECRET);
  const microsoft = new MockOidcProvider(MS_CLIENT, MS_SECRET);
  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let managerA: TestIdentity;
  let managerB: TestIdentity;
  let tokenA: string;
  let orgId: string;
  let secondFactor: (...args: unknown[]) => Promise<'none' | 'verify' | 'enroll'> = async () => 'none';
  /** managerA's one stable Google identity (a different subject for the same account is correctly refused). */
  let googleA: MockAccount;

  const http = () => request(app.getHttpServer());
  const cookieValue = (res: request.Response, name: string): string | undefined => {
    const all = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const line = all.find((c) => c.startsWith(`${name}=`));
    if (!line) return undefined;
    const value = line.slice(name.length + 1).split(';')[0]!;
    return value || undefined;
  };
  const setCookieLine = (res: request.Response, name: string) => ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  const account = (identity: Pick<TestIdentity, 'email'>, over: Partial<MockAccount> = {}): MockAccount => ({
    sub: `g-${randomUUID()}`,
    email: identity.email,
    email_verified: true,
    given_name: 'Grace',
    family_name: 'Hopper',
    ...over,
  });

  async function start(provider: 'google' | 'microsoft' = 'google', query: Record<string, string> = {}) {
    const res = await http().get(`/rest/v1/auth/${provider}`).query(query);
    expect(res.status).toBe(302);
    const txCookie = cookieValue(res, 'crewflow_oauth_tx');
    expect(txCookie).toBeDefined();
    expect(setCookieLine(res, 'crewflow_oauth_tx')).toMatch(/HttpOnly/i);
    return { location: res.headers.location as string, txCookie: txCookie! };
  }

  async function callback(
    flow: { location: string; txCookie: string },
    who: MockAccount,
    opts: { tamper?: Tamper; cookie?: string | null; provider?: 'google' | 'microsoft'; callbackProvider?: 'google' | 'microsoft' } = {},
  ) {
    const idp = (opts.provider ?? 'google') === 'google' ? google : microsoft;
    const { code, state } = idp.issueCode(flow.location, who, opts.tamper);
    const cookie = opts.cookie === null ? undefined : `crewflow_oauth_tx=${opts.cookie ?? flow.txCookie}`;
    const req = http().get(`/rest/v1/auth/${opts.callbackProvider ?? opts.provider ?? 'google'}/callback`).query({ code, state });
    return cookie ? req.set('Cookie', cookie) : req;
  }

  const handoffOf = (res: request.Response) => cookieValue(res, 'crewflow_oauth_handoff');
  const isError = (res: request.Response) => res.status === 302 && /oauthError=1/.test(res.headers.location ?? '');
  const isHandoff = (res: request.Response) => res.status === 302 && /\/oauth\/callback-complete\?handoff=1$/.test(res.headers.location ?? '');

  async function complete(handoff: string | undefined, extraCookie = '', origin: string | null = ORIGIN) {
    const req = http().post('/rest/v1/auth/oauth/complete');
    if (origin) req.set('Origin', origin);
    const cookies = [handoff ? `crewflow_oauth_handoff=${handoff}` : '', extraCookie].filter(Boolean).join('; ');
    if (cookies) req.set('Cookie', cookies);
    return req.send({});
  }

  async function signIn(who: MockAccount, provider: 'google' | 'microsoft' = 'google') {
    const flow = await start(provider);
    const cb = await callback(flow, who, { provider });
    expect(isHandoff(cb)).toBe(true);
    const done = await complete(handoffOf(cb));
    return { cb, done };
  }

  const me = (sessionCookie: string) => http().get('/rest/v1/auth/me').set('Cookie', `crewflow_session=${sessionCookie}`);
  const lastFailure = async (email: string) =>
    (await owner.query(`SELECT provider, success FROM core.login_history WHERE email = $1 AND success = false ORDER BY created_at DESC LIMIT 1`, [email.toLowerCase()]))[0];

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
    const { LoginSecondFactorPolicyService } = await import('../../engine/core-modules/auth/services/login-second-factor-policy.service');
    // The real policy always answers 'none' (no second factor exists yet); the stub lets T27 prove the gate.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LoginSecondFactorPolicyService)
      .useValue({ requirementFor: (...args: unknown[]) => secondFactor(...args) })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
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
    const redis = new Redis(process.env.REDIS_URL!);
    const keys = await redis.keys('crewflow:test:invite-rate:*');
    if (keys.length) await redis.del(...keys);
    await redis.quit();

    const seeded = await factory.createOrganisationWithManagers(2, { permissions: 'production', workspace: true, label: 'goauth' });
    [managerA, managerB] = seeded.managers as [TestIdentity, TestIdentity];
    orgId = seeded.organisation.id;
    tokenA = await factory.login(managerA);
    googleA = account(managerA);
  });

  afterAll(async () => {
    await app?.close();
    await owner?.destroy();
    await google.stop();
    await microsoft.stop();
  });

  // ─────────────────────────────────────────────── Start and callback validation

  describe('start and callback validation', () => {
    it('start: PKCE S256, nonce, openid email profile, select_account, server-held state, browser-binding cookie', async () => {
      const flow = await start('google', { returnTo: '/shifts' });
      const url = new URL(flow.location);
      expect(url.origin).toBe(new URL(process.env.AUTH_GOOGLE_ISSUER_URL!).origin);
      expect(url.searchParams.get('scope')).toBe('openid email profile');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('prompt')).toBe('select_account');
      const state = url.searchParams.get('state')!;
      expect(state).toMatch(/^[0-9a-f-]{36}$/); // an opaque id — nothing sensitive inlined
      const [row] = await owner.query(`SELECT browser_binding_hash, return_to_path, intent FROM core.oauth_transaction_state WHERE id = $1`, [state]);
      expect(row).toMatchObject({ return_to_path: '/shifts', intent: 'sign_in' });
      expect(row.browser_binding_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.browser_binding_hash).not.toContain(flow.txCookie);
      // Open-redirect protection on the return path.
      for (const evil of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
        const f = await start('google', { returnTo: evil });
        const [r] = await owner.query(`SELECT return_to_path FROM core.oauth_transaction_state WHERE id = $1`, [new URL(f.location).searchParams.get('state')]);
        expect(r.return_to_path).toBe('/');
      }
    });

    it('T1/T2/T28: first sign-in links the verified Google identity; the session is issued only at completion, as HttpOnly cookies; later sign-ins use the link', async () => {
      const who = googleA;
      const flow = await start();
      const cb = await callback(flow, who);
      expect(isHandoff(cb)).toBe(true);
      // No credential anywhere in the redirect; the callback sets NO session cookie.
      expect(cb.headers.location).not.toMatch(/token|session|code=|email/i);
      expect(cookieValue(cb, 'crewflow_session')).toBeUndefined();
      expect(cookieValue(cb, 'rab_rt')).toBeUndefined();
      expect(setCookieLine(cb, 'crewflow_oauth_handoff')).toMatch(/HttpOnly/i);
      expect(setCookieLine(cb, 'crewflow_oauth_handoff')).toMatch(/Path=\/rest\/v1\/auth\/oauth/);
      // Not yet linked: linking happens only when the session is issued.
      expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE provider_subject = $1`, [who.sub])).toHaveLength(0);

      const summary = await http().get('/rest/v1/auth/oauth/handoff').set('Cookie', `crewflow_oauth_handoff=${handoffOf(cb)}`);
      expect(summary.status).toBe(200);
      expect(summary.body).toMatchObject({ intent: 'sign_in', provider: 'google', email: managerA.email, secondFactor: 'none', invitation: null });

      const done = await complete(handoffOf(cb));
      expect(done.status).toBe(200);
      expect(done.body).toEqual({ mustResetPassword: false, returnTo: '/', sessionExpiresAt: expect.any(String) });
      expect(JSON.stringify(done.body)).not.toMatch(/crewflow_sess_|eyJ/); // no tokens in the body
      const session = cookieValue(done, 'crewflow_session')!;
      expect(setCookieLine(done, 'crewflow_session')).toMatch(/HttpOnly/i);
      expect((await me(session)).body.id ?? (await me(session)).body.userId).toBeTruthy();
      expect(await owner.query(`SELECT user_id FROM core.user_auth_identity WHERE provider = 'google' AND provider_subject = $1`, [who.sub])).toEqual([{ user_id: managerA.userId }]);
      const [{ count }] = await owner.query(`SELECT count(*)::int AS count FROM core.user_session WHERE user_id = $1 AND auth_provider = 'google' AND revoked_at IS NULL`, [managerA.userId]);
      expect(count).toBeGreaterThanOrEqual(1);

      // Returning user: the stable subject wins even if the Google email changed.
      const again = await signIn({ ...who, email: 'renamed@example.test' });
      expect(again.done.status).toBe(200);
    });

    it('T3/T4: unknown Google account and unverified Google email are refused generically and audited', async () => {
      const unknown = account({ email: `nobody-${randomUUID().slice(0, 6)}@example.test` });
      const cb1 = await callback(await start(), unknown);
      expect(isError(cb1)).toBe(true);
      expect(handoffOf(cb1)).toBeUndefined();
      expect(await lastFailure(unknown.email)).toEqual({ provider: 'google', success: false });

      const unverified = account(managerB, { email_verified: false });
      const cb2 = await callback(await start(), unverified);
      expect(isError(cb2)).toBe(true);
      expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE provider_subject = $1`, [unverified.sub])).toHaveLength(0);
    });

    it('T6: an organisation with Google sign-in disabled is refused', async () => {
      const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'nogoogle' });
      await owner.query(`UPDATE core.organisation SET google_auth_enabled = false WHERE id = $1`, [org.organisation.id]);
      expect(isError(await callback(await start(), account(org.managers[0]!)))).toBe(true);
    });

    it('T7/T8/T9: expired state, replayed state and a state used on the other provider are refused', async () => {
      const flow = await start();
      await owner.query(`UPDATE core.oauth_transaction_state SET expires_at = now() - interval '1 second', created_at = now() - interval '11 minutes' WHERE id = $1`, [new URL(flow.location).searchParams.get('state')]);
      expect(isError(await callback(flow, account(managerA)))).toBe(true);

      const flow2 = await start();
      const who = account(managerA);
      const { code, state } = google.issueCode(flow2.location, who);
      const first = await http().get('/rest/v1/auth/google/callback').query({ code, state }).set('Cookie', `crewflow_oauth_tx=${flow2.txCookie}`);
      expect(isHandoff(first)).toBe(true);
      const replay = await http().get('/rest/v1/auth/google/callback').query({ code, state }).set('Cookie', `crewflow_oauth_tx=${flow2.txCookie}`);
      expect(isError(replay)).toBe(true);

      const flow3 = await start('google');
      expect(isError(await callback(flow3, account(managerA), { callbackProvider: 'microsoft' }))).toBe(true);
    });

    it('T10–T13: PKCE, nonce, signature, issuer, audience and token-endpoint failures are all refused', async () => {
      const pkce = await start();
      await owner.query(`UPDATE core.oauth_transaction_state SET pkce_code_verifier = $2 WHERE id = $1`, [new URL(pkce.location).searchParams.get('state'), 'x'.repeat(43)]);
      expect(isError(await callback(pkce, account(managerA)))).toBe(true);
      for (const tamper of [{ nonce: 'wrong' }, { foreignKey: true }, { issuer: 'https://evil.example' }, { audience: 'someone-else' }, { expiresInSeconds: -120 }, { tokenError: true }] as Tamper[]) {
        const res = await callback(await start(), account(managerA), { tamper });
        expect({ tamper, error: isError(res) }).toEqual({ tamper, error: true });
      }
    });

    it('T14: login CSRF — a callback finished in a browser that did not start the flow is refused and does not burn the real attempt', async () => {
      const flow = await start();
      const who = account(managerA);
      const { code, state } = google.issueCode(flow.location, who);
      const noCookie = await http().get('/rest/v1/auth/google/callback').query({ code, state });
      expect(isError(noCookie)).toBe(true);
      const other = await start();
      const wrongCookie = await http().get('/rest/v1/auth/google/callback').query({ code, state }).set('Cookie', `crewflow_oauth_tx=${other.txCookie}`);
      expect(isError(wrongCookie)).toBe(true);
      const [row] = await owner.query(`SELECT consumed_at FROM core.oauth_transaction_state WHERE id = $1`, [state]);
      expect(row.consumed_at).toBeNull();
      // The legitimate browser can still finish (with a fresh code — the provider codes are single use).
      const { code: code2 } = google.issueCode(flow.location, who);
      expect(isHandoff(await http().get('/rest/v1/auth/google/callback').query({ code: code2, state }).set('Cookie', `crewflow_oauth_tx=${flow.txCookie}`))).toBe(true);
    });

    it('T15: two concurrent callbacks for one sign-in attempt — exactly one succeeds', async () => {
      const flow = await start();
      const who = account(managerA);
      const a = google.issueCode(flow.location, who);
      const b = google.issueCode(flow.location, who);
      const results = await Promise.all([a, b].map((x) => http().get('/rest/v1/auth/google/callback').query({ code: x.code, state: x.state }).set('Cookie', `crewflow_oauth_tx=${flow.txCookie}`)));
      expect(results.filter(isHandoff)).toHaveLength(1);
      expect(results.filter(isError)).toHaveLength(1);
    });

    it('T16/T17: concurrent first-time linking converges on one link; an email shared by two organisations is ambiguous and refused', async () => {
      const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'race' });
      const who = account(org.managers[0]!);
      const flows = await Promise.all([start(), start()]);
      const cbs = await Promise.all(flows.map((f) => callback(f, who)));
      expect(cbs.every(isHandoff)).toBe(true);
      const done = await Promise.all(cbs.map((cb) => complete(handoffOf(cb))));
      expect(done.map((d) => d.status).sort()).toEqual([200, 200]);
      expect(await owner.query(`SELECT user_id FROM core.user_auth_identity WHERE provider_subject = $1`, [who.sub])).toEqual([{ user_id: org.managers[0]!.userId }]);

      // Same email, two organisations, both eligible: cannot be disambiguated without a password. New accounts can no longer share
      // an address across organisations (EmailUniqueAcrossOrganisationsForNewAccounts), so this models a HISTORICAL duplicate.
      const email = `shared-${randomUUID().slice(0, 6)}@example.test`;
      for (const label of ['amb1', 'amb2']) {
        const o = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label });
        await factory.makeHistoricalDuplicateEmail(o.managers[0]!.userId, email);
      }
      expect(isError(await callback(await start(), account({ email })))).toBe(true);
    });

    it('a different Google account cannot take over an account already linked to another Google subject', async () => {
      const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'relink' });
      const first = account(org.managers[0]!);
      expect((await signIn(first)).done.status).toBe(200);
      const impostor = account(org.managers[0]!); // same verified email, different subject
      const cb = await callback(await start(), impostor);
      // Resolution finds the email candidate; the link write is refused at completion (user already linked for Google).
      const done = isHandoff(cb) ? await complete(handoffOf(cb)) : null;
      expect(isError(cb) || done?.status === 401).toBe(true);
      expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE provider_subject = $1`, [impostor.sub])).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────── Handoff

  describe('one-time handoff', () => {
    it('T24/T25: a handoff is single use — replays and concurrent redemptions get exactly one session', async () => {
      const cb = await callback(await start(), googleA);
      const handoff = handoffOf(cb);
      const results = await Promise.all([complete(handoff), complete(handoff), complete(handoff)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401, 401]);
      expect((await complete(handoff)).status).toBe(401);
      // The provider identity is erased from the row at redemption.
      const [row] = await owner.query(`SELECT provider_email, provider_subject, handoff_consumed_at FROM core.oauth_transaction_state WHERE handoff_token_hash = encode(sha256($1::bytea), 'hex')`, [handoff]);
      expect(row).toMatchObject({ provider_email: null, provider_subject: null });
      expect(row.handoff_consumed_at).not.toBeNull();
    });

    it('T26: an expired, unknown or malformed handoff is refused; Origin is required', async () => {
      const cb = await callback(await start(), account(managerA));
      const handoff = handoffOf(cb)!;
      expect((await complete(handoff, '', null)).status).toBe(403);
      expect((await complete(handoff, '', 'https://evil.example')).status).toBe(403);
      await owner.query(`UPDATE core.oauth_transaction_state SET handoff_expires_at = now() - interval '1 second' WHERE handoff_token_hash = encode(sha256($1::bytea), 'hex')`, [handoff]);
      expect((await complete(handoff)).status).toBe(401);
      expect((await complete('x'.repeat(43))).status).toBe(401);
      expect((await complete('not-a-handoff')).status).toBe(401);
      expect((await complete(undefined)).status).toBe(401);
    });

    it('T21/F4: status and membership are re-validated at completion — suspended between callback and completion ⇒ no session', async () => {
      const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'susp' });
      const who = account(org.managers[0]!);
      expect((await signIn(who)).done.status).toBe(200); // linked now
      const cb = await callback(await start(), who);
      expect(isHandoff(cb)).toBe(true);
      await owner.query(`UPDATE core."user" SET status = 'suspended' WHERE id = $1`, [org.managers[0]!.userId]);
      const before = await owner.query(`SELECT count(*)::int AS c FROM core.user_session WHERE user_id = $1`, [org.managers[0]!.userId]);
      expect((await complete(handoffOf(cb))).status).toBe(401);
      expect(await owner.query(`SELECT count(*)::int AS c FROM core.user_session WHERE user_id = $1`, [org.managers[0]!.userId])).toEqual(before);
      // F4: a LINKED suspended account is refused at the callback too (no session, no USER_LOGIN audit).
      expect(isError(await callback(await start(), who))).toBe(true);
    });

    it('T33/F11: signing in again in the same browser revokes the session it already held; logout revokes the authenticated session (F9)', async () => {
      const who = account(managerB);
      const first = await signIn(who);
      const oldSession = cookieValue(first.done, 'crewflow_session')!;
      expect((await me(oldSession)).status).toBe(200);
      const cb = await callback(await start(), who);
      const second = await complete(handoffOf(cb), `crewflow_session=${oldSession}`);
      expect(second.status).toBe(200);
      expect((await me(oldSession)).status).toBe(401);
      const newSession = cookieValue(second, 'crewflow_session')!;
      expect((await me(newSession)).status).toBe(200);
      // Logout with only the session cookie (no rab_rt) still ends the session server-side.
      expect((await http().post('/rest/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', `crewflow_session=${newSession}`).send({})).status).toBe(204);
      expect((await me(newSession)).status).toBe(401);
    });

    it('T27: a required second factor blocks session issuance BEFORE the handoff is consumed', async () => {
      const cb = await callback(await start(), googleA);
      const handoff = handoffOf(cb);
      secondFactor = async () => 'verify';
      try {
        const summary = await http().get('/rest/v1/auth/oauth/handoff').set('Cookie', `crewflow_oauth_handoff=${handoff}`);
        expect(summary.body.secondFactor).toBe('verify');
        const blocked = await complete(handoff);
        expect(blocked.status).toBe(409);
        expect(blocked.body.code).toBe('SECOND_FACTOR_REQUIRED');
        expect(cookieValue(blocked, 'crewflow_session')).toBeUndefined();
      } finally {
        secondFactor = async () => 'none';
      }
      // Not consumed: once the requirement is satisfied (here: lifted), the same handoff completes.
      expect((await complete(handoff)).status).toBe(200);
    });

    it('cancel abandons the handoff', async () => {
      const cb = await callback(await start(), googleA);
      expect((await http().post('/rest/v1/auth/oauth/cancel').set('Origin', ORIGIN).set('Cookie', `crewflow_oauth_handoff=${handoffOf(cb)}`).send({})).status).toBe(204);
      expect((await complete(handoffOf(cb))).status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────── Workspace members and invitations

  describe('workspace members and Google invitation acceptance', () => {
    let roleId: string;

    async function invite(address: string): Promise<{ id: string; raw: string }> {
      const sent = await http().post('/rest/v1/member-invitations').set('Authorization', `Bearer ${tokenA}`).send({ emails: [address], roleId });
      expect(sent.status).toBe(200);
      const [inv] = await owner.query(`SELECT id FROM core.member_invitation WHERE email = $1 ORDER BY created_at DESC LIMIT 1`, [address]);
      const [mail] = await owner.query(`SELECT rendered_html FROM core.email_outbox WHERE member_invitation_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id]);
      return { id: inv.id, raw: decodeURIComponent(/accept-invitation\?token=([A-Za-z0-9_\-%]+)/.exec(mail.rendered_html as string)![1]!) };
    }

    async function startInvitation(raw: string) {
      const res = await http().post('/rest/v1/auth/google/invitation').type('form').send({ token: raw });
      expect(res.status).toBe(302);
      return { location: res.headers.location as string, txCookie: cookieValue(res, 'crewflow_oauth_tx')! };
    }

    beforeAll(async () => {
      const created = await http()
        .post('/rest/v1/roles')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ name: `Google members ${randomUUID().slice(0, 5)}`, assignableToMembers: true, readAllObjects: false, objects: [{ object: 'staff', read: 'grant' }] });
      expect(created.status).toBe(201);
      roleId = created.body.id;
    });

    it('invitation accepted with Google: confirmation summary, then ONLY the invited membership, a Google link, no password, ACTIVE, signed in', async () => {
      const address = `g-invitee-${randomUUID().slice(0, 6)}@example.test`;
      const inv = await invite(address);
      const flow = await startInvitation(inv.raw);
      const [tx] = await owner.query(`SELECT intent, invitation_token_hash FROM core.oauth_transaction_state WHERE id = $1`, [new URL(flow.location).searchParams.get('state')]);
      expect(tx.intent).toBe('accept_invitation');
      expect(tx.invitation_token_hash).toMatch(/^[0-9a-f]{64}$/);
      const who = account({ email: address }, { given_name: 'Ada', family_name: 'Lovelace' });
      const cb = await callback(flow, who);
      expect(isHandoff(cb)).toBe(true);
      // Not accepted yet: the user confirms first.
      expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [address])).toHaveLength(0);
      const summary = await http().get('/rest/v1/auth/oauth/handoff').set('Cookie', `crewflow_oauth_handoff=${handoffOf(cb)}`);
      expect(summary.body).toMatchObject({ intent: 'accept_invitation', invitation: { email: address, roleLabel: expect.stringMatching(/^Google members/) } });

      const done = await complete(handoffOf(cb));
      expect(done.status).toBe(200);
      const [user] = await owner.query(`SELECT id, status, password_hash, first_name, last_name FROM core."user" WHERE email = $1`, [address]);
      expect(user).toMatchObject({ status: 'active', password_hash: null, first_name: 'Ada', last_name: 'Lovelace' });
      expect(await owner.query(`SELECT provider FROM core.user_auth_identity WHERE user_id = $1`, [user.id])).toEqual([{ provider: 'google' }]);
      expect(await owner.query(`SELECT workspace_id, status FROM core.workspace_membership WHERE user_id = $1`, [user.id])).toEqual([{ workspace_id: managerA.workspaceId, status: 'active' }]);
      expect(await owner.query(`SELECT r.key FROM core.user_role ur JOIN core.role r ON r.id = ur.role_id WHERE ur.user_id = $1`, [user.id])).toEqual([{ key: expect.stringMatching(/^custom_/) }]);
      const [invRow] = await owner.query(`SELECT accepted_user_id FROM core.member_invitation WHERE id = $1`, [inv.id]);
      expect(invRow.accepted_user_id).toBe(user.id);
      expect((await me(cookieValue(done, 'crewflow_session')!)).status).toBe(200);
      // The member's next sign-in uses the link.
      expect((await signIn(who)).done.status).toBe(200);
    });

    it('a different Google email cannot accept (or burn) someone else’s invitation', async () => {
      const address = `g-target-${randomUUID().slice(0, 6)}@example.test`;
      const inv = await invite(address);
      const cb = await callback(await startInvitation(inv.raw), account({ email: `attacker-${randomUUID().slice(0, 4)}@example.test` }));
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toMatch(/\/accept-invitation\?oauthError=1$/);
      const [row] = await owner.query(`SELECT accepted_at, superseded_at, revoked_at FROM core.member_invitation WHERE id = $1`, [inv.id]);
      expect(row).toEqual({ accepted_at: null, superseded_at: null, revoked_at: null });
    });

    it('T22/T23: revoked and expired invitations are refused at the callback; revocation between callback and completion is caught at completion', async () => {
      const revokedAddr = `g-rev-${randomUUID().slice(0, 6)}@example.test`;
      const revoked = await invite(revokedAddr);
      const flowR = await startInvitation(revoked.raw);
      await owner.query(`UPDATE core.member_invitation SET revoked_at = now() WHERE id = $1`, [revoked.id]);
      expect(isError(await callback(flowR, account({ email: revokedAddr })))).toBe(true);

      const expiredAddr = `g-exp-${randomUUID().slice(0, 6)}@example.test`;
      const expired = await invite(expiredAddr);
      const flowE = await startInvitation(expired.raw);
      await owner.query(`UPDATE core.member_invitation SET expires_at = now() - interval '1 second', created_at = now() - interval '2 days' WHERE id = $1`, [expired.id]);
      expect(isError(await callback(flowE, account({ email: expiredAddr })))).toBe(true);

      const lateAddr = `g-late-${randomUUID().slice(0, 6)}@example.test`;
      const late = await invite(lateAddr);
      const cb = await callback(await startInvitation(late.raw), account({ email: lateAddr }));
      expect(isHandoff(cb)).toBe(true);
      await owner.query(`UPDATE core.member_invitation SET revoked_at = now() WHERE id = $1`, [late.id]);
      expect((await complete(handoffOf(cb))).status).toBe(401);
      expect(await owner.query(`SELECT 1 FROM core."user" WHERE email = $1`, [lateAddr])).toHaveLength(0);
    });

    it('T18/T19/T21: a member whose workspace membership ended between callback and completion gets no session', async () => {
      const address = `g-member-${randomUUID().slice(0, 6)}@example.test`;
      const inv = await invite(address);
      const who = account({ email: address });
      const accepted = await complete(handoffOf(await callback(await startInvitation(inv.raw), who)));
      expect(accepted.status).toBe(200);
      const [user] = await owner.query(`SELECT id FROM core."user" WHERE email = $1`, [address]);
      const cb = await callback(await start(), who);
      expect(isHandoff(cb)).toBe(true);
      await owner.query(`UPDATE core.workspace_membership SET status = 'suspended' WHERE user_id = $1`, [user.id]);
      expect((await complete(handoffOf(cb))).status).toBe(401);
    });

    it('invitation sign-in cannot be started with a malformed token', async () => {
      const res = await http().post('/rest/v1/auth/google/invitation').type('form').send({ token: 'short' });
      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────── Microsoft (nOAuth)

  describe('Microsoft verified-email rule (audit F1)', () => {
    it('without xms_edov a Microsoft identity cannot create a first link; with it, it can; an existing link keeps working', async () => {
      const org = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'msft' });
      const m = org.managers[0]!;
      const tid = randomUUID();
      const oid = randomUUID();
      const unverified: MockAccount = { sub: randomUUID(), email: m.email, extra: { tid, oid, preferred_username: m.email } };
      expect(isError(await callback(await start('microsoft'), unverified, { provider: 'microsoft' }))).toBe(true);
      expect(await owner.query(`SELECT 1 FROM core.user_auth_identity WHERE user_id = $1 AND provider = 'microsoft'`, [m.userId])).toHaveLength(0);

      const verified: MockAccount = { ...unverified, extra: { tid, oid, xms_edov: true } };
      const first = await signIn(verified, 'microsoft');
      expect(first.done.status).toBe(200);
      expect(await owner.query(`SELECT provider_subject FROM core.user_auth_identity WHERE user_id = $1 AND provider = 'microsoft'`, [m.userId])).toEqual([{ provider_subject: `${tid}:${oid}` }]);
      expect((await signIn(unverified, 'microsoft')).done.status).toBe(200);
    });
  });

  // ─────────────────────────────────────────────── Regressions

  it('T38: password login is unchanged', async () => {
    const res = await http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: managerA.email, password: managerA.password, applicationTarget: 'manager_web' });
    expect(res.status).toBe(200);
    expect(cookieValue(res, 'crewflow_session')).toBeDefined();
    void orgId;
  });
});
