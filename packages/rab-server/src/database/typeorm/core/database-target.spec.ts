import { ALLOW_PRODUCTION_DB_COMMANDS, DbTargetError, EXPECTED_PRODUCTION_IDENTITY, resolveDbTarget } from './database-target';

// Fake credentials only. Every refusal test asserts this never appears in the message.
const SECRET = 'S3cret-PW-do-not-print';
const NEON_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const NEON_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const OTHER_NEON_DIRECT = `postgres://rab_owner:${SECRET}@ep-other-endpoint-xyz.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const LOCAL = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const DOCKER_SERVICE = `postgres://rab_owner:${SECRET}@postgres:5432/rab`;
const LOCAL_OTHER_DB = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_other`;

function run(env: Record<string, string | undefined>, dotenvValues: Record<string, string> = {}) {
  return resolveDbTarget({ purpose: 'migrations', env, dotenvValues });
}

function expectRefused(env: Record<string, string | undefined>, pattern: RegExp, dotenvValues: Record<string, string> = {}): string {
  let message = '';
  try {
    run(env, dotenvValues);
  } catch (error) {
    expect(error).toBeInstanceOf(DbTargetError);
    message = (error as Error).message;
  }
  expect(message).toMatch(pattern);
  expect(message).not.toContain(SECRET);
  expect(message).not.toMatch(/postgres:\/\//);
  return message;
}

const PROD_ENV = (urls: { app: string; admin?: string }): Record<string, string | undefined> => ({
  DB_TARGET: 'production',
  [ALLOW_PRODUCTION_DB_COMMANDS]: 'true',
  DATABASE_URL: urls.app,
  ...(urls.admin ? { DATABASE_URL_UNPOOLED: urls.admin } : {}),
});

describe('database target guard (pure resolution)', () => {
  it('1. refuses when DB_TARGET is missing, and names the variable and the choices', () => {
    expectRefused({ DATABASE_URL: LOCAL }, /DB_TARGET is required.*local, test, staging, production/);
  });

  it('2. refuses an unrecognised DB_TARGET', () => {
    expectRefused({ DB_TARGET: 'prod', DATABASE_URL: LOCAL }, /DB_TARGET "prod" is not recognised/);
  });

  it('3. refuses staging, because no staging identity is configured (fail closed)', () => {
    expectRefused({ DB_TARGET: 'staging', DATABASE_URL: LOCAL }, /staging is refused/);
  });

  it('4. production without ALLOW_PRODUCTION_DB_COMMANDS is refused, even with the right identity', () => {
    expectRefused(
      { DB_TARGET: 'production', DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: NEON_DIRECT },
      /requires DB_TARGET=production AND ALLOW_PRODUCTION_DB_COMMANDS=true/,
    );
  });

  it('5. ALLOW_PRODUCTION_DB_COMMANDS grants nothing on its own: a local target stays local, a remote one stays refused', () => {
    expect(run({ DB_TARGET: 'local', [ALLOW_PRODUCTION_DB_COMMANDS]: 'true', DATABASE_URL: LOCAL }).classification).toBe(
      'NON-PRODUCTION',
    );
    expectRefused({ DB_TARGET: 'local', [ALLOW_PRODUCTION_DB_COMMANDS]: 'true', DATABASE_URL: NEON_POOLED }, /refuses a remote host/);
  });

  it('6. production authority present in .env is refused, even if the process environment repeats it', () => {
    const env = PROD_ENV({ app: NEON_POOLED, admin: NEON_DIRECT });
    expectRefused(env, /present in packages\/rab-server\/\.env/, { DATABASE_URL: NEON_POOLED });
    expectRefused(env, /present in packages\/rab-server\/\.env/, { [ALLOW_PRODUCTION_DB_COMMANDS]: 'true' });
    expectRefused(env, /present in packages\/rab-server\/\.env/, { DB_TARGET: 'production' });
  });

  it('7. production with the allow flag, but a different endpoint, is refused on identity', () => {
    expectRefused(PROD_ENV({ app: OTHER_NEON_DIRECT }), /is not the expected production identity/);
    expectRefused(PROD_ENV({ app: LOCAL_OTHER_DB }), /is not the expected production identity/);
  });

  it('8. production with the allow flag, the expected identity, and values from the process environment is accepted', () => {
    const resolved = run(PROD_ENV({ app: NEON_POOLED, admin: NEON_DIRECT }), {
      // .env present but holding different (or no) production values: not a match, so it is allowed.
      DATABASE_URL: 'postgres://other:x@localhost:5432/other',
    });
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.app.endpointKey).toBe(EXPECTED_PRODUCTION_IDENTITY.endpointKey);
    expect(resolved.app.database).toBe(EXPECTED_PRODUCTION_IDENTITY.database);
    expect(resolved.admin?.pooled).toBe(false);
  });

  it('9. a production app/admin pair that disagrees on endpoint is refused before identity', () => {
    expectRefused(PROD_ENV({ app: NEON_POOLED, admin: OTHER_NEON_DIRECT }), /different databases or endpoints/);
  });

  it('10. local accepts a loopback database and a docker-service hostname, classified NON-PRODUCTION', () => {
    expect(run({ DB_TARGET: 'local', DATABASE_URL: LOCAL }).classification).toBe('NON-PRODUCTION');
    expect(run({ DB_TARGET: 'local', DATABASE_URL: DOCKER_SERVICE }).classification).toBe('NON-PRODUCTION');
  });

  it('11. local refuses a dotted remote host such as Neon, and says so without the URL', () => {
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: NEON_POOLED }, /DB_TARGET=local refuses a remote host/);
  });

  it('12. local refuses a remote admin URL even when the app URL is local', () => {
    expectRefused(
      { DB_TARGET: 'local', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: NEON_DIRECT },
      /different databases or endpoints|refuses a remote DATABASE_URL_UNPOOLED/,
    );
  });

  it('13. app and admin URLs naming different local databases are refused', () => {
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OTHER_DB }, /different databases or endpoints/);
  });

  it('14. test target uses the same rule, and a remote host needs the explicit test override', () => {
    expectRefused({ DB_TARGET: 'test', DATABASE_URL: NEON_POOLED }, /refuses a remote host/);
    expect(
      run({ DB_TARGET: 'test', DATABASE_URL: OTHER_NEON_DIRECT, ALLOW_REMOTE_TEST_DATABASE: 'true' }).classification,
    ).toBe('NON-PRODUCTION');
    // Even with the override, a test target can never be the production endpoint.
    expectRefused(
      { DB_TARGET: 'test', DATABASE_URL: NEON_DIRECT, ALLOW_REMOTE_TEST_DATABASE: 'true' },
      /points at the expected production endpoint/,
    );
  });

  it('15. a missing DATABASE_URL is refused, and the normal .env name is never a substitute for DB_TARGET', () => {
    expectRefused({ DB_TARGET: 'local' }, /DATABASE_URL is required/);
  });

  it('16. no refusal message contains a credential, including for a malformed URL', () => {
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: `not a url ${SECRET}` }, /is not a parseable postgres URL/);
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: NEON_POOLED }, /refuses a remote host/);
    expectRefused(PROD_ENV({ app: OTHER_NEON_DIRECT }), /not the expected production identity/);
  });
});
