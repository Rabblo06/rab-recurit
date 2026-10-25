import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { MfaManagementService } from '../../engine/core-modules/auth/services/mfa-management.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { EnvironmentService } from '../../engine/core-modules/environment/environment.service';
import { EnvironmentVariables } from '../../engine/core-modules/environment/environment-variables';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { codeAt, secretFromOtpauth } from './helpers/mfa-test-kit';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Lane D (owner decision M10-1): the mobile second-factor exemption covers ONLY the staff / venue-manager workforce.
 * Before this lane, `AUTH_MFA_MOBILE_POLICY=exempt` exempted every mobile target, so an ENROLLED manager-tier account
 * (CEO, Initial Manager, manager, platform admin — all allowed on the mobile apps by `applicationAllowed`) got a full
 * mobile session with the password alone. Real HTTP, real DB5 MFA functions, real Redis challenges.
 *
 * Requires a database with DB5's MFA migrations (fails loudly otherwise).
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;
const ORIGIN = 'http://localhost:5173';

describeIfDb('lane D — mobile second factor for every tier above staff / venue manager (integration)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let owner: DataSource;
  let factory: TestIdentityFactory;
  let mfa: MfaManagementService;
  const overrides: Partial<Record<keyof EnvironmentVariables, unknown>> = {};
  const http = () => request(app.getHttpServer());

  const liveSessions = async (userId: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL`, [userId]))[0].n as number;
  /** A CURRENT mobile build: declares the code screen (account security step 1, P3: `X-Client-Capabilities: mfa-verify`). */
  const mobileLogin = (who: Pick<TestIdentity, 'email' | 'password'>, applicationTarget?: string, capabilities: string | null = 'mfa-verify') => {
    const req = http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile');
    if (capabilities !== null) req.set('x-client-capabilities', capabilities);
    return req.send(applicationTarget ? { email: who.email, password: who.password, applicationTarget } : { email: who.email, password: who.password });
  };
  const mobileVerify = (challengeToken: string, code: string) =>
    http().post('/rest/v1/auth/mfa/challenge/verify').set('x-client-platform', 'mobile').send({ challengeToken, code });

  /**
   * Enrols through the real service (no route): the settings route is manager-web only, but the point here is the
   * POLICY's answer for a workforce identity that holds a factor, so the factor is created exactly as settings would.
   */
  async function enrolViaService(who: TestIdentity): Promise<Buffer> {
    const ctx: AuthContext = { organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' };
    const material = await mfa.startEnrolment(ctx, { currentPassword: who.password });
    const secret = secretFromOtpauth(material.otpauthUri);
    await mfa.confirmEnrolment(ctx, codeAt(secret, -1));
    return secret;
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
    mfa = moduleRef.get(MfaManagementService);
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

  it('ABUSE: an ENROLLED manager signing in on mobile with the password alone gets a challenge and NO session — on every mobile target, whatever it claims', async () => {
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldm' });
    const who = managers[0]!;
    await enrolViaService(who);
    const before = await liveSessions(who.userId);
    for (const target of [undefined, 'staff_app', 'venue_manager_app']) {
      const res = await mobileLogin(who, target);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
      expect(res.body.challengeToken).toMatch(/^mfc_/);
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
    }
    expect(await liveSessions(who.userId)).toBe(before);
    const success = await owner.query(`SELECT count(*)::int AS n FROM core.login_history WHERE user_id = $1 AND success`, [who.userId]);
    expect(success[0].n).toBe(0);
  });

  it('the mobile challenge completes with a current code (tokens in the body, mobile target); the challenge and the code are single use; web cannot finish it', async () => {
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldv' });
    const who = managers[0]!;
    const secret = await enrolViaService(who);
    const first = await mobileLogin(who);
    expect(first.status).toBe(409);
    // Transport binding: the web transport cannot finish a mobile challenge (and burns nothing it can use).
    const viaWeb = await http().post('/rest/v1/auth/mfa/challenge/verify').set('Origin', ORIGIN).send({ challengeToken: first.body.challengeToken, code: codeAt(secret, 0) });
    expect(viaWeb.status).toBe(401);
    const second = await mobileLogin(who);
    const code = codeAt(secret, 0);
    const done = await mobileVerify(second.body.challengeToken, code);
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toBeTruthy();
    expect(done.body.refreshToken).toBeTruthy();
    const [session] = await owner.query(`SELECT application_target FROM core.user_session WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [who.userId]);
    expect(session.application_target).toBe('staff_app');
    // Replay: the same challenge again, and the same code on a fresh challenge, are both refused.
    expect((await mobileVerify(second.body.challengeToken, code)).status).toBe(401);
    const third = await mobileLogin(who);
    expect((await mobileVerify(third.body.challengeToken, code)).status).toBe(401);
  });

  it('ABUSE: wrong codes exhaust a mobile challenge (then even a correct code fails); nothing is issued', async () => {
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldx' });
    const who = managers[0]!;
    const secret = await enrolViaService(who);
    const before = await liveSessions(who.userId);
    const c = await mobileLogin(who);
    for (let i = 0; i < 5; i++) expect((await mobileVerify(c.body.challengeToken, '000000')).status).toBe(401);
    expect((await mobileVerify(c.body.challengeToken, codeAt(secret, 0))).status).toBe(401);
    expect(await liveSessions(who.userId)).toBe(before);
  });

  it('ABUSE: an enrolled CEO and an enrolled PLATFORM ADMIN are challenged on mobile too', async () => {
    const organisation = await factory.createOrganisation('ldc');
    const ceo = await factory.createCeo(organisation, { permissions: 'production' });
    await enrolViaService(ceo);
    expect((await mobileLogin(ceo)).status).toBe(409);

    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldp', firstIsPlatformAdmin: true });
    const admin = managers[0]!;
    await enrolViaService(admin);
    const res = await mobileLogin(admin, 'staff_app');
    expect(res.status).toBe(409);
    expect(res.body.requirement).toBe('verify');
  });

  it('ABUSE: an ENFORCED higher-tier role without a factor gets requirement=enroll on mobile — no password-only session', async () => {
    overrides.AUTH_MFA_ENFORCE_OTHER_WEB_USERS = true;
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'lde' });
    const who = managers[0]!;
    const before = await liveSessions(who.userId);
    const res = await mobileLogin(who);
    expect(res.status).toBe(409);
    expect(res.body.requirement).toBe('enroll');
    expect(res.body.refreshToken).toBeUndefined();
    expect(await liveSessions(who.userId)).toBe(before);
  });

  it('STEP 1 (abuse, was the lane-D bypass): an ENROLLED staff member / venue manager is challenged on mobile under EVERY AUTH_MFA_MOBILE_POLICY value — no password-only session', async () => {
    const { organisation, managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldw' });
    const staff = await factory.createStaff(organisation, { owner: managers[0]!, label: 'ldws' });
    const vm = await factory.createVenueManager(organisation, { owner: managers[0]!, label: 'ldwv' });
    await enrolViaService(staff);
    await enrolViaService(vm);
    for (const policy of ['exempt', 'require'] as const) {
      overrides.AUTH_MFA_MOBILE_POLICY = policy;
      for (const who of [staff, vm]) {
        const before = await liveSessions(who.userId);
        const res = await mobileLogin(who);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: 'verify' });
        expect(res.body.accessToken).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
        expect(await liveSessions(who.userId)).toBe(before);
      }
    }
    const success = await owner.query(`SELECT count(*)::int AS n FROM core.login_history WHERE user_id = ANY($1) AND success`, [[staff.userId, vm.userId]]);
    expect(success[0].n).toBe(0);
  });

  it('an un-enrolled, un-enforced manager on mobile is not locked out (no factor to verify)', async () => {
    const { managers } = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'ldn' });
    const res = await mobileLogin(managers[0]!);
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeTruthy();
  });
});
