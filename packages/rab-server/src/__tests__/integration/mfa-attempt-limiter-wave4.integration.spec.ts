import 'reflect-metadata';

// Wave 4 lane MFA — the per-user second-factor attempt bucket with the REAL limiter (jest-setup.ts disables limiters for
// every other suite). Burst of 4 per user, refilling over 60 s. Set before AppModule loads; restored in afterAll.
const ORIGINAL = {
  RAB_DISABLE_RATE_LIMIT: process.env.RAB_DISABLE_RATE_LIMIT,
  AUTH_MFA_USER_ATTEMPTS_BURST: process.env.AUTH_MFA_USER_ATTEMPTS_BURST,
  AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS: process.env.AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS,
};
process.env.RAB_DISABLE_RATE_LIMIT = 'false';
process.env.AUTH_MFA_USER_ATTEMPTS_BURST = '4';
process.env.AUTH_MFA_USER_ATTEMPTS_WINDOW_SECONDS = '60';

import { HttpException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from '../../app.module';
import { AuthCacheRedisClientProvider } from '../../engine/core-modules/auth/services/auth-cache-redis-client.provider';
import { AuthService } from '../../engine/core-modules/auth/services/auth.service';
import { MfaLoginService } from '../../engine/core-modules/auth/services/mfa-login.service';
import { MfaManagementService } from '../../engine/core-modules/auth/services/mfa-management.service';
import { PasswordHashingService } from '../../engine/core-modules/auth/services/password-hashing.service';
import { AuthContext } from '../../engine/core-modules/tenant/auth-context.interface';
import { TenantContextService } from '../../engine/core-modules/tenant/tenant-context.service';
import { ThrottlerRedisClientProvider } from '../../engine/core-modules/throttler/throttler-redis-client.provider';
import { createAdminDataSource } from './helpers/admin-datasource';
import { codeAt, secretFromOtpauth } from './helpers/mfa-test-kit';
import { clearLoginLimiterState, clearThrottleState } from './helpers/throttle-state';
import { TestIdentity, TestIdentityFactory } from './helpers/test-identities';

const RUN = Boolean(process.env.DATABASE_URL);
const describeIfDb = RUN ? describe : describe.skip;

describeIfDb('wave 4 lane MFA — per-user second-factor attempt limit (REAL limiter)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let owner: DataSource;
  let auth: AuthService;
  let mfaLogin: MfaLoginService;
  let mfa: MfaManagementService;
  let authRedis: AuthCacheRedisClientProvider;
  let throttlerRedis: ThrottlerRedisClientProvider;
  let who: TestIdentity;
  let ip = 10;

  const status = async (run: () => Promise<unknown>): Promise<{ status: number; code?: string }> => {
    try {
      await run();
      return { status: 200 };
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      return { status: error.getStatus(), code: (error.getResponse() as { code?: string }).code };
    }
  };

  /** A fresh challenge from a fresh address (so the per-(email, IP) password buckets never interfere). */
  async function challenge(): Promise<string> {
    try {
      await auth.login({ email: who.email, password: who.password }, { ip: `198.51.100.${ip++}`, userAgent: 'jest-mfa-limiter' });
    } catch (error) {
      return ((error as HttpException).getResponse() as { challengeToken: string }).challengeToken;
    }
    throw new Error('expected a second-factor challenge');
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    owner = createAdminDataSource();
    await owner.initialize();
    auth = moduleRef.get(AuthService);
    mfaLogin = moduleRef.get(MfaLoginService);
    mfa = moduleRef.get(MfaManagementService);
    authRedis = moduleRef.get(AuthCacheRedisClientProvider);
    throttlerRedis = moduleRef.get(ThrottlerRedisClientProvider);
    await clearLoginLimiterState(authRedis.client);
    await clearThrottleState(throttlerRedis);
    const factory = new TestIdentityFactory({
      app,
      dataSource: moduleRef.get(DataSource),
      adminDataSource: owner,
      tenantContext: moduleRef.get(TenantContextService),
      passwordHashing: moduleRef.get(PasswordHashingService),
    });
    who = (await factory.createOrganisationWithManagers(1, { permissions: 'production', workspace: true, label: 'w4lim' })).managers[0]!;
  });

  afterAll(async () => {
    await clearLoginLimiterState(authRedis.client).catch(() => undefined);
    await clearThrottleState(throttlerRedis).catch(() => undefined);
    await owner?.destroy();
    await app?.close();
    for (const [key, value] of Object.entries(ORIGINAL)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('ABUSE: wrong codes spread over several challenges and addresses hit ONE per-user bucket (429), and a refused attempt consumes nothing', async () => {
    const ctx: AuthContext = { organisationId: who.organisationId, workspaceId: who.workspaceId, userId: who.userId, role: '' };
    const material = await mfa.startEnrolment(ctx, who.password);
    const { recoveryCodes } = await mfa.confirmEnrolment(ctx, codeAt(secretFromOtpauth(material.otpauthUri), 0)); // attempt 1 of 4

    const c1 = await challenge();
    expect(await status(() => mfaLogin.verifyChallenge(c1, '111111', false, { ip: '198.51.100.200' }))).toMatchObject({ status: 401, code: 'MFA_CODE_INVALID' }); // 2
    expect(await status(() => mfaLogin.verifyChallenge(c1, '222222', false, { ip: '198.51.100.201' }))).toMatchObject({ status: 401 }); // 3
    const c2 = await challenge();
    expect(await status(() => mfaLogin.verifyChallenge(c2, '333333', false, { ip: '198.51.100.202' }))).toMatchObject({ status: 401 }); // 4
    // Bucket empty: even a CORRECT recovery code, on a new challenge from a new address, is refused before it is checked.
    const c3 = await challenge();
    expect(await status(() => mfaLogin.verifyChallenge(c3, recoveryCodes[0]!, false, { ip: '198.51.100.203' }))).toMatchObject({ status: 429, code: 'MFA_RATE_LIMITED' });
    const [{ n }] = await owner.query(`SELECT count(*)::int AS n FROM core.user_mfa_recovery_code WHERE user_id = $1 AND used_at IS NOT NULL`, [who.userId]);
    expect(n).toBe(0);

    // Slowed down, never locked: once the bucket refills (simulated by clearing it), the same code works.
    await clearLoginLimiterState(authRedis.client);
    const c4 = await challenge();
    expect(await status(() => mfaLogin.verifyChallenge(c4, recoveryCodes[0]!, false, { ip: '198.51.100.204' }))).toEqual({ status: 200 });
  });
});
