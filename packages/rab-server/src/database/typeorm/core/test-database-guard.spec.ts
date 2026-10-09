import {
  ALLOW_REMOTE_TEST_DATABASE,
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_UNPOOLED,
  TestDatabaseConfigError,
  applyIntegrationTestDatabaseEnv,
  resolveIntegrationTestDatabase,
} from './test-database-guard';

// Obviously fake credentials. The abuse tests assert these never appear in any error message.
const SECRET = 'S3cret-PW-do-not-print';
const LOCAL_APP = `postgres://rab_app:${SECRET}@127.0.0.1:55462/rab_test_a`;
const LOCAL_ADMIN = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_test_a`;
const LOCAL_OTHER_DB_ADMIN = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_test_b`;
const NEON_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const NEON_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;

function expectRefused(env: Record<string, string | undefined>, pattern: RegExp): string {
  let message = '';
  try {
    resolveIntegrationTestDatabase(env);
  } catch (error) {
    expect(error).toBeInstanceOf(TestDatabaseConfigError);
    message = (error as Error).message;
  }
  expect(message).toMatch(pattern);
  expect(message).not.toContain(SECRET);
  return message;
}

describe('integration test database guard', () => {
  it('1. refuses when TEST_DATABASE_URL is missing, and names the variable', () => {
    expectRefused({ [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }, /TEST_DATABASE_URL is required/);
  });

  it('2. refuses when TEST_DATABASE_URL_UNPOOLED is missing, and names the variable', () => {
    expectRefused({ [TEST_DATABASE_URL]: LOCAL_APP }, /TEST_DATABASE_URL_UNPOOLED is required/);
  });

  it('3. refuses a local application URL paired with a Neon admin URL, before any fixture setup', () => {
    expectRefused(
      { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT },
      /(different databases|different endpoints|Remote test database)/,
    );
  });

  it('4. refuses an application URL and an admin URL that name different local databases', () => {
    expectRefused(
      { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_OTHER_DB_ADMIN },
      /different databases \("rab_test_a" vs "rab_test_b"\)/,
    );
  });

  it('5. accepts a matching local test database, and it resolves only from the TEST_* pair', () => {
    const resolved = resolveIntegrationTestDatabase({ [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN });
    expect(resolved.app.database).toBe('rab_test_a');
    expect(resolved.admin.database).toBe('rab_test_a');
    expect(resolved.app.remote).toBe(false);
  });

  it('6a. refuses a remote (Neon) test database without the explicit override', () => {
    expectRefused(
      { [TEST_DATABASE_URL]: NEON_POOLED, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT },
      /Remote test database "ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech" refused/,
    );
  });

  it('6b. accepts pooled and direct Neon URLs of the same endpoint when the override is explicit', () => {
    const resolved = resolveIntegrationTestDatabase({
      [TEST_DATABASE_URL]: NEON_POOLED,
      [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT,
      [ALLOW_REMOTE_TEST_DATABASE]: 'true',
    });
    expect(resolved.app.pooled).toBe(true);
    expect(resolved.admin.pooled).toBe(false);
    expect(resolved.app.endpointKey).toBe(resolved.admin.endpointKey);
  });

  it('6c. does not treat the override as enough when the explicit TEST pair is missing', () => {
    expectRefused({ [ALLOW_REMOTE_TEST_DATABASE]: 'true', [TEST_DATABASE_URL]: NEON_POOLED }, /TEST_DATABASE_URL_UNPOOLED is required/);
  });

  it('7. production-looking normal .env values are never consumed by Jest', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: NEON_POOLED,
      DATABASE_URL_UNPOOLED: NEON_DIRECT,
    };
    expect(() => applyIntegrationTestDatabaseEnv(env)).toThrow(/TEST_DATABASE_URL is required/);
    // Even when the TEST pair is valid, the normal values are overwritten, not kept.
    const valid: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      DATABASE_URL: NEON_POOLED,
      DATABASE_URL_UNPOOLED: NEON_DIRECT,
      [TEST_DATABASE_URL]: LOCAL_APP,
      [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN,
    };
    applyIntegrationTestDatabaseEnv(valid);
    expect(valid.DATABASE_URL).toBe(LOCAL_APP);
    expect(valid.DATABASE_URL_UNPOOLED).toBe(LOCAL_ADMIN);
  });

  it('8. error messages never contain credentials, including for a malformed URL', () => {
    expectRefused({ [TEST_DATABASE_URL]: `not a url ${SECRET}`, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_ADMIN }, /not a parseable postgres URL/);
    expectRefused(
      { [TEST_DATABASE_URL]: LOCAL_APP, [TEST_DATABASE_URL_UNPOOLED]: LOCAL_OTHER_DB_ADMIN },
      /different databases/,
    );
    expectRefused(
      { [TEST_DATABASE_URL]: NEON_POOLED, [TEST_DATABASE_URL_UNPOOLED]: NEON_DIRECT },
      /refused/,
    );
  });

  it('is inert outside NODE_ENV=test, so the runtime and CLI are unaffected', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production', DATABASE_URL: NEON_POOLED };
    expect(applyIntegrationTestDatabaseEnv(env)).toBeNull();
    expect(env.DATABASE_URL).toBe(NEON_POOLED);
  });
});
