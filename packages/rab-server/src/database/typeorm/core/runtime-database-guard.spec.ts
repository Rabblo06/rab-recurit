import { ALLOW_PRODUCTION_DB_COMMANDS } from './database-target';
import { RuntimeDbError, resolveRuntimeDatabase } from './runtime-database-guard';

// Fake credentials only. Every refusal asserts this never appears in the message.
const SECRET = 'S3cret-PW-do-not-print';
const PROD_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const PROD_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const OTHER_NEON = `postgres://rab_owner:${SECRET}@ep-other-endpoint-xyz.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const LOCAL = `postgres://rab_app:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const LOCAL_OWNER = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;

type ProcessName = 'api' | 'worker' | 'provisioner';

function resolve(
  processName: ProcessName,
  env: Record<string, string | undefined>,
  dotenvValues: Record<string, string> = {},
) {
  return resolveRuntimeDatabase({ processName, env, dotenvValues });
}

function expectRefused(
  processName: ProcessName,
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

// Worker credential isolation checkpoint: DATABASE_URL_UNPOOLED is now the provisioner's privileged
// DDL credential alone. The ordinary API and Worker never carry it, so the shared production fixture
// below deliberately omits it — callers that need it (provisioner tests) add it back explicitly.
const PROD_ENV = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  RAB_RUNTIME_ENV: 'production',
  DATABASE_URL: PROD_POOLED,
  ...extra,
});

