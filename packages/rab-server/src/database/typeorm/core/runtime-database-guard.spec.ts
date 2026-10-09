import { ALLOW_PRODUCTION_DB_COMMANDS } from './database-target';
import { RuntimeDbError, resolveRuntimeDatabase } from './runtime-database-guard';

// Fake credentials only. Every refusal asserts this never appears in the message.
const SECRET = 'S3cret-PW-do-not-print';
const PROD_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const PROD_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const OTHER_NEON = `postgres://rab_owner:${SECRET}@ep-other-endpoint-xyz.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const LOCAL = `postgres://rab_app:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const LOCAL_OWNER = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;

function resolve(
  processName: 'api' | 'worker',
  env: Record<string, string | undefined>,
  dotenvValues: Record<string, string> = {},
) {
  return resolveRuntimeDatabase({ processName, env, dotenvValues });
}

function expectRefused(
  processName: 'api' | 'worker',
  env: Record<string, string | undefined>,
  pattern: RegExp,
  dotenvValues: Record<string, string> = {},
): string {
  let message = '';
  try {
    resolve(processName, env, dotenvValues);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeDbError);
    message = (error as Error).message;
  }
  expect(message).toMatch(pattern);
  expect(message).not.toContain(SECRET);
  expect(message).not.toMatch(/postgres:\/\//);
  return message;
}

const PROD_ENV = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  RAB_RUNTIME_ENV: 'production',
  DATABASE_URL: PROD_POOLED,
  DATABASE_URL_UNPOOLED: PROD_DIRECT,
  ...extra,
});

