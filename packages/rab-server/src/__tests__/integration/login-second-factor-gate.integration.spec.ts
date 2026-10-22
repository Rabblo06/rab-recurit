import 'reflect-metadata';
import { HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { LoginSecondFactorPolicyService, SecondFactorRequirement } from '../../engine/core-modules/auth/services/login-second-factor-policy.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { createAdminDataSource } from './helpers/admin-datasource';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

/**
 * Wave 1 lane A — finding D-A3. The existing second-factor gate (`LoginSecondFactorPolicyService`) was consulted only by
 * the OAuth handoff; password sign-in (web and mobile) and the direct provider path never asked it. It is now called in
 * `AuthService.completeLogin`, the one convergence point. Crewflow has no enrolment yet, so the real policy answers
 * 'none' (inert); here the policy is replaced by a controllable stub to prove the WIRING: whenever it demands a factor,
 * no provider can obtain a session, and nothing (session, success login_history row, provider link) is written.
 */
const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('wave 1 lane A — second-factor gate on every sign-in path (integration)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let auth: AuthService;
  let manager: TestIdentity;
  let staff: TestIdentity;
  let requirement: SecondFactorRequirement = 'none';
  const policy = { requirementFor: jest.fn(async () => requirement) };

  const http = () => request(app.getHttpServer());
  const sessions = async (userId: string) => (await owner.query(`SELECT count(*)::int AS n FROM core.user_session WHERE user_id = $1`, [userId]))[0].n as number;
  const successRows = async (userId: string) =>
    (await owner.query(`SELECT count(*)::int AS n FROM core.login_history WHERE user_id = $1 AND success = true`, [userId]))[0].n as number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(LoginSecondFactorPolicyService).useValue(policy).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    auth = moduleRef.get(AuthService);
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    const seeded = await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w1mfa' });
    manager = seeded.managers[0]!;
    staff = await factory.createStaff(seeded.organisation, { owner: manager, label: 'w1mfas' });
    await owner.query(`UPDATE core.organisation SET google_auth_enabled = true WHERE id = $1`, [seeded.organisation.id]);
  });

  beforeEach(() => {
    requirement = 'none';
    policy.requirementFor.mockClear();
  });

  afterAll(async () => {
    await owner?.destroy();
    await app?.close();
  });

  it("inert by default: with the policy answering 'none', web and mobile password sign-in work, and the gate WAS consulted with the resolved identity", async () => {
    expect((await http().post('/rest/v1/auth/login').send({ email: manager.email, password: manager.password })).status).toBe(200);
    expect(policy.requirementFor).toHaveBeenCalledWith({ userId: manager.userId, organisationId: manager.organisationId });
    const mobile = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: staff.email, password: staff.password });
    expect(mobile.status).toBe(200);
    expect(policy.requirementFor).toHaveBeenCalledWith({ userId: staff.userId, organisationId: staff.organisationId });
  });

  it.each(['verify', 'enroll'] as const)("web password sign-in is refused with 409 SECOND_FACTOR_REQUIRED when the policy says '%s', and no session is issued", async (answer) => {
    requirement = answer;
    const before = { s: await sessions(manager.userId), h: await successRows(manager.userId) };
    const res = await http().post('/rest/v1/auth/login').send({ email: manager.email, password: manager.password });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', requirement: answer });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.accessToken).toBeUndefined();
    expect(await sessions(manager.userId)).toBe(before.s);
    expect(await successRows(manager.userId)).toBe(before.h);
  });

  it('mobile password sign-in (Bearer clients) is gated the same way', async () => {
    requirement = 'verify';
    const before = await sessions(staff.userId);
    const res = await http().post('/rest/v1/auth/login').set('x-client-platform', 'mobile').send({ email: staff.email, password: staff.password });
    expect(res.status).toBe(409);
    expect(res.body.refreshToken).toBeUndefined();
    expect(await sessions(staff.userId)).toBe(before);
  });

  it('a WRONG password is still the uniform 401 — the gate runs only after the password is proven, so it is no oracle', async () => {
    requirement = 'verify';
    const res = await http().post('/rest/v1/auth/login').send({ email: manager.email, password: 'definitely-wrong' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
    expect(policy.requirementFor).not.toHaveBeenCalled();
  });

  it('the direct Google provider path is gated at the same convergence point, before the first-time provider link is written', async () => {
    requirement = 'verify';
    const subject = `w1-mfa-${randomUUID()}`;
    let status = 0;
    try {
      await auth.signInWithProvider('google', { subject, email: manager.email, emailVerified: true }, { ip: '203.0.113.40' });
    } catch (error) {
      status = error instanceof HttpException ? error.getStatus() : -1;
    }
    expect(status).toBe(409);
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM core.user_auth_identity WHERE provider_subject = $1`, [subject]);
    expect(n).toBe(0);
  });
});
