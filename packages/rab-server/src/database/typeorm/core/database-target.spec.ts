import { ALLOW_PRODUCTION_DB_COMMANDS, assertDbTarget, DbTargetError, resolveDbTarget } from './database-target';

// Fake credentials only. Every refusal test asserts this never appears in the message.
const SECRET = 'S3cret-PW-do-not-print';
const NEON_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const NEON_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const OTHER_NEON_DIRECT = `postgres://rab_owner:${SECRET}@ep-other-endpoint-xyz.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const LOCAL = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const DOCKER_SERVICE = `postgres://rab_owner:${SECRET}@postgres:5432/rab`;
const LOCAL_OTHER_DB = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_other`;
const DO_PRIVATE = `postgres://crewflow_migrator:${SECRET}@private-db-postgresql-lon1-12345-do-user-1-0.b.db.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;
const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const DECLARED_PROD = { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: PROD_ID };

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

// Phase B: production takes PG_DATABASE_URL only (the factory refuses the legacy names there).
const PROD_ENV = (urls: { app: string }, extra: Record<string, string | undefined> = DECLARED_PROD): Record<string, string | undefined> => ({
  DB_TARGET: 'production',
  [ALLOW_PRODUCTION_DB_COMMANDS]: 'true',
  PG_DATABASE_URL: urls.app,
  ...extra,
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
    const env = PROD_ENV({ app: NEON_DIRECT });
    // Refused by the factory's migration-endpoint rule (selectMigrationEndpoint) before the guard's own .env check.
    expectRefused(env, /comes from the \.env file|present in packages\/rab-server\/\.env/, { PG_DATABASE_URL: NEON_DIRECT });
    expectRefused(env, /present in packages\/rab-server\/\.env/, { DATABASE_URL: NEON_DIRECT });
    expectRefused(env, /present in packages\/rab-server\/\.env/, { [ALLOW_PRODUCTION_DB_COMMANDS]: 'true' });
    expectRefused(env, /present in packages\/rab-server\/\.env/, { DB_TARGET: 'production' });
  });

  it('7. B3: production needs the declared deployment identity (CREWFLOW_DEPLOYMENT_ENVIRONMENT=production + CREWFLOW_DEPLOYMENT_ID)', () => {
    expectRefused(PROD_ENV({ app: NEON_POOLED }, {}), /requires CREWFLOW_DEPLOYMENT_ENVIRONMENT=production and CREWFLOW_DEPLOYMENT_ID/);
    expectRefused(PROD_ENV({ app: NEON_POOLED }, { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production' }), /must be set together/);
    expectRefused(PROD_ENV({ app: NEON_POOLED }, { ...DECLARED_PROD, CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'staging' }), /must declare production/);
    expectRefused(PROD_ENV({ app: NEON_POOLED }, { ...DECLARED_PROD, CREWFLOW_DEPLOYMENT_ID: 'x' }), /must be a uuid/);
  });

  it('8. B3: the Neon endpoint pin is gone: any provider host is a production candidate, decided LIVE by the protected marker', () => {
    const resolved = run(PROD_ENV({ app: NEON_DIRECT }), {
      // .env present but holding different (or no) production values: not a match, so it is allowed.
      PG_DATABASE_URL: 'postgres://other:x@localhost:5432/other',
    });
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.declared).toEqual({ environment: 'production', deploymentId: PROD_ID });
    expect(resolved.admin).toBeNull();
    expect(resolved.migrationEndpoint).toBe('primary');
    expect(resolved.pg.processRole).toBe('migrate');
    expect(resolved.pg.primary.ssl).toEqual({ rejectUnauthorized: true });
    // DigitalOcean (or any provider): accepted at the pure stage, then the marker must say production/<this id>.
    const onDo = run(PROD_ENV({ app: DO_PRIVATE }));
    expect(onDo.classification).toBe('PRODUCTION');
    expect(onDo.app.database).toBe('defaultdb');
    expect(run(PROD_ENV({ app: OTHER_NEON_DIRECT })).classification).toBe('PRODUCTION');
  });

  it('8b. B3: deployment identity and bootstrap values present in .env are refused for production', () => {
    for (const name of ['CREWFLOW_DEPLOYMENT_ENVIRONMENT', 'CREWFLOW_DEPLOYMENT_ID', 'CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP', 'PG_EXPECTED_DATABASE_NAME']) {
      expectRefused(PROD_ENV({ app: NEON_POOLED }), /present in packages\/rab-server\/\.env/, { [name]: 'x' });
    }
  });

  it('8c. B3: the bootstrap flag is honoured only for DB_TARGET=production, and only with its exact value', () => {
    expect(run(PROD_ENV({ app: NEON_POOLED }, { ...DECLARED_PROD, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' })).bootstrapRequested).toBe(true);
    expectRefused(PROD_ENV({ app: NEON_POOLED }, { ...DECLARED_PROD, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'yes' }), /must be unset or exactly/);
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: LOCAL, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' }, /honoured only with DB_TARGET=production/);
  });

  it('9. Phase B: production refuses the legacy names (and libpq variables) and TLS weaker than verify-full, before identity', () => {
    for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'DATABASE_DIRECT_URL']) {
      expectRefused({ ...PROD_ENV({ app: NEON_DIRECT }), [name]: NEON_DIRECT }, new RegExp(`refuses the legacy database variable\\(s\\) ${name}`));
    }
    expectRefused({ ...PROD_ENV({ app: NEON_DIRECT }), PGPASSWORD: 'x' }, /libpq environment variable/);
    expectRefused(PROD_ENV({ app: NEON_DIRECT.replace('sslmode=require', 'sslmode=disable') }), /sslmode=disable, which production refuses/);
    // Outside production an app/admin pair that disagrees on endpoint is still refused before identity.
    expectRefused({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', DATABASE_URL: NEON_POOLED, DATABASE_URL_UNPOOLED: OTHER_NEON_DIRECT }, /different databases or endpoints/);
  });

  it('9b. Phase B: the migration endpoint is the factory rule (PG_DATABASE_URL, else the deprecated DATABASE_URL_UNPOOLED); the CLI uses the primary', () => {
    expect(run({ DB_TARGET: 'local', PG_DATABASE_URL: LOCAL }).migrationEndpoint).toBe('primary');
    const legacy = run({ DB_TARGET: 'local', DATABASE_URL: LOCAL.replace('rab_owner', 'crewflow_app'), DATABASE_URL_UNPOOLED: LOCAL });
    expect(legacy.migrationEndpoint).toBe('elevated');
    expect(legacy.admin?.label).toBe('DATABASE_URL_UNPOOLED');
    expectRefused({ DB_TARGET: 'local', PG_DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL.replace('rab_owner', 'crewflow_app') }, /name different targets/);
    const cli = resolveDbTarget({ purpose: 'command', env: { DB_TARGET: 'local', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL }, dotenvValues: {} });
    expect(cli.migrationEndpoint).toBe('primary');
    expect(cli.pg.processRole).toBe('cli');
    // The M2 harness's phase-A session role is accepted only for the migration identity against local/test.
    const withRole = `${LOCAL}?options=-c%20role%3Drab_owner`;
    expect(run({ DB_TARGET: 'test', DATABASE_URL: withRole }).pg.primary.target.sessionRoleOption).toBe('-c role=rab_owner');
    expect(() => resolveDbTarget({ purpose: 'command', env: { DB_TARGET: 'test', DATABASE_URL: withRole }, dotenvValues: {} })).toThrow(/sets "options"/);
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
    // B3: a non-production target may not declare production; whether the DATABASE is production is decided live by the
    // marker (a production-bound database is refused for every non-production target, whatever its host).
    expectRefused(
      { DB_TARGET: 'test', DATABASE_URL: NEON_DIRECT, ALLOW_REMOTE_TEST_DATABASE: 'true', ...DECLARED_PROD },
      /non-production migrations command declares CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/,
    );
    expect(run({ DB_TARGET: 'test', DATABASE_URL: LOCAL, CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'test', CREWFLOW_DEPLOYMENT_ID: PROD_ID }).declared).toEqual({
      environment: 'test',
      deploymentId: PROD_ID,
    });
  });

  it('14a. H-1 (interim, until production carries a bound marker): DB_TARGET=local|test commands pointed at the current production Neon endpoint are refused before connecting, even with ALLOW_REMOTE_TEST_DATABASE=true', () => {
    const pattern = /names the current production Neon endpoint .*\(neon:ep-round-rain-aess0njf, database (neondb|scratch)\)\. A non-production DB_TARGET=test .* command must never connect to it\..*Refusing\./;
    for (const purpose of ['migrations', 'seed', 'bootstrap-admin', 'storage-reconcile', 'db:bind-identity']) {
      for (const env of [
        { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: NEON_DIRECT },
        { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', DATABASE_URL: NEON_POOLED },
        { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: NEON_DIRECT.replace('/neondb?', '/scratch?') },
        { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: NEON_DIRECT.replace('c-2.us-east-2', 'eu-central-1') },
      ]) {
        let message = '';
        try {
          resolveDbTarget({ purpose, env, dotenvValues: {} });
        } catch (error) {
          expect(error).toBeInstanceOf(DbTargetError);
          message = (error as Error).message;
        }
        expect(message).toMatch(pattern);
        expect(message).not.toContain(SECRET);
        expect(message).not.toMatch(/postgres:\/\//);
      }
    }
    // Without the remote allowance the existing remote-host rule refuses first; local stays refused too.
    expectRefused({ DB_TARGET: 'test', PG_DATABASE_URL: NEON_DIRECT }, /refuses a remote host/);
    expectRefused({ DB_TARGET: 'local', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: NEON_DIRECT }, /refuses a remote host/);
    // Production commands are not on this path (decided by the declared identity + the live marker).
    expect(run(PROD_ENV({ app: NEON_DIRECT })).classification).toBe('PRODUCTION');
    // Another remote test endpoint with the allowance, a loopback and a docker service are unaffected.
    expect(run({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: OTHER_NEON_DIRECT }).classification).toBe('NON-PRODUCTION');
    expect(run({ DB_TARGET: 'local', PG_DATABASE_URL: LOCAL }).classification).toBe('NON-PRODUCTION');
    expect(run({ DB_TARGET: 'local', PG_DATABASE_URL: DOCKER_SERVICE }).classification).toBe('NON-PRODUCTION');
  });

  it('14a2. H-1: the full command guard refuses the production endpoint BEFORE opening any connection (the refusal is the deny list, never a connect error)', async () => {
    for (const purpose of ['migrations', 'seed']) {
      await expect(assertDbTarget(purpose, { DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: NEON_DIRECT }, {})).rejects.toThrow(
        /names the current production Neon endpoint .*Refusing\./,
      );
    }
  });

  it('14b. F1: a query-string host/port/user override is refused (the guard would check one host while pg connects to another)', () => {
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: `${LOCAL}?host=db.attacker.example` }, /sets "host" as a query parameter/);
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: `${LOCAL}?port=6543` }, /sets "port" as a query parameter/);
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: `${LOCAL}?sslmode=disable&user=postgres` }, /sets "user" as a query parameter/);
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: `${LOCAL}?hostaddr=10.0.0.9` }, /sets "hostaddr"/);
    expectRefused(PROD_ENV({ app: `${NEON_DIRECT}&host=other.example` }), /sets "host" as a query parameter/);
  });

  it('15. a missing PG_DATABASE_URL is refused, and the normal .env name is never a substitute for DB_TARGET', () => {
    expectRefused({ DB_TARGET: 'local' }, /PG_DATABASE_URL is required/);
    expectRefused({ ...PROD_ENV({ app: NEON_DIRECT }), PG_DATABASE_URL: undefined }, /PG_DATABASE_URL is required in production/);
  });

  it('16. no refusal message contains a credential, including for a malformed URL', () => {
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: `postgres://u:${SECRET}@[bad/db` }, /is not a parseable postgres URL/);
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: NEON_POOLED }, /refuses a remote host/);
    expectRefused(PROD_ENV({ app: OTHER_NEON_DIRECT }, {}), /requires CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
  });

  it('17b. final review F4: an UNLISTED single-label host is REMOTE for DB_TARGET=local|test; the compose services stay local', () => {
    for (const DB_TARGET of ['local', 'test']) {
      for (const host of ['db', 'prod-db', 'database']) {
        expectRefused({ DB_TARGET, PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@${host}:5432/rab` }, new RegExp(`DB_TARGET=(local|test) refuses a remote host \\("${host}"\\)`));
      }
      for (const host of ['devdb', 'postgres', 'pg']) {
        expect(run({ DB_TARGET, PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@${host}:5432/rab` }).classification).toBe('NON-PRODUCTION');
      }
    }
    // Only the explicit remote-test override admits an unlisted name, exactly as for a dotted remote host.
    expect(run({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@db:5432/rab` }).classification).toBe('NON-PRODUCTION');
  });

  it('17. N-4: a non-loopback IPv6 literal (no dot) is REMOTE for DB_TARGET=local|test; ::1 stays local', () => {
    for (const DB_TARGET of ['local', 'test']) {
      expectRefused({ DB_TARGET, PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@[fd00::5]:5432/rab` }, /DB_TARGET=(local|test) refuses a remote host \("fd00::5"\)/);
      expectRefused({ DB_TARGET, PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@[2001:db8::1]/rab` }, /refuses a remote host/);
      expect(run({ DB_TARGET, PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@[::1]:55462/rab` }).classification).toBe('NON-PRODUCTION');
    }
    expectRefused({ DB_TARGET: 'local', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: `postgres://rab_owner:${SECRET}@[fd00::5]:55462/rab_crewflow_hws_phase3_validation` }, /refuses a remote|different databases or endpoints/);
    // The explicit remote-test override still applies to an IPv6 test host.
    expect(run({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: `postgres://rab_owner:${SECRET}@[fd00::5]/rab` }).classification).toBe('NON-PRODUCTION');
  });

  it('18. N-1: the deny list holds for a trailing-dot host and for Neon password routing on the production host', () => {
    const PROD_HOST = 'ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech';
    for (const url of [
      `postgres://rab_owner:${SECRET}@${PROD_HOST}./neondb?sslmode=require`,
      `postgres://rab_owner:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@${PROD_HOST}/neondb?sslmode=require`,
    ]) {
      expectRefused({ DB_TARGET: 'test', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: url }, /names the current production Neon endpoint .*neon:ep-round-rain-aess0njf/);
    }
    // Password routing through any other host is refused by the URL policy (never reaching the endpoint).
    expectRefused({ DB_TARGET: 'local', PG_DATABASE_URL: `postgres://rab_owner:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@127.0.0.1:15432/neondb` }, /Neon password routing/);
  });

  it('19. L-2 follow-up: a per-release migration approval in packages/rab-server/.env is production authority from a file: refused', () => {
    expectRefused(PROD_ENV({ app: NEON_DIRECT }, { ...DECLARED_PROD, CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' }), /present in packages\/rab-server\/\.env/, {
      CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations',
    });
    // Outside production the file entry is irrelevant (local runs need no approval).
    expect(run({ DB_TARGET: 'local', DATABASE_URL: LOCAL }, { CREWFLOW_MIGRATION_APPROVED: 'apply-pending-migrations' }).classification).toBe('NON-PRODUCTION');
  });
});