describe('runtime database identity guard (API and worker boot)', () => {
  it('1. NODE_ENV=production without RAB_RUNTIME_ENV is refused', () => {
    expectRefused('api', { NODE_ENV: 'production', DATABASE_URL: PROD_POOLED }, /requires RAB_RUNTIME_ENV=production/);
  });

  it('2. RAB_RUNTIME_ENV=production without NODE_ENV=production is refused', () => {
    expectRefused('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'production', DATABASE_URL: PROD_POOLED }, /requires NODE_ENV=production/);
  });

  it('3. production runtime is refused when RAB_RUNTIME_ENV appears in .env', () => {
    expectRefused('api', PROD_ENV(), /present in a \.env file/, { RAB_RUNTIME_ENV: 'production' });
  });

  it('4. production runtime is refused when the production URL also came from .env', () => {
    expectRefused('api', PROD_ENV(), /present in a \.env file/, { DATABASE_URL: PROD_POOLED });
  });

  it('5. production runtime is refused on a wrong identity, and the message names only endpoint and database', () => {
    const message = expectRefused('api', PROD_ENV({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER }), /not the expected production identity/);
    expect(message).toContain('127.0.0.1:55462');
  });

  it('6. ALLOW_PRODUCTION_DB_COMMANDS does NOT satisfy the runtime guard', () => {
    expectRefused(
      'api',
      { NODE_ENV: 'production', DATABASE_URL: PROD_POOLED, [ALLOW_PRODUCTION_DB_COMMANDS]: 'true' },
      /requires RAB_RUNTIME_ENV=production/,
    );
  });

  it('7. a production API with the expected identity from the deployment environment is accepted', () => {
    const resolved = resolve('api', PROD_ENV());
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.runtimeEnvironment).toBe('production');
    expect(resolved.app.endpointKey).toBe('neon:ep-round-rain-aess0njf');
  });

  it('8. a production worker without DATABASE_URL_UNPOOLED is refused (its owner-role connection is part of the identity)', () => {
    expectRefused('worker', PROD_ENV({ DATABASE_URL_UNPOOLED: undefined }), /requires DATABASE_URL_UNPOOLED/);
  });

  it('9. a production process whose unpooled URL is another endpoint is refused before identity', () => {
    expectRefused('worker', PROD_ENV({ DATABASE_URL_UNPOOLED: OTHER_NEON }), /different databases or endpoints/);
  });

  it('10. a NON-production API (NODE_ENV=development) using the production Neon URL is refused: the dev .env incident path', () => {
    expectRefused(
      'api',
      { NODE_ENV: 'development', DATABASE_URL: PROD_POOLED, DATABASE_URL_UNPOOLED: PROD_DIRECT },
      /non-production api process .* resolves to the expected production database/,
    );
  });

  it('11. a non-production process on a local database is accepted, classified LOCAL', () => {
    const resolved = resolve('api', { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER });
    expect(resolved.classification).toBe('LOCAL');
    expect(resolved.runtimeEnvironment).toBe('non-production');
  });

  it('11b. RAB_RUNTIME_ENV=development on a local database is accepted, runtime development, classified LOCAL', () => {
    const resolved = resolve('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER });
    expect(resolved.runtimeEnvironment).toBe('development');
    expect(resolved.classification).toBe('LOCAL');
  });

  it('11c. RAB_RUNTIME_ENV=development is refused for a remote database, even one that is not production', () => {
    expectRefused(
      'api',
      { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: OTHER_NEON, DATABASE_URL_UNPOOLED: OTHER_NEON },
      /development refuses a remote database/,
    );
  });

  it('11d. a non-production process on a remote database that is not production is NON-PRODUCTION, not LOCAL', () => {
    const resolved = resolve('api', { NODE_ENV: 'development', DATABASE_URL: OTHER_NEON, DATABASE_URL_UNPOOLED: OTHER_NEON });
    expect(resolved.classification).toBe('NON-PRODUCTION');
  });

  it('11e. RAB_RUNTIME_ENV=development with NODE_ENV=production is refused: production needs RAB_RUNTIME_ENV=production', () => {
    expectRefused('api', { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL }, /requires RAB_RUNTIME_ENV=production/);
  });

  it('12. NODE_ENV=test with the production identity is refused as non-production (no test process touches production)', () => {
    expectRefused('api', { NODE_ENV: 'test', DATABASE_URL: PROD_POOLED }, /resolves to the expected production database/);
  });

  it('13. an unrecognised RAB_RUNTIME_ENV is refused', () => {
    expectRefused('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'prod', DATABASE_URL: LOCAL }, /is not recognised/);
  });

  it('14. a missing DATABASE_URL is refused, and never silently replaced', () => {
    expectRefused('api', { NODE_ENV: 'development', DATABASE_URL_UNPOOLED: LOCAL_OWNER }, /DATABASE_URL is required/);
  });

  it('15. no refusal message contains a credential, including for a malformed URL', () => {
    expectRefused('api', { NODE_ENV: 'development', DATABASE_URL: `not a url ${SECRET}` }, /is not a parseable postgres URL/);
    expectRefused('api', PROD_ENV({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER }), /not the expected production identity/);
  });

  // ------------------------------------------------------------------------------------------------ P0.6-1B
  // (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.1 item 5 — the one live connection path the Phase 0.5/0.6
  // reconciliation found genuinely outside this guard: rab-worker's `directDataSource`, which reads
  // DATABASE_DIRECT_URL (falling back to DATABASE_URL) for the advisory-lock-requiring jobs.)
  describe('DATABASE_DIRECT_URL (rab-worker\'s directDataSource — the previously-unguarded path)', () => {
    it('16. a production worker whose DATABASE_DIRECT_URL is a DIFFERENT endpoint is refused before identity, same as DATABASE_URL_UNPOOLED', () => {
      expectRefused('worker', PROD_ENV({ DATABASE_DIRECT_URL: OTHER_NEON }), /different databases or endpoints/);
    });

    it('17. a production worker with DATABASE_DIRECT_URL set to the SAME expected production identity is accepted', () => {
      const resolved = resolve('worker', PROD_ENV({ DATABASE_DIRECT_URL: PROD_DIRECT }));
      expect(resolved.classification).toBe('PRODUCTION');
      expect(resolved.direct?.endpointKey).toBe('neon:ep-round-rain-aess0njf');
    });

    it('18. DATABASE_DIRECT_URL unset (the real fallback-to-DATABASE_URL shape) needs no separate probe and is accepted normally', () => {
      const resolved = resolve('worker', PROD_ENV());
      expect(resolved.direct).toBeNull();
      expect(resolved.directUrl).toBeNull();
    });

    it('19. DATABASE_DIRECT_URL explicitly equal to DATABASE_URL (the literal fallback value) is also treated as a no-op, never double-probed', () => {
      const resolved = resolve('worker', PROD_ENV({ DATABASE_DIRECT_URL: PROD_POOLED }));
      expect(resolved.direct).toBeNull();
    });

    it('20. a non-production worker whose DATABASE_DIRECT_URL points at the production database is refused — caught by the earlier cross-URL identity check, before the production/non-production branch even runs', () => {
      expectRefused(
        'worker',
        { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER, DATABASE_DIRECT_URL: PROD_DIRECT },
        /different databases or endpoints/,
      );
    });

    it('21. a production worker is refused when DATABASE_DIRECT_URL also came from .env, same rule as the other two URLs', () => {
      expectRefused('worker', PROD_ENV({ DATABASE_DIRECT_URL: PROD_DIRECT }), /present in a \.env file/, { DATABASE_DIRECT_URL: PROD_DIRECT });
    });

    it('22. a DATABASE_DIRECT_URL at a different (even non-production) endpoint than DATABASE_URL is refused outright — any cross-URL identity mismatch is caught before any environment classification runs', () => {
      expectRefused(
        'worker',
        { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER, DATABASE_DIRECT_URL: OTHER_NEON },
        /different databases or endpoints/,
      );
    });
  });
});
