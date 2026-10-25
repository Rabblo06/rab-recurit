import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { challengeRedisKey, codeAt, earlyInStep, secretFromOtpauth } from './helpers/mfa-test-kit';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Account security step 1 (owner policy 2026-10-24): two-factor authentication is OPTIONAL for every role on every app;
 * once enrolled it is REQUIRED at every sign-in, on web and mobile, for every role. Real HTTP, real PostgreSQL (DB5's
 * core.mfa_* functions), real Redis challenges. Covers the owner's 20 assertions that were missing or partial
 * (docs/account-security/PHASE_A_INVENTORY.md §c) plus every P2 / P3 / P4 / P7 denial:
 *
 *   #1–5 / #20  no role is forced to enrol; every role signs in with the password alone by default
 *   #9–#11      enrolled staff / venue manager verify on mobile; enrolment ON MOBILE is verified on web and mobile
 *   #13–#15     recovery code once, TOTP step reuse, parallel recovery-code consumption (one success)
 *   #16         disable needs proof and leaves nothing behind (password accounts; SSO-only in account-security-sso)
 *   #17         refresh refused after an admin reset and after deactivation
 *   #18         organisation suspension / deactivation between challenge and verify (host: account-security-host-recheck)
 *   #19         organisation isolation
 *   P2          mobile tokens reach ONLY the self-service MFA routes
 *   P3          old mobile clients (no `X-Client-Capabilities: mfa-verify`) get CLIENT_UPDATE_REQUIRED — no challenge/session
 *   P4          admin reset: reason, step-up, per-admin limit, platform-admin target refused, target sessions revoked
 *   P7          security notification emails, with no secret in them
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describeIfDb('account security step 1 — optional 2FA, verified everywhere once enrolled (integration)', () => {
  jest.setTimeout(600_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let redis: AuthCacheRedisClientProvider;
  const overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = {};
  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ---------------------------------------------------------------- helpers

  const loginWeb = (who: Pick<TestIdentity, 'email' | 'password'>) => http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: who.email, password: who.password });
  /** A mobile sign-in. `caps: null` = an OLD build that sends no X-Client-Capabilities header. */
  const loginMobile = (who: Pick<TestIdentity, 'email' | 'password'>, opts: { caps?: string | null; target?: string } = {}) => {
    const req = http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile');
    const caps = opts.caps === undefined ? 'mfa-verify' : opts.caps;
    if (caps !== null) req.set('x-client-capabilities', caps);
    return req.send(opts.target ? { email: who.email, password: who.password, applicationTarget: opts.target } : { email: who.email, password: who.password });
  };
  const verify = (challengeToken: string, code: string, mobile: boolean) => {
    const req = http().post('/rest/v1/auth/mfa/challenge/verify').set('Origin', ORIGIN);
    if (mobile) req.set('x-client-platform', 'mobile').set('x-client-capabilities', 'mfa-verify');
    return req.send({ challengeToken, code });
  };
  const mobileReq = (method: 'get' | 'post', path: string, token: string) => http()[method](path).set(bearer(token)).set('x-client-platform', 'mobile');
  const liveSessions = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].n as number;
  const successRows = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.login_history WHERE user_id = $1 AND success`, [userId]))[0].n as number;
  const auditCount = async (userId: string, action: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE action = $2 AND (target_user_id = $1 OR actor_user_id = $1)`, [userId, action]))[0].n as number;
  const mfaRow = async (userId: string) =>
    (await owner.query(`SELECT totp_enabled, totp_secret_encrypted, totp_last_used_step, mfa_enabled_at FROM core."user" WHERE id = $1`, [userId]))[0] as {
      totp_enabled: boolean;
      totp_secret_encrypted: Buffer | null;
      totp_last_used_step: string | null;
      mfa_enabled_at: Date | null;
    };
  const unusedCodes = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1 AND used_at IS NULL`, [userId]))[0].n as number;
  const sidOf = (token: string) => (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as { sid: string }).sid;
  const grantKey = (sid: string) => `crewflow:test:step-up:${sha256(sid)}`;

  async function managerIn(label: string, opts: { platformAdmin?: boolean } = {}) {
    return factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label, firstIsPlatformAdmin: opts.platformAdmin });
  }

  /** Enrols through the REAL self-service routes with whatever token (web or mobile) the account holds. */
  async function enrolOver(who: TestIdentity, token: string, mobile: boolean): Promise<{ secret: Buffer; recoveryCodes: string[]; otpauthUri: string }> {
    const start = mobile ? mobileReq('post', '/rest/v1/auth/mfa/enrolment', token) : http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token));
    const started = await start.send({ currentPassword: who.password });
    if (started.status !== 200) throw new Error(`enrolment start returned ${started.status} ${JSON.stringify(started.body)}`);
    const secret = secretFromOtpauth(started.body.otpauthUri);
    const confirm = mobile ? mobileReq('post', '/rest/v1/auth/mfa/enrolment/confirm', token) : http().post('/rest/v1/auth/mfa/enrolment/confirm').set(bearer(token));
    const confirmed = await confirm.send({ code: codeAt(secret, -1) });
    if (confirmed.status !== 200) throw new Error(`enrolment confirm returned ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
    return { secret, recoveryCodes: confirmed.body.recoveryCodes, otpauthUri: started.body.otpauthUri };
  }

  async function mobileToken(who: TestIdentity, target?: string): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await loginMobile(who, { target });
    if (res.status !== 200) throw new Error(`mobile login returned ${res.status} ${JSON.stringify(res.body)}`);
    return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken };
  }

  async function webToken(who: TestIdentity): Promise<string> {
    const res = await loginWeb(who);
    if (res.status !== 200) throw new Error(`web login returned ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.accessToken as string;
  }

  // ---------------------------------------------------------------- lifecycle

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
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    factory = new TestIdentityFactory({ app, dataSource: moduleRef.get(DataSource), adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    const [{ present }] = await owner.query(`SELECT to_regprocedure('core.mfa_accept_totp_step(uuid,bigint)') IS NOT NULL AS present`);
    if (!present) throw new Error('core.mfa_* functions are missing: apply MfaTotpRecoveryCodes1786719900000 before running this suite');
  });

  afterEach(() => {
    for (const key of Object.keys(overrides)) delete overrides[key as keyof EnvironmentVariables];
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  // ---------------------------------------------------------------- #1–5, #20

  it('#1–5 / #20: with the default flags no role is forced to enrol — platform admin, CEO, Initial Manager, manager, venue manager and staff sign in with the password alone on each of their apps', async () => {
    const { organisation, managers } = await managerIn('as1', { platformAdmin: true });
    const admin = managers[0]!;
    const plain = (await factory.createInternalManager(organisation, { permissions: 'production', label: 'as1m' }));
    const initial = await factory.createInternalManager(organisation, { permissions: 'production', label: 'as1im' });
    await owner.query(`UPDATE core.manager_profile SET is_initial_manager = true WHERE user_id = $1`, [initial.userId]);
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    const vm = await factory.createVenueManager(organisation, { owner: plain, label: 'as1v' });
    const staff = await factory.createStaff(organisation, { owner: plain, label: 'as1s' });

    const cases: Array<[string, TestIdentity, 'web' | 'mobile', string | undefined]> = [
      ['platform admin (web)', admin, 'web', undefined],
      ['CEO (web)', ceo, 'web', undefined],
      ['CEO (mobile)', ceo, 'mobile', 'staff_app'],
      ['Initial Manager (web)', initial, 'web', undefined],
      ['manager (web)', plain, 'web', undefined],
      ['manager (mobile)', plain, 'mobile', 'venue_manager_app'],
      ['venue manager (mobile)', vm, 'mobile', undefined],
      ['staff (mobile)', staff, 'mobile', undefined],
    ];
    for (const [label, who, app, target] of cases) {
      const res = app === 'web' ? await loginWeb(who) : await loginMobile(who, { target, caps: null }); // even an old app works
      expect({ label, status: res.status }).toEqual({ label, status: 200 });
      expect(res.body.challengeToken).toBeUndefined();
      const token = res.body.accessToken as string;
      const status = app === 'web' ? await http().get('/rest/v1/auth/mfa').set(bearer(token)) : await mobileReq('get', '/rest/v1/auth/mfa', token);
      expect({ label, status: status.status }).toEqual({ label, status: 200 });
      expect(status.body).toMatchObject({ enabled: false, enforced: false, enabledAt: null, recoveryCodesRemaining: 0, recoveryCodesTotal: 0, hasPassword: true, mobileChallenged: false });
      expect(await auditCount(who.userId, 'user.mfa_challenge_issued')).toBe(0);
    }
  });

  // ---------------------------------------------------------------- #9–#11, P2

  it('#9 / #10 / P2: staff and venue managers enrol IN THE MOBILE APP (same-phone otpauth URI) and are then verified at every mobile sign-in', async () => {
    const { organisation, managers } = await managerIn('as2');
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'as2s' });
    const vm = await factory.createVenueManager(organisation, { owner: managers[0]!, label: 'as2v' });
    for (const who of [staff, vm]) {
      await earlyInStep(8);
      const { accessToken } = await mobileToken(who);
      const { secret, recoveryCodes, otpauthUri } = await enrolOver(who, accessToken, true);
      expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
      expect(recoveryCodes).toHaveLength(10);
      const status = await mobileReq('get', '/rest/v1/auth/mfa', accessToken);
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10, recoveryCodesTotal: 10, mobileChallenged: true, hasPassword: true });
      expect(Date.parse(status.body.enabledAt)).toBeGreaterThan(Date.now() - 60_000);

      const before = { sessions: await liveSessions(who.userId), success: await successRows(who.userId) };
      const challenged = await loginMobile(who);
      expect(challenged.status).toBe(409);
      expect(challenged.body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
      expect(challenged.body.accessToken).toBeUndefined();
      expect(await liveSessions(who.userId)).toBe(before.sessions);
      expect(await successRows(who.userId)).toBe(before.success);
      const done = await verify(challenged.body.challengeToken, codeAt(secret, 0), true);
      expect(done.status).toBe(200);
      expect(done.body.refreshToken).toBeTruthy();
    }
  });

  it('#11 / #8: a manager who enrols ON MOBILE is verified on the web console AND on every mobile target; one enrolled on web is verified on mobile', async () => {
    const mobileEnrolled = (await managerIn('as3a')).managers[0]!;
    await earlyInStep(8);
    const { accessToken } = await mobileToken(mobileEnrolled, 'staff_app');
    const { secret } = await enrolOver(mobileEnrolled, accessToken, true);
    expect((await loginWeb(mobileEnrolled)).body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
    for (const target of [undefined, 'staff_app', 'venue_manager_app']) {
      expect((await loginMobile(mobileEnrolled, { target })).body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
    }
    const webDone = await verify((await loginWeb(mobileEnrolled)).body.challengeToken, codeAt(secret, 0), false);
    expect(webDone.status).toBe(200);

    const webEnrolled = (await managerIn('as3b')).managers[0]!;
    await enrolOver(webEnrolled, await webToken(webEnrolled), false);
    for (const target of [undefined, 'staff_app', 'venue_manager_app', 'manager_web']) {
      expect((await loginMobile(webEnrolled, { target })).body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
    }
  });

  it('P2 (abuse): a mobile credential reaches ONLY the self-service MFA routes — never step-up or the admin reset, and a manager-tier phone token still cannot reach console APIs', async () => {
    const { organisation, managers } = await managerIn('as4', { platformAdmin: true });
    const admin = managers[0]!;
    const staff = await factory.createStaff(organisation, { owner: admin, label: 'as4s' });
    const { accessToken: staffPhone } = await mobileToken(staff);
    expect((await mobileReq('get', '/rest/v1/auth/mfa', staffPhone)).status).toBe(200);
    const stepUp = await mobileReq('post', '/rest/v1/auth/step-up', staffPhone).send({ currentPassword: staff.password });
    expect(stepUp.status).toBe(403);
    expect(stepUp.body.code).toBe('APPLICATION_ACCESS_DENIED');

    // A PLATFORM ADMIN's phone token (allowed on every mobile target) reaches self-service only.
    const { accessToken: adminPhone } = await mobileToken(admin, 'staff_app');
    expect((await mobileReq('get', '/rest/v1/auth/mfa', adminPhone)).status).toBe(200);
    const reset = await mobileReq('post', `/rest/v1/admin/users/${staff.userId}/mfa/reset`, adminPhone).send({ reason: 'phone token', currentPassword: admin.password });
    expect(reset.status).toBe(403);
    expect((await mobileReq('get', '/rest/v1/roles', adminPhone)).status).toBe(403);
    expect((await mobileReq('post', '/rest/v1/auth/microsoft/reauthenticate', adminPhone).send({})).status).toBe(403);
    expect((await mfaRow(staff.userId)).totp_enabled).toBe(false);

    // Mobile enrolment still needs proof NOW: a fresh mobile sign-in alone is not enough for a password account.
    const noProof = await mobileReq('post', '/rest/v1/auth/mfa/enrolment', staffPhone).send({});
    expect(noProof.status).toBe(403);
    expect(noProof.body).toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect((await mobileReq('post', '/rest/v1/auth/mfa/enrolment', staffPhone).send({ currentPassword: 'not-it' })).status).toBe(403);
    expect((await mfaRow(staff.userId)).totp_secret_encrypted).toBeNull();
  });

  // ---------------------------------------------------------------- P3

  it('P3 (abuse): an OLD mobile client (no `mfa-verify` capability) gets 409 CLIENT_UPDATE_REQUIRED for an enrolled account — no challenge, no session, no success row, no token; web and capable clients are unaffected', async () => {
    const { organisation, managers } = await managerIn('as5');
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'as5s' });
    await earlyInStep(8);
    const { accessToken } = await mobileToken(staff);
    await enrolOver(staff, accessToken, true);
    const manager = managers[0]!;
    await enrolOver(manager, await webToken(manager), false);

    for (const caps of [null, '', 'mfa-enrol', 'mfa-verifyx', 'x'.repeat(600)]) {
      for (const who of [staff, manager]) {
        const before = { sessions: await liveSessions(who.userId), success: await successRows(who.userId), issued: await auditCount(who.userId, 'user.mfa_challenge_issued') };
        const res = await loginMobile(who, { caps });
        expect({ caps, status: res.status, code: res.body.code }).toEqual({ caps, status: 409, code: 'CLIENT_UPDATE_REQUIRED' });
        expect(res.body.message).toMatch(/Update Crewflow to sign in/);
        expect(res.body.challengeToken).toBeUndefined();
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(await liveSessions(who.userId)).toBe(before.sessions);
        expect(await successRows(who.userId)).toBe(before.success);
        expect(await auditCount(who.userId, 'user.mfa_challenge_issued')).toBe(before.issued);
      }
    }
    expect(await auditCount(staff.userId, 'user.mfa_client_update_required')).toBeGreaterThan(0);
    // The token is case-insensitive inside a comma-separated list.
    for (const caps of ['MFA-VERIFY', ' mfa-enrol , Mfa-Verify ']) expect((await loginMobile(staff, { caps })).body.code).toBe('SECOND_FACTOR_REQUIRED');
    // Web never needs the header.
    expect((await loginWeb(manager)).body.code).toBe('SECOND_FACTOR_REQUIRED');
    // The header can only ENABLE the challenge: an old client of an un-enrolled account signs in as before.
    const fresh = await factory.createStaff(organisation, { owner: manager, label: 'as5f' });
    expect((await loginMobile(fresh, { caps: null })).status).toBe(200);
  });

  // ---------------------------------------------------------------- coordinator: attempts / states

  it('challenge failures are distinct, stable and non-enumerating: true attemptsRemaining, then locked; unknown = expired, byte for byte', async () => {
    const { organisation, managers } = await managerIn('as6');
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'as6s' });
    await earlyInStep(8);
    const { accessToken } = await mobileToken(staff);
    const { secret } = await enrolOver(staff, accessToken, true);
    const c = (await loginMobile(staff)).body.challengeToken as string;
    const max = 5; // AUTH_MFA_CHALLENGE_MAX_ATTEMPTS default
    for (let i = 1; i <= max; i++) {
      const res = await verify(c, '000000', true);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'MFA_CODE_INVALID', state: 'invalid_code', attemptsRemaining: max - i, message: expect.any(String) });
    }
    const locked = await verify(c, codeAt(secret, 0), true);
    expect(locked.status).toBe(401);
    expect(locked.body).toMatchObject({ code: 'MFA_CHALLENGE_EXHAUSTED', state: 'locked' });
    const afterLock = await verify(c, codeAt(secret, 0), true);
    const unknown = await verify(`mfc_${'Q'.repeat(43)}`, codeAt(secret, 0), true);
    const garbage = await verify('not-a-token', codeAt(secret, 0), true);
    const live = (await loginMobile(staff)).body.challengeToken as string;
    await redis.client.pexpire(challengeRedisKey(live), 1);
    await new Promise((r) => setTimeout(r, 20));
    const lapsed = await verify(live, codeAt(secret, 0), true);
    for (const res of [afterLock, unknown, garbage, lapsed]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual(unknown.body);
    }
    expect(unknown.body).toMatchObject({ code: 'MFA_CHALLENGE_EXPIRED', state: 'expired' });
    // No account detail in any failure body.
    for (const res of [locked, unknown]) expect(JSON.stringify(res.body)).not.toMatch(new RegExp(staff.email.split('@')[0]!, 'i'));
  });

  // ---------------------------------------------------------------- #13–#15

  it('#13 / #14: a recovery code works once on mobile; a TOTP step that already signed in is refused on the next challenge', async () => {
    const { organisation, managers } = await managerIn('as7');
    const vm = await factory.createVenueManager(organisation, { owner: managers[0]!, label: 'as7v' });
    await earlyInStep(8);
    const { accessToken } = await mobileToken(vm);
    const { secret, recoveryCodes } = await enrolOver(vm, accessToken, true);
    const code = codeAt(secret, 0);
    expect((await verify((await loginMobile(vm)).body.challengeToken, code, true)).status).toBe(200);
    const replay = await verify((await loginMobile(vm)).body.challengeToken, code, true);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('MFA_CODE_INVALID');
    expect((await verify((await loginMobile(vm)).body.challengeToken, recoveryCodes[0]!, true)).status).toBe(200);
    expect((await verify((await loginMobile(vm)).body.challengeToken, recoveryCodes[0]!, true)).status).toBe(401);
    expect(await unusedCodes(vm.userId)).toBe(9);
  });

  it('#15 (abuse): the same recovery code presented on two challenges IN PARALLEL signs in exactly once; two codes racing on ONE challenge issue exactly one session', async () => {
    const who = (await managerIn('as8')).managers[0]!;
    const { recoveryCodes } = await enrolOver(who, await webToken(who), false);
    const before = await liveSessions(who.userId);
    const [c1, c2] = [(await loginWeb(who)).body.challengeToken as string, (await loginWeb(who)).body.challengeToken as string];
    const results = await Promise.all([verify(c1, recoveryCodes[0]!, false), verify(c2, recoveryCodes[0]!, false)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(await liveSessions(who.userId)).toBe(before + 1);
    expect(await unusedCodes(who.userId)).toBe(9);

    const one = (await loginWeb(who)).body.challengeToken as string;
    const raced = await Promise.all([verify(one, recoveryCodes[1]!, false), verify(one, recoveryCodes[2]!, false)]);
    expect(raced.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await liveSessions(who.userId)).toBe(before + 2);
  });

  // ---------------------------------------------------------------- #16 (password accounts) + P7

  it('#16 / P7: turning 2FA off needs password AND a code, leaves no secret / counter / recovery code behind; on, regenerate and off each email the account with no secret in it', async () => {
    const { organisation, managers } = await managerIn('as9');
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'as9s' });
    await earlyInStep(6);
    const { accessToken } = await mobileToken(staff);
    const { secret, recoveryCodes, otpauthUri } = await enrolOver(staff, accessToken, true);

    const regenerate = await mobileReq('post', '/rest/v1/auth/mfa/recovery-codes', accessToken).send({ currentPassword: staff.password, code: codeAt(secret, 0) });
    expect(regenerate.status).toBe(200);
    const fresh = regenerate.body.recoveryCodes as string[];

    expect((await mobileReq('post', '/rest/v1/auth/mfa/disable', accessToken).send({})).status).toBe(403);
    expect((await mobileReq('post', '/rest/v1/auth/mfa/disable', accessToken).send({ currentPassword: staff.password })).body.code).toBe('STEP_UP_MFA_INVALID');
    expect((await mobileReq('post', '/rest/v1/auth/mfa/disable', accessToken).send({ currentPassword: 'wrong', code: fresh[0] })).status).toBe(403);
    // An OLD recovery code (replaced by the regeneration) is refused.
    expect((await mobileReq('post', '/rest/v1/auth/mfa/disable', accessToken).send({ currentPassword: staff.password, code: recoveryCodes[0] })).status).toBe(403);
    expect((await mfaRow(staff.userId)).totp_enabled).toBe(true);
    const off = await mobileReq('post', '/rest/v1/auth/mfa/disable', accessToken).send({ currentPassword: staff.password, code: fresh[0] });
    expect(off.status).toBe(204);
    const row = await mfaRow(staff.userId);
    expect(row).toMatchObject({ totp_enabled: false, totp_secret_encrypted: null, totp_last_used_step: null, mfa_enabled_at: null });
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1`, [staff.userId]))[0].n).toBe(0);
    expect((await loginMobile(staff)).status).toBe(200);

    const mails = (await owner.query(
      `SELECT job_type, rendered_subject, rendered_html, rendered_text FROM core.email_outbox WHERE target_user_id = $1 ORDER BY created_at`,
      [staff.userId],
    )) as Array<{ job_type: string; rendered_subject: string; rendered_html: string; rendered_text: string }>;
    const subjects = mails.map((m) => m.rendered_subject);
    expect(subjects).toEqual(
      expect.arrayContaining([
        'Two-factor authentication was turned on for your Crewflow account',
        'New recovery codes were created for your Crewflow account',
        'Two-factor authentication was turned off for your Crewflow account',
      ]),
    );
    const base32 = new URL(otpauthUri).searchParams.get('secret')!;
    const dump = JSON.stringify(mails);
    for (const secretish of [base32, otpauthUri, ...recoveryCodes, ...fresh]) expect(dump).not.toContain(secretish);
    expect(mails.filter((m) => m.rendered_subject.includes('Two-factor') || m.rendered_subject.includes('recovery')).every((m) => m.job_type === 'NOTIFICATION')).toBe(true);
  });

  // ---------------------------------------------------------------- P4 + #17

  it('P4 (abuse): an active PLATFORM ADMIN target is refused (MFA_RESET_REQUIRES_SECOND_ADMIN, audited, nothing changes)', async () => {
    const { managers } = await managerIn('as10', { platformAdmin: true });
    const admin = managers[0]!;
    const otherAdmin = (await managerIn('as10b', { platformAdmin: true })).managers[0]!;
    await enrolOver(otherAdmin, await webToken(otherAdmin), false);
    const res = await http().post(`/rest/v1/admin/users/${otherAdmin.userId}/mfa/reset`).set(bearer(await webToken(admin))).send({ reason: 'lost phone', currentPassword: admin.password });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('MFA_RESET_REQUIRES_SECOND_ADMIN');
    expect((await mfaRow(otherAdmin.userId)).totp_enabled).toBe(true);
    const [audit] = await owner.query(`SELECT metadata FROM core.audit_log WHERE action = 'user.mfa_reset_refused' AND target_user_id = $1`, [otherAdmin.userId]);
    expect(audit.metadata).toMatchObject({ refusal: 'target_is_platform_admin', reason: 'lost phone' });
    expect(await auditCount(otherAdmin.userId, 'user.mfa_reset_by_admin')).toBe(0);
  });

  it('P4 / #17: a reset by step-up grant (no inline password) revokes every session AND refresh token of the target, emails them, and a refresh afterwards is refused', async () => {
    const { organisation, managers } = await managerIn('as11', { platformAdmin: true });
    const admin = managers[0]!;
    const staff = await factory.createStaff(organisation, { owner: admin, label: 'as11s' });
    await earlyInStep(8);
    const { accessToken } = await mobileToken(staff);
    const { secret } = await enrolOver(staff, accessToken, true);
    const signedIn = await verify((await loginMobile(staff)).body.challengeToken, codeAt(secret, 0), true);
    const { refreshToken, accessToken: liveToken } = signedIn.body as { refreshToken: string; accessToken: string };

    const adminToken = await webToken(admin);
    await redis.client.del(grantKey(sidOf(adminToken))); // a STALE admin session
    const stale = await http().post(`/rest/v1/admin/users/${staff.userId}/mfa/reset`).set(bearer(adminToken)).send({ reason: 'lost phone' });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ code: 'STEP_UP_REQUIRED', mfa: false });
    // A code without a password is no proof either.
    expect((await http().post(`/rest/v1/admin/users/${staff.userId}/mfa/reset`).set(bearer(adminToken)).send({ reason: 'lost phone', code: '123456' })).status).toBe(403);
    expect((await mfaRow(staff.userId)).totp_enabled).toBe(true);

    expect((await http().post('/rest/v1/auth/step-up').set(bearer(adminToken)).send({ currentPassword: admin.password })).status).toBe(200);
    const done = await http().post(`/rest/v1/admin/users/${staff.userId}/mfa/reset`).set(bearer(adminToken)).send({ reason: '  Lost phone (ticket 7)  ' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ reset: true });
    expect(done.body.revokedSessions).toBeGreaterThanOrEqual(2);
    expect(await liveSessions(staff.userId)).toBe(0);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.refresh_token WHERE user_id = $1 AND revoked_at IS NULL`, [staff.userId]))[0].n).toBe(0);
    expect((await mobileReq('get', '/rest/v1/auth/me', liveToken)).status).toBe(401);
    const refresh = await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken });
    expect(refresh.status).toBe(401);
    expect(refresh.body.accessToken).toBeUndefined();
    const [mail] = await owner.query(`SELECT organisation_id, rendered_subject, rendered_text FROM core.email_outbox WHERE target_user_id = $1 AND rendered_subject LIKE 'An administrator reset%'`, [staff.userId]);
    expect(mail).toMatchObject({ organisation_id: staff.organisationId });
    expect(mail.rendered_text).not.toContain('ticket 7'); // the reason is for the audit trail, not the email
    const reasons = await owner.query(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'user.mfa_reset_by_admin' AND target_user_id = $1`, [staff.userId]);
    expect(reasons.map((r: { reason: string }) => r.reason)).toEqual(['Lost phone (ticket 7)', 'Lost phone (ticket 7)']);
    // The account signs in with the password again (2FA is optional) — on an old client too.
    expect((await loginMobile(staff, { caps: null })).status).toBe(200);
  });

  it('P4 (abuse): the per-admin limit refuses the 6th reset attempt in an hour with 429 MFA_RESET_RATE_LIMITED + Retry-After, even when every attempt failed', async () => {
    const { organisation, managers } = await managerIn('as12', { platformAdmin: true });
    const admin = managers[0]!;
    const staff = await factory.createStaff(organisation, { owner: admin, label: 'as12s' });
    const adminToken = await webToken(admin);
    const previous = process.env.RAB_DISABLE_RATE_LIMIT;
    process.env.RAB_DISABLE_RATE_LIMIT = 'false';
    try {
      for (let i = 0; i < 5; i++) {
        expect((await http().post(`/rest/v1/admin/users/${staff.userId}/mfa/reset`).set(bearer(adminToken)).send({ reason: 'probe', currentPassword: 'wrong' })).status).toBe(403);
      }
      const limited = await http().post(`/rest/v1/admin/users/${staff.userId}/mfa/reset`).set(bearer(adminToken)).send({ reason: 'probe', currentPassword: admin.password });
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('MFA_RESET_RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.RAB_DISABLE_RATE_LIMIT;
      else process.env.RAB_DISABLE_RATE_LIMIT = previous;
    }
  });

  it('#17: a refresh after the account is deactivated is refused', async () => {
    const { organisation, managers } = await managerIn('as13');
    const manager = managers[0]!;
    const staff = await factory.createStaff(organisation, { owner: manager, label: 'as13s' });
    const { refreshToken } = await mobileToken(staff);
    const managerToken = await webToken(manager); // fresh sign-in: carries the step-up grant
    expect([200, 201]).toContain((await http().post(`/rest/v1/staff/${staff.profileId}/deactivate`).set(bearer(managerToken)).send()).status);
    expect((await http().post('/rest/v1/auth/refresh').set('x-client-platform', 'mobile').send({ refreshToken })).status).toBe(401);
  });

  // ---------------------------------------------------------------- #18 (membership / account status)

  it('#18 (abuse): organisation suspension or account deactivation BETWEEN the challenge and the code means no session — the verify re-runs every sign-in gate', async () => {
    const { organisation, managers } = await managerIn('as14');
    const manager = managers[0]!;
    const staff = await factory.createStaff(organisation, { owner: manager, label: 'as14s' });
    await earlyInStep(6);
    const { accessToken } = await mobileToken(staff);
    const { recoveryCodes } = await enrolOver(staff, accessToken, true);
    const before = await liveSessions(staff.userId);

    const c1 = (await loginMobile(staff)).body.challengeToken as string;
    await owner.query(`UPDATE core.organisation SET suspended_at = now(), suspended_by = $2, suspended_reason = 'account-security #18' WHERE id = $1`, [organisation.id, manager.userId]);
    try {
      const refused = await verify(c1, recoveryCodes[0]!, true);
      expect(refused.status).toBe(401);
      expect(refused.body.accessToken).toBeUndefined();
      expect(await liveSessions(staff.userId)).toBe(before);
    } finally {
      await owner.query(`UPDATE core.organisation SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = $1`, [organisation.id]);
    }

    const c2 = (await loginMobile(staff)).body.challengeToken as string;
    expect([200, 201]).toContain((await http().post(`/rest/v1/staff/${staff.profileId}/deactivate`).set(bearer(await webToken(manager))).send()).status);
    const deactivated = await verify(c2, recoveryCodes[1]!, true);
    expect(deactivated.status).toBe(401);
    expect(deactivated.body.accessToken).toBeUndefined();
    expect(await liveSessions(staff.userId)).toBe(0);
  });

  // ---------------------------------------------------------------- #19

  it('#19: organisation A\'s settings and members never change organisation B: A turning password sign-in off leaves B\'s enrolled manager challenged as before; A\'s manager cannot touch B\'s factor', async () => {
    const a = await managerIn('as15a');
    const b = await managerIn('as15b');
    const managerA = a.managers[0]!;
    const managerB = b.managers[0]!;
    await enrolOver(managerB, await webToken(managerB), false);
    const tokenA = await webToken(managerA);
    await owner.query(`UPDATE core.organisation SET password_auth_enabled = false WHERE id = $1`, [a.organisation.id]);
    try {
      expect((await loginWeb(managerA)).status).toBe(401);
      expect((await loginWeb(managerB)).body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
    } finally {
      await owner.query(`UPDATE core.organisation SET password_auth_enabled = true WHERE id = $1`, [a.organisation.id]);
    }
    const crossReset = await http().post(`/rest/v1/admin/users/${managerB.userId}/mfa/reset`).set(bearer(tokenA)).send({ reason: 'cross org', currentPassword: managerA.password });
    expect(crossReset.status).toBe(403);
    expect((await mfaRow(managerB.userId)).totp_enabled).toBe(true);
    // Self-service is strictly the caller's own account: A's status says nothing about B.
    expect((await http().get('/rest/v1/auth/mfa').set(bearer(tokenA))).body.enabled).toBe(false);
  });
});
