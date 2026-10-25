import 'reflect-metadata';
import { HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { challengeRedisKey, codeAt, earlyInStep, secretFromOtpauth } from './helpers/mfa-test-kit';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 4 lane MFA — TOTP second factor end to end on the REAL database functions of lane DB5
 * (`MfaTotpRecoveryCodes1786719900000`; contract docs/evidence/w45-db5/CONTRACT.md §1), real Redis challenges, real HTTP.
 * Every abuse case named in the lane brief has a test here (replay of the same code, an older step, parallel replay,
 * wrong-code exhaustion, recovery-code reuse, disable without step-up, a stolen session trying to disable, admin-reset
 * authorisation, challenge reuse/expiry/transport binding, enforced role without enrolment, mobile unaffected).
 *
 * Requires a database with DB5's migrations applied (fails loudly otherwise — never reported as passed).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';

describeIfDb('wave 4 lane MFA — TOTP, recovery codes, challenge, step-up, admin reset (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let owner: DataSource;
  let appDs: DataSource;
  let factory: TestIdentityFactory;
  let auth: AuthService;
  let redis: AuthCacheRedisClientProvider;
  const overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = {};
  const http = () => request(app.getHttpServer());

  // ---------------------------------------------------------------- helpers

  const loginWeb = (who: Pick<TestIdentity, 'email' | 'password'>) => http().post('/rest/v1/auth/login').set('Origin', ORIGIN).send({ email: who.email, password: who.password });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const sessions = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].n as number;
  const mfaRow = async (userId: string) =>
    (await owner.query(`SELECT totp_enabled, totp_secret_encrypted, totp_last_used_step, mfa_enabled_at FROM core."user" WHERE id = $1`, [userId]))[0] as {
      totp_enabled: boolean;
      totp_secret_encrypted: Buffer | null;
      totp_last_used_step: string | null;
      mfa_enabled_at: Date | null;
    };
  const auditActions = async (userId: string) =>
    (await owner.query(`SELECT action, metadata FROM core.audit_log WHERE target_user_id = $1 OR actor_user_id = $1 ORDER BY created_at`, [userId])) as Array<{ action: string; metadata: unknown }>;

  async function accessToken(who: TestIdentity): Promise<string> {
    const res = await loginWeb(who);
    if (res.status !== 200) throw new Error(`setup login returned ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.accessToken as string;
  }

  /** Enrols through the real settings flow. `confirmOffset` picks which step's code confirms (default: the previous one). */
  async function enrol(who: TestIdentity, token: string, confirmOffset = -1): Promise<{ secret: Buffer; recoveryCodes: string[]; otpauthUri: string; qrDataUrl: string; manualKey: string }> {
    const started = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token)).send({ currentPassword: who.password });
    expect(started.status).toBe(200);
    const secret = secretFromOtpauth(started.body.otpauthUri);
    const confirmed = await http().post('/rest/v1/auth/mfa/enrolment/confirm').set(bearer(token)).send({ code: codeAt(secret, confirmOffset) });
    expect(confirmed.status).toBe(200);
    return { secret, recoveryCodes: confirmed.body.recoveryCodes, ...started.body };
  }

  async function challenge(who: TestIdentity, mobile = false): Promise<string> {
    const req = http().post('/rest/v1/auth/login').set('Origin', ORIGIN);
    // A current mobile build declares the code screen (account security step 1, P3).
    if (mobile) req.set('x-client-platform', 'mobile').set('x-client-capabilities', 'mfa-verify');
    const res = await req.send({ email: who.email, password: who.password });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SECOND_FACTOR_REQUIRED');
    return res.body.challengeToken as string;
  }

  const verify = (challengeToken: string, code: string, mobile = false) => {
    const req = http().post('/rest/v1/auth/mfa/challenge/verify').set('Origin', ORIGIN);
    if (mobile) req.set('x-client-platform', 'mobile');
    return req.send({ challengeToken, code });
  };

  async function manager(label: string): Promise<TestIdentity> {
    return (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label })).managers[0]!;
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
    appDs = moduleRef.get(DataSource);
    auth = moduleRef.get(AuthService);
    redis = moduleRef.get(AuthCacheRedisClientProvider);
    factory = new TestIdentityFactory({ app, dataSource: appDs, adminDataSource: owner, tenantContext: moduleRef.get(TenantContextService), passwordHashing: moduleRef.get(PasswordHashingService) });
    // Fail loudly (never "pass") on a database without lane DB5's MFA schema.
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

  // ---------------------------------------------------------------- enrolment

  it('enrolment: needs the current password; the secret is generated server-side and stored only as an RAB2 envelope; confirm needs a valid code', async () => {
    const who = await manager('w4e');
    const token = await accessToken(who);
    // Account security step 1: the password is optional in the BODY (an SSO account proves itself with a re-auth grant
    // instead), never optional as proof — a password account's fresh sign-in alone does not count, nothing is staged.
    const noPassword = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token)).send({});
    expect(noPassword.status).toBe(403);
    expect(noPassword.body).toMatchObject({ code: 'STEP_UP_REQUIRED', mfa: false });
    expect((await mfaRow(who.userId)).totp_secret_encrypted).toBeNull();
    const clientSecret = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token)).send({ currentPassword: who.password, secret: 'JBSWY3DPEHPK3PXP' });
    expect(clientSecret.status).toBe(400); // forbidNonWhitelisted: the client can never choose the secret
    const wrong = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token)).send({ currentPassword: 'not-the-password' });
    expect(wrong.status).toBe(403);

    const started = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token)).send({ currentPassword: who.password });
    expect(started.status).toBe(200);
    expect(started.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(started.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const base32 = new URL(started.body.otpauthUri).searchParams.get('secret')!;
    const stored = await mfaRow(who.userId);
    expect(stored.totp_enabled).toBe(false);
    expect(stored.totp_secret_encrypted!.subarray(0, 4).toString('latin1')).toBe('RAB2');
    expect(stored.totp_secret_encrypted!.toString('latin1')).not.toContain(base32);
    expect(stored.totp_secret_encrypted!.toString('hex')).not.toContain(secretFromOtpauth(started.body.otpauthUri).toString('hex'));

    const bad = await http().post('/rest/v1/auth/mfa/enrolment/confirm').set(bearer(token)).send({ code: '000000' });
    expect(bad.status).toBe(401);
    expect((await mfaRow(who.userId)).totp_enabled).toBe(false);

    // A second, older session of the same account exists before confirmation…
    const otherSession = await accessToken(who);
    const secret = secretFromOtpauth(started.body.otpauthUri);
    const ok = await http().post('/rest/v1/auth/mfa/enrolment/confirm').set(bearer(token)).send({ code: codeAt(secret, 0) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    const enabled = await mfaRow(who.userId);
    expect(enabled.totp_enabled).toBe(true);
    expect(enabled.mfa_enabled_at).toBeTruthy();
    // …and is ended by enabling MFA; the confirming session keeps working.
    expect((await http().get('/rest/v1/auth/me').set(bearer(otherSession))).status).toBe(401);
    expect((await http().get('/rest/v1/auth/mfa').set(bearer(token))).body).toMatchObject({ enabled: true, recoveryCodesRemaining: 10 });
    // Recovery codes: hashed one-way, never stored or audited in clear.
    const hashes = await owner.query(`SELECT code_hash FROM core.user_mfa_recovery_code WHERE user_id = $1`, [who.userId]);
    expect(hashes).toHaveLength(10);
    const dump = JSON.stringify(hashes) + JSON.stringify(await auditActions(who.userId));
    for (const code of ok.body.recoveryCodes as string[]) {
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(code.replace(/-/g, ''));
    }
    expect(dump).not.toContain(base32);
    expect((await auditActions(who.userId)).map((a) => a.action)).toEqual(expect.arrayContaining(['user.mfa_enrolment_started', 'user.mfa_enabled']));
    // Already enabled: a second enrolment cannot silently re-key the factor.
    const again = await http().post('/rest/v1/auth/mfa/enrolment').set(bearer(token)).send({ currentPassword: who.password });
    expect(again.status).toBe(409);
  });

  // ---------------------------------------------------------------- challenge + replay

  it('ABUSE: replay of the same code, an older step and a parallel replay are all refused; a fresh step signs in', async () => {
    const who = await manager('w4r');
    const token = await accessToken(who);
    const step = await earlyInStep(6);
    const { secret } = await enrol(who, token, -1); // the step-1 code confirmed enrolment (recorded as used)
    expect(Number((await mfaRow(who.userId)).totp_last_used_step)).toBe(step - 1);

    const before = await sessions(who.userId);
    const c1 = await challenge(who);
    expect(await sessions(who.userId)).toBe(before); // a challenge is not a session
    const sameAsConfirmation = await verify(c1, codeAt(secret, -1));
    expect(sameAsConfirmation.status).toBe(401);
    expect(sameAsConfirmation.body.code).toBe('MFA_CODE_INVALID');

    const ok = await verify(c1, codeAt(secret, 0));
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect(([] as string[]).concat(ok.headers['set-cookie'] ?? []).some((c) => c.startsWith('crewflow_session='))).toBe(true);
    expect(Number((await mfaRow(who.userId)).totp_last_used_step)).toBe(step);

    const c2 = await challenge(who);
    expect((await verify(c2, codeAt(secret, 0))).status).toBe(401); // same code again
    expect((await verify(c2, codeAt(secret, -1))).status).toBe(401); // older step, still inside the ±1 window

    const [c3, c4] = [await challenge(who), await challenge(who)];
    const fresh = codeAt(secret, 1);
    const results = await Promise.all([verify(c3, fresh), verify(c4, fresh)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect((await auditActions(who.userId)).filter((a) => a.action === 'user.mfa_challenge_failed').length).toBeGreaterThanOrEqual(3);
  });

  it('ABUSE: wrong codes exhaust the challenge (then even a correct factor fails); token reuse, expiry, garbage and transport switching are refused', async () => {
    const who = await manager('w4x');
    const token = await accessToken(who);
    const { recoveryCodes } = await enrol(who, token, 0);

    const c = await challenge(who);
    for (let i = 0; i < 5; i += 1) {
      const res = await verify(c, '123456');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('MFA_CODE_INVALID');
      // Account security step 1: the TRUE number of further attempts this challenge accepts (5, 4, … → 0).
      expect(res.body).toMatchObject({ state: 'invalid_code', attemptsRemaining: 4 - i });
    }
    const exhausted = await verify(c, recoveryCodes[0]!);
    expect(exhausted.status).toBe(401);
    expect(exhausted.body.code).toBe('MFA_CHALLENGE_EXHAUSTED');
    expect(exhausted.body.state).toBe('locked');
    expect((await verify(c, recoveryCodes[0]!)).body.code).toBe('MFA_CHALLENGE_EXPIRED'); // destroyed, not reset
    // The recovery code presented to the dead challenge was NOT consumed.
    const used = await owner.query(`SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1 AND used_at IS NOT NULL`, [who.userId]);
    expect(used[0].n).toBe(0);

    // Single use: a challenge that issued a session cannot issue another.
    const c2 = await challenge(who);
    expect((await verify(c2, recoveryCodes[0]!)).status).toBe(200);
    const reuse = await verify(c2, recoveryCodes[1]!);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('MFA_CHALLENGE_EXPIRED');

    // Expiry (simulated by letting the Redis key lapse).
    const c3 = await challenge(who);
    await redis.client.pexpire(challengeRedisKey(c3), 1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await verify(c3, recoveryCodes[1]!)).body.code).toBe('MFA_CHALLENGE_EXPIRED');

    // Garbage / forged tokens.
    expect((await verify(`mfc_${'A'.repeat(43)}`, recoveryCodes[1]!)).status).toBe(401);
    expect((await verify('not-a-token', recoveryCodes[1]!)).status).toBe(401);

    // Bound to the transport: a web challenge cannot be finished by a mobile client (and vice versa).
    const c4 = await challenge(who);
    expect((await verify(c4, recoveryCodes[1]!, true)).status).toBe(401);
    // Redis never holds the token itself, only its hash.
    expect(await redis.client.exists(c4)).toBe(0);
  });

  it('ABUSE: a recovery code works exactly once; regeneration needs password + a factor and invalidates the old set', async () => {
    const who = await manager('w4rc');
    const token = await accessToken(who);
    const { recoveryCodes } = await enrol(who, token, 0);

    expect((await verify(await challenge(who), recoveryCodes[2]!.toLowerCase())).status).toBe(200);
    const reuse = await verify(await challenge(who), recoveryCodes[2]!);
    expect(reuse.status).toBe(401);
    expect((await http().get('/rest/v1/auth/mfa').set(bearer(token))).body.recoveryCodesRemaining).toBe(9);
    expect((await auditActions(who.userId)).some((a) => a.action === 'user.mfa_recovery_code_used')).toBe(true);

    const noFactor = await http().post('/rest/v1/auth/mfa/recovery-codes').set(bearer(token)).send({ currentPassword: who.password });
    expect(noFactor.status).toBe(403);
    expect(noFactor.body.code).toBe('STEP_UP_MFA_INVALID');
    const wrongPassword = await http().post('/rest/v1/auth/mfa/recovery-codes').set(bearer(token)).send({ currentPassword: 'nope', code: recoveryCodes[3] });
    expect(wrongPassword.status).toBe(403);
    const regenerated = await http().post('/rest/v1/auth/mfa/recovery-codes').set(bearer(token)).send({ currentPassword: who.password, code: recoveryCodes[3] });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.recoveryCodes).toHaveLength(10);
    // An old code (never used) no longer works; a new one does.
    expect((await verify(await challenge(who), recoveryCodes[4]!)).status).toBe(401);
    expect((await verify(await challenge(who), regenerated.body.recoveryCodes[0])).status).toBe(200);
  });

  // ---------------------------------------------------------------- disable / stolen session

  it('ABUSE: disabling needs password AND a current factor; a stolen session alone, or a direct UPDATE, cannot switch MFA off', async () => {
    const who = await manager('w4d');
    const token = await accessToken(who);
    const { recoveryCodes } = await enrol(who, token, 0);
    // The "stolen" session: a live credential without the password or the authenticator.
    const stolen = (await verify(await challenge(who), recoveryCodes[0]!)).body.accessToken as string;

    for (const body of [{ currentPassword: 'guess' }, { currentPassword: 'guess', code: '123456' }, { currentPassword: who.password }, { currentPassword: who.password, code: '000000' }]) {
      const res = await http().post('/rest/v1/auth/mfa/disable').set(bearer(stolen)).send(body);
      expect(res.status).toBe(403);
    }
    expect((await mfaRow(who.userId)).totp_enabled).toBe(true);
    // A client cannot name the resulting state either.
    expect((await http().post('/rest/v1/auth/mfa/disable').set(bearer(stolen)).send({ currentPassword: who.password, code: recoveryCodes[1], totpEnabled: false })).status).toBe(400);

    // Even application code cannot disable MFA or rewind the replay counter with a plain UPDATE (guard trigger, 42501).
    await expect(
      factoryTx(who, (m) => m.query(`UPDATE core."user" SET totp_enabled = false, totp_secret_encrypted = NULL WHERE id = $1`, [who.userId])),
    ).rejects.toMatchObject({ code: '42501' });

    const ok = await http().post('/rest/v1/auth/mfa/disable').set(bearer(token)).send({ currentPassword: who.password, code: recoveryCodes[1] });
    expect(ok.status).toBe(204);
    expect((await mfaRow(who.userId)).totp_enabled).toBe(false);
    expect((await mfaRow(who.userId)).totp_secret_encrypted).toBeNull();
    expect((await http().get('/rest/v1/auth/me').set(bearer(stolen))).status).toBe(401); // other sessions ended
    expect((await http().get('/rest/v1/auth/me').set(bearer(token))).status).toBe(200);
    expect((await owner.query(`SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1`, [who.userId]))[0].n).toBe(0);
    expect((await loginWeb(who)).status).toBe(200); // password-only again
    expect((await auditActions(who.userId)).some((a) => a.action === 'user.mfa_disabled')).toBe(true);
  });

  /** Runs SQL as the runtime role (crewflow_app) inside the user's own tenant context. */
  async function factoryTx<T>(who: TestIdentity, run: (m: import('typeorm').EntityManager) => Promise<T>): Promise<T> {
    const tenant = app.get(TenantContextService);
    return tenant.runInTenantContext({ organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' }, run);
  }

  // ---------------------------------------------------------------- step-up

  it('step-up: POST /auth/step-up needs password + current factor for an enrolled account and is audited either way', async () => {
    const who = await manager('w4s');
    const token = await accessToken(who);
    await earlyInStep(10);
    const { secret } = await enrol(who, token, -1);
    expect((await http().post('/rest/v1/auth/step-up').set(bearer(token)).send({ currentPassword: who.password })).status).toBe(403);
    expect((await http().post('/rest/v1/auth/step-up').set(bearer(token)).send({ currentPassword: 'x', code: codeAt(secret, 0) })).status).toBe(403);
    const ok = await http().post('/rest/v1/auth/step-up').set(bearer(token)).send({ currentPassword: who.password, code: codeAt(secret, 0) });
    expect(ok.status).toBe(200);
    expect(ok.body.mfa).toBe(true);
    expect(new Date(ok.body.validUntil).getTime()).toBeGreaterThan(Date.now());
    // The code that satisfied step-up is burned (replay protection is shared by every flow).
    expect((await http().post('/rest/v1/auth/step-up').set(bearer(token)).send({ currentPassword: who.password, code: codeAt(secret, 0) })).status).toBe(403);
    const actions = (await auditActions(who.userId)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.step_up_failed', 'auth.step_up_succeeded']));
  });

  // ---------------------------------------------------------------- admin reset

  // Account security step 1 (P4): the old rule "the admin must hold their own TOTP" contradicted the owner policy (no role
  // is ever forced to enrol). Now: a required reason + fresh proof (password, or a step-up / SSO re-auth grant) + the
  // admin's own code ONLY when the admin is enrolled. Every denial of the old test is kept.
  it('ABUSE: admin reset is platform-admin only, needs a reason + the admin\'s fresh proof (+ own code only if enrolled), never self, and revokes the target\'s sessions (audited in both orgs)', async () => {
    const reset = (token: string, userId: string, body: object) => http().post(`/rest/v1/admin/users/${userId}/mfa/reset`).set(bearer(token)).send(body);
    const target = await manager('w4t');
    const targetToken = await accessToken(target);
    const { recoveryCodes } = await enrol(target, targetToken, 0);
    const targetSession = (await verify(await challenge(target), recoveryCodes[0]!)).body.accessToken as string;

    const ordinary = await manager('w4o');
    const ordinaryToken = await accessToken(ordinary);
    const denied = await reset(ordinaryToken, target.userId, { reason: 'lost phone', currentPassword: ordinary.password, code: '123456' });
    expect(denied.status).toBe(403);

    const admin = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, firstIsPlatformAdmin: true, label: 'w4adm' })).managers[0]!;
    const adminToken = await accessToken(admin);
    // A reason is required (trimmed, 3–500 characters).
    expect((await reset(adminToken, target.userId, { currentPassword: admin.password })).status).toBe(400);
    expect((await reset(adminToken, target.userId, { reason: '  x ', currentPassword: admin.password })).status).toBe(400);
    expect((await reset(adminToken, target.userId, { reason: 'y'.repeat(501), currentPassword: admin.password })).status).toBe(400);
    // Wrong password: refused, nothing changes.
    expect((await reset(adminToken, target.userId, { reason: 'lost phone', currentPassword: 'wrong' })).status).toBe(403);
    expect((await mfaRow(target.userId)).totp_enabled).toBe(true);

    // An UN-ENROLLED admin is never forced to enrol: reason + own password resets another account's factor.
    const target2 = await manager('w4t2');
    await enrol(target2, await accessToken(target2), 0);
    const byUnenrolled = await reset(adminToken, target2.userId, { reason: '  Lost phone, ticket #42  ', currentPassword: admin.password });
    expect(byUnenrolled.status).toBe(200);
    expect(byUnenrolled.body).toMatchObject({ reset: true });
    expect((await mfaRow(target2.userId)).totp_enabled).toBe(false);
    const reasons = await owner.query(`SELECT metadata->>'reason' AS reason FROM core.audit_log WHERE action = 'user.mfa_reset_by_admin' AND target_user_id = $1`, [target2.userId]);
    expect(reasons.map((r: { reason: string }) => r.reason)).toEqual(['Lost phone, ticket #42', 'Lost phone, ticket #42']);
    // Nothing left to reset: a clear no-op error, nothing changes.
    const again = await reset(adminToken, target2.userId, { reason: 'again', currentPassword: admin.password });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('MFA_NOT_ENABLED');

    await earlyInStep(10);
    const adminMfa = await enrol(admin, adminToken, -1);
    // Admin now has MFA: every login needs it; keep using the enrolling session (still valid).
    const self = await reset(adminToken, admin.userId, { reason: 'self', currentPassword: admin.password, code: codeAt(adminMfa.secret, 0) });
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('MFA_RESET_SELF');
    // An ENROLLED admin must add their own current code; the password alone is refused.
    expect((await reset(adminToken, target.userId, { reason: 'lost phone', currentPassword: admin.password })).status).toBe(403);
    expect((await reset(adminToken, target.userId, { reason: 'lost phone', currentPassword: 'wrong', code: codeAt(adminMfa.secret, 1) })).status).toBe(403);
    expect((await reset(adminToken, target.userId, { reason: 'lost phone', currentPassword: admin.password, code: '000000' })).status).toBe(403);
    // A recovery code is not accepted as the ADMIN's proof (TOTP only for this action).
    expect((await reset(adminToken, target.userId, { reason: 'lost phone', currentPassword: admin.password, code: adminMfa.recoveryCodes[0] })).status).toBe(403);
    expect((await mfaRow(target.userId)).totp_enabled).toBe(true);

    const done = await reset(adminToken, target.userId, { reason: 'lost phone', currentPassword: admin.password, code: codeAt(adminMfa.secret, 1) });
    expect(done.status).toBe(200);
    expect(done.body.reset).toBe(true);
    expect(done.body.revokedSessions).toBeGreaterThanOrEqual(1);
    expect((await mfaRow(target.userId)).totp_enabled).toBe(false);
    expect(await sessions(target.userId)).toBe(0);
    expect((await http().get('/rest/v1/auth/me').set(bearer(targetSession))).status).toBe(401);
    const rows = await owner.query(`SELECT organisation_id FROM core.audit_log WHERE action = 'user.mfa_reset_by_admin' AND target_user_id = $1`, [target.userId]);
    expect(rows.map((r: { organisation_id: string }) => r.organisation_id).sort()).toEqual([admin.organisationId, target.organisationId].sort());
  });

  // ---------------------------------------------------------------- enforcement

  it('enforcement defaults OFF: an un-enrolled CEO signs in with a password as before (no lockout on deploy)', async () => {
    const { organisation } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w4c0' });
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    expect((await loginWeb(ceo)).status).toBe(200);
  });

  it('ABUSE: an ENFORCED role without a factor gets the enrolment-required flow (not a lockout), then cannot switch MFA off', async () => {
    overrides.AUTH_MFA_ENFORCE_ORGANISATION_OWNER = true;
    const { organisation } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w4c1' });
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    const res = await loginWeb(ceo);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'enroll' });
    expect(res.body.accessToken).toBeUndefined();
    const token = res.body.challengeToken as string;
    // The verify step is the wrong one for this challenge.
    expect((await verify(token, '123456')).body.code).toBe('MFA_WRONG_STEP');
    const material = await http().post('/rest/v1/auth/mfa/challenge/enrolment').set('Origin', ORIGIN).send({ challengeToken: token });
    expect(material.status).toBe(200);
    const secret = secretFromOtpauth(material.body.otpauthUri);
    const bad = await http().post('/rest/v1/auth/mfa/challenge/enrolment/confirm').set('Origin', ORIGIN).send({ challengeToken: token, code: '000000' });
    expect(bad.status).toBe(401);
    const done = await http().post('/rest/v1/auth/mfa/challenge/enrolment/confirm').set('Origin', ORIGIN).send({ challengeToken: token, code: codeAt(secret, 0) });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCodes).toHaveLength(10);
    expect(done.body.accessToken).toBeTruthy();
    expect((await mfaRow(ceo.userId)).totp_enabled).toBe(true);
    const status = await http().get('/rest/v1/auth/mfa').set(bearer(done.body.accessToken));
    expect(status.body).toMatchObject({ enabled: true, enforced: true });
    const off = await http().post('/rest/v1/auth/mfa/disable').set(bearer(done.body.accessToken)).send({ currentPassword: ceo.password, code: done.body.recoveryCodes[0] });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('MFA_REQUIRED_BY_POLICY');
    // The policy refusal burned nothing: the recovery code still works.
    expect((await verify(await challenge(ceo), done.body.recoveryCodes[0])).status).toBe(200);
  });

  // ---------------------------------------------------------------- mobile + providers

  // Lane D (owner decision M10-1): the mobile exemption covers ONLY the staff / venue-manager workforce. An ENROLLED
  // manager is challenged on mobile exactly as on web (this case asserted the old manager-tier bypass, 200, until then).
  it('mobile sign-in: an enrolled MANAGER is challenged on mobile too (M10-1), also with =require; staff are never challenged by web enforcement', async () => {
    const who = await manager('w4m');
    const token = await accessToken(who);
    await enrol(who, token, 0);
    const mobile = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').set('x-client-capabilities', 'mfa-verify').send({ email: who.email, password: who.password, applicationTarget: 'staff_app' });
    expect(mobile.status).toBe(409);
    expect(mobile.body.code).toBe('SECOND_FACTOR_REQUIRED');
    expect(mobile.body.refreshToken).toBeUndefined();
    overrides.AUTH_MFA_MOBILE_POLICY = 'require';
    const required = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').set('x-client-capabilities', 'mfa-verify').send({ email: who.email, password: who.password, applicationTarget: 'staff_app' });
    expect(required.status).toBe(409);
    delete overrides.AUTH_MFA_MOBILE_POLICY;

    overrides.AUTH_MFA_ENFORCE_OTHER_WEB_USERS = true;
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w4ms' });
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'w4mss' });
    const staffLogin = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: staff.email, password: staff.password });
    expect(staffLogin.status).toBe(200);
  });

  it('Google sign-in of an enrolled account is challenged at the same convergence point; a first-time provider link is written only after the factor', async () => {
    const who = await manager('w4g');
    const token = await accessToken(who);
    const { recoveryCodes } = await enrol(who, token, 0);
    const subject = `w4-google-${randomUUID()}`;
    let challengeToken = '';
    try {
      await auth.signInWithProvider('google', { subject, email: who.email, emailVerified: true }, { ip: '203.0.113.70' });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(409);
      challengeToken = ((error as HttpException).getResponse() as { challengeToken: string }).challengeToken;
    }
    expect(challengeToken).toMatch(/^mfc_/);
    const linked = async () => (await owner.query(`SELECT count(*)::int AS n FROM core.user_auth_identity WHERE provider_subject = $1`, [subject]))[0].n as number;
    expect(await linked()).toBe(0);
    const done = await verify(challengeToken, recoveryCodes[0]!);
    expect(done.status).toBe(200);
    expect(await linked()).toBe(1);
    const sessionProvider = await owner.query(`SELECT auth_provider FROM core.user_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [who.userId]);
    expect(sessionProvider[0].auth_provider).toBe('google');
  });

  it('ABUSE: a challenge dies when the account changes underneath it (password reset → security version moved)', async () => {
    const who = await manager('w4v');
    const token = await accessToken(who);
    const { recoveryCodes } = await enrol(who, token, 0);
    const c = await challenge(who);
    await owner.query(`UPDATE core."user" SET security_version = security_version + 1 WHERE id = $1`, [who.userId]);
    const res = await verify(c, recoveryCodes[0]!);
    expect(res.status).toBe(401);
    expect(await sessions(who.userId)).toBe(1); // only the enrolling session; nothing new issued
  });
});