describe('runtime database identity guard (API, worker and provisioner boot)', () => {
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
    const message = expectRefused('api', PROD_ENV({ DATABASE_URL: LOCAL }), /not the expected production identity/);
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
    expect(resolved.admin).toBeNull();
  });

  it('7b. a production WORKER with the expected identity and no DATABASE_URL_UNPOOLED is accepted — the ordinary worker never carries the privileged credential', () => {
    const resolved = resolve('worker', PROD_ENV());
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.admin).toBeNull();
  });

  it('8. a production provisioner without DATABASE_URL_UNPOOLED is refused (its privileged DDL connection is part of its identity)', () => {
    expectRefused('provisioner', PROD_ENV(), /requires DATABASE_URL_UNPOOLED/);
  });

  it('8b. a production API refuses to boot if DATABASE_URL_UNPOOLED is present in its environment at all, even when it matches DATABASE_URL\'s identity — a restricted process must never be ABLE to escalate', () => {
    expectRefused('api', PROD_ENV({ DATABASE_URL_UNPOOLED: PROD_DIRECT }), /only the provisioner process may hold it/);
  });

  it('8c. a production WORKER refuses to boot if DATABASE_URL_UNPOOLED is present in its environment at all, even when it matches DATABASE_URL\'s identity', () => {
    expectRefused('worker', PROD_ENV({ DATABASE_URL_UNPOOLED: PROD_DIRECT }), /only the provisioner process may hold it/);
  });

  it('8d. a non-production WORKER also refuses to boot if DATABASE_URL_UNPOOLED is present at all — the restriction is not production-only', () => {
    expectRefused(
      'worker',
      { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER },
      /only the provisioner process may hold it/,
    );
  });

  it('8d2. API, worker AND provisioner refuse to boot if the Worker bundle launcher variable CREWFLOW_PROVISIONER_DATABASE_URL reached them', () => {
    expectRefused('api', PROD_ENV({ CREWFLOW_PROVISIONER_DATABASE_URL: PROD_DIRECT }), /CREWFLOW_PROVISIONER_DATABASE_URL is present in the api process's environment/);
    expectRefused('worker', { NODE_ENV: 'development', DATABASE_URL: LOCAL, CREWFLOW_PROVISIONER_DATABASE_URL: LOCAL_OWNER }, /Only the Worker bundle launcher may hold it/);
    expectRefused('provisioner', PROD_ENV({ DATABASE_URL_UNPOOLED: PROD_DIRECT, CREWFLOW_PROVISIONER_DATABASE_URL: PROD_DIRECT }), /CREWFLOW_PROVISIONER_DATABASE_URL is present in the provisioner/);
    // An empty value is treated as absent, like DATABASE_URL_UNPOOLED.
    expect(resolve('api', PROD_ENV({ CREWFLOW_PROVISIONER_DATABASE_URL: '' })).classification).toBe('PRODUCTION');
  });

  it('8d3. API and worker refuse to boot if any migration authority (prestart URL, rab-migrate URL, approval) reached them', () => {
    expectRefused('api', PROD_ENV({ CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: PROD_DIRECT }), /CREWFLOW_PRESTART_MIGRATION_DATABASE_URL is present in the api process's environment/);
    expectRefused('api', PROD_ENV({ CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' }), /CREWFLOW_MIGRATION_APPROVED is present in the api/);
    expectRefused('worker', { NODE_ENV: 'development', DATABASE_URL: LOCAL, CREWFLOW_MIGRATION_DATABASE_URL: LOCAL_OWNER }, /never reaches a long-running process/);
    expect(resolve('api', PROD_ENV({ CREWFLOW_PRESTART_MIGRATION_DATABASE_URL: ' ', CREWFLOW_MIGRATION_APPROVED: '' })).classification).toBe('PRODUCTION');
  });

  it('8e. a production provisioner WITH DATABASE_URL_UNPOOLED present (its sole purpose) is accepted, not refused by the restricted-process rule', () => {
    const resolved = resolve('provisioner', PROD_ENV({ DATABASE_URL_UNPOOLED: PROD_DIRECT }));
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.admin?.endpointKey).toBe('neon:ep-round-rain-aess0njf');
  });

  it('9. a production provisioner whose unpooled URL is another endpoint is refused before identity', () => {
    expectRefused('provisioner', PROD_ENV({ DATABASE_URL_UNPOOLED: OTHER_NEON }), /different databases or endpoints/);
  });

  it('10. a NON-production API (NODE_ENV=development) using the production Neon URL is refused: the dev .env incident path', () => {
    expectRefused(
      'api',
      { NODE_ENV: 'development', DATABASE_URL: PROD_POOLED },
      /non-production api process .* resolves to the expected production database/,
    );
  });

  it('11. a non-production process on a local database is accepted, classified LOCAL', () => {
    const resolved = resolve('api', { NODE_ENV: 'development', DATABASE_URL: LOCAL });
    expect(resolved.classification).toBe('LOCAL');
    expect(resolved.runtimeEnvironment).toBe('non-production');
  });

  it('11b. RAB_RUNTIME_ENV=development on a local database is accepted, runtime development, classified LOCAL', () => {
    const resolved = resolve('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL });
    expect(resolved.runtimeEnvironment).toBe('development');
    expect(resolved.classification).toBe('LOCAL');
  });

  it('11c. RAB_RUNTIME_ENV=development is refused for a remote database, even one that is not production', () => {
    expectRefused(
      'api',
      { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: OTHER_NEON },
      /development refuses a remote database/,
    );
  });

  it('11d. a non-production process on a remote database that is not production is NON-PRODUCTION, not LOCAL', () => {
    const resolved = resolve('api', { NODE_ENV: 'development', DATABASE_URL: OTHER_NEON });
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
    expectRefused('api', PROD_ENV({ DATABASE_URL: LOCAL }), /not the expected production identity/);
  });

  // ------------------------------------------------------------------------------------------------ P0.6-1B
  // (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.1 item 5 — the one live connection path the Phase 0.5/0.6
  // reconciliation found genuinely outside this guard: rab-worker's `directDataSource`, which reads
  // DATABASE_DIRECT_URL (falling back to DATABASE_URL) for the advisory-lock-requiring jobs. This is a
  // THIRD, separate url from DATABASE_URL_UNPOOLED: it is still the restricted `crewflow_app` role, just
  // a direct (non-pgbouncer) connection string for session-level advisory locks — unrelated to the
  // provisioner's privileged-credential isolation, so the ordinary worker legitimately sets it.)
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
        { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: PROD_DIRECT },
        /different databases or endpoints/,
      );
    });

    it('21. a production worker is refused when DATABASE_DIRECT_URL also came from .env, same rule as the other two URLs', () => {
      expectRefused('worker', PROD_ENV({ DATABASE_DIRECT_URL: PROD_DIRECT }), /present in a \.env file/, { DATABASE_DIRECT_URL: PROD_DIRECT });
    });

    it('22. a DATABASE_DIRECT_URL at a different (even non-production) endpoint than DATABASE_URL is refused outright — any cross-URL identity mismatch is caught before any environment classification runs', () => {
      expectRefused(
        'worker',
        { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: OTHER_NEON },
        /different databases or endpoints/,
      );
    });
  });
});
