import { ALLOW_PRODUCTION_DB_COMMANDS } from './database-target';
import { assertRuntimeDatabaseIdentity, RuntimeDbError, resolveRuntimeDatabase } from './runtime-database-guard';

// Fake credentials only. Every refusal asserts this never appears in the message.
const SECRET = 'S3cret-PW-do-not-print';
const PROD_POOLED = `postgres://rab_app:${SECRET}@ep-round-rain-aess0njf-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const PROD_DIRECT = `postgres://rab_owner:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const OTHER_NEON = `postgres://rab_owner:${SECRET}@ep-other-endpoint-xyz.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
// Phase B: production takes PG_DATABASE_URL only, a DIRECT connection (the Worker refuses a transaction pooler).
const PROD_APP = `postgres://crewflow_app:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const PROD_PROVISIONER = `postgres://crewflow:${SECRET}@ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require`;
const LOCAL_DIRECT_USER = `postgres://rab_direct:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const LOCAL = `postgres://rab_app:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const LOCAL_OWNER = `postgres://rab_owner:${SECRET}@127.0.0.1:55462/rab_crewflow_hws_phase3_validation`;
const DO_PRIVATE = `postgres://crewflow_app:${SECRET}@private-db-postgresql-lon1-12345-do-user-1-0.b.db.ondigitalocean.com:25060/defaultdb?sslmode=verify-full`;
const PROD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const DECLARED_PROD = { CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production', CREWFLOW_DEPLOYMENT_ID: PROD_ID };

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

// Worker credential isolation checkpoint: the privileged credential never reaches the API or the ordinary Worker. Phase B:
// every process takes its own PG_DATABASE_URL (the provisioner child gets the provisioner credential under that name), and
// production refuses the legacy names DATABASE_URL / DATABASE_URL_UNPOOLED / DATABASE_DIRECT_URL / DB_POOL_MAX.
const PROD_ENV = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  NODE_ENV: 'production',
  RAB_RUNTIME_ENV: 'production',
  PG_DATABASE_URL: PROD_APP,
  ...DECLARED_PROD,
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

  it('4. production runtime is refused when the production URL also came from .env (under any name)', () => {
    expectRefused('api', PROD_ENV(), /present in a \.env file/, { PG_DATABASE_URL: PROD_APP });
    expectRefused('api', PROD_ENV(), /present in a \.env file/, { DATABASE_URL: PROD_APP });
    // A different value in .env is not production authority.
    expect(resolve('api', PROD_ENV(), { PG_DATABASE_URL: LOCAL }).classification).toBe('PRODUCTION');
  });

  it('4b. Phase B: production refuses the legacy names and libpq variables, and requires PG_DATABASE_URL', () => {
    expectRefused('api', PROD_ENV({ DATABASE_URL: PROD_APP }), /refuses the legacy database variable\(s\) DATABASE_URL/);
    expectRefused('worker', PROD_ENV({ DB_POOL_MAX: '10' }), /refuses the legacy database variable\(s\) DB_POOL_MAX/);
    expectRefused('api', PROD_ENV({ PGPASSWORD: 'x' }), /libpq environment variable\(s\) PGPASSWORD/);
    expectRefused('api', PROD_ENV({ PG_DATABASE_URL: undefined, DATABASE_URL: PROD_APP }), /legacy database variable|PG_DATABASE_URL is required in production/);
    expectRefused('api', PROD_ENV({ PG_DATABASE_URL: PROD_APP.replace('sslmode=require', 'sslmode=disable') }), /sslmode=disable, which production refuses/);
  });

  it('4c. Phase B: the Worker and the provisioner (session locks) refuse a transaction-pooler URL; the API only warns', () => {
    expectRefused('worker', PROD_ENV({ PG_DATABASE_URL: PROD_POOLED }), /transaction-pooler shape/);
    expectRefused('provisioner', PROD_ENV({ PG_DATABASE_URL: PROD_POOLED.replace('rab_app', 'crewflow') }), /transaction-pooler shape/);
    expect(resolve('api', PROD_ENV({ PG_DATABASE_URL: PROD_POOLED })).classification).toBe('PRODUCTION');
  });

  it('5. B3: production runtime needs the declared deployment identity; the marker check itself is live (deployment-identity.spec)', () => {
    expectRefused('api', PROD_ENV({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: undefined, CREWFLOW_DEPLOYMENT_ID: undefined }), /requires CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
    expectRefused('worker', PROD_ENV({ CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'staging' }), /must declare production/);
    expectRefused('api', PROD_ENV({ CREWFLOW_DEPLOYMENT_ID: undefined }), /must be set together/);
    expectRefused('api', PROD_ENV(), /present in a \.env file/, { CREWFLOW_DEPLOYMENT_ID: PROD_ID });
    expectRefused('api', PROD_ENV(), /present in a \.env file/, { PG_EXPECTED_DATABASE_NAME: 'neondb' });
  });

  it('5b. B3: the runtime never honours the production bootstrap flag', () => {
    expectRefused('api', PROD_ENV({ CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' }), /honoured only by production database commands/);
    expectRefused('worker', { NODE_ENV: 'development', DATABASE_URL: LOCAL, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'x' }, /honoured only by production database commands/);
  });

  it('5c. B3: the Neon pin is gone — a production runtime on any provider host resolves; identity is the live marker', () => {
    const resolved = resolve('api', PROD_ENV({ PG_DATABASE_URL: DO_PRIVATE }));
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.declared).toEqual({ environment: 'production', deploymentId: PROD_ID });
  });

  it('6. ALLOW_PRODUCTION_DB_COMMANDS does NOT satisfy the runtime guard: since L-4 its presence alone refuses the runtime', () => {
    expectRefused(
      'api',
      { NODE_ENV: 'production', DATABASE_URL: PROD_POOLED, [ALLOW_PRODUCTION_DB_COMMANDS]: 'true' },
      /ALLOW_PRODUCTION_DB_COMMANDS is present in the api process's environment\. It is command authority/,
    );
    expectRefused('api', { NODE_ENV: 'production', DATABASE_URL: PROD_POOLED }, /requires RAB_RUNTIME_ENV=production/);
    // By NAME in every runtime, production or not, whatever its value.
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      for (const value of ['true', 'false', 'local']) {
        expectRefused(processName, { NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, [ALLOW_PRODUCTION_DB_COMMANDS]: value }, /ALLOW_PRODUCTION_DB_COMMANDS is present/);
      }
    }
  });

  it('6b. L-4 follow-up: DB_TARGET is refused whenever it could be production authority — production/staging/anything but local|test, and ANY value in a production runtime', () => {
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      for (const value of ['production', 'staging', 'prod', 'LOCAL', 'local-ish']) {
        expectRefused(processName, { NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, DB_TARGET: value }, /^DB_TARGET is present in the .* process's environment\. It is command authority/);
        expectRefused(processName, { NODE_ENV: 'test', PG_DATABASE_URL: LOCAL, DB_TARGET: value }, /^DB_TARGET is present/);
      }
      for (const value of ['local', 'test', ' local ']) {
        // A production runtime: both variables, either one alone, or a mis-cased value — never tolerated.
        expectRefused(processName, PROD_ENV({ DB_TARGET: value }), /^DB_TARGET is present/);
        expectRefused(processName, { NODE_ENV: 'production', PG_DATABASE_URL: LOCAL, DB_TARGET: value }, /^DB_TARGET is present/);
        expectRefused(processName, { RAB_RUNTIME_ENV: 'production', PG_DATABASE_URL: LOCAL, DB_TARGET: value }, /^DB_TARGET is present/);
        expectRefused(processName, { NODE_ENV: 'Production', PG_DATABASE_URL: LOCAL, DB_TARGET: value }, /^DB_TARGET is present/);
      }
    }
  });

  it('6c. L-4 follow-up: local `yarn start` boots past the guard with the developer .env\'s DB_TARGET=local|test (ignored, never read)', () => {
    // The API under Nx (packages/rab-server/.env injected: NODE_ENV=development, DB_TARGET=local, a loopback URL).
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      for (const DB_TARGET of ['local', 'test', ' test ']) {
        const resolved = resolve(processName, { NODE_ENV: 'development', DB_TARGET, PG_DATABASE_URL: LOCAL });
        expect(resolved.classification).toBe('LOCAL');
        expect(resolved.runtimeEnvironment).toBe('non-production');
        expect(resolve(processName, { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DB_TARGET, PG_DATABASE_URL: LOCAL }).runtimeEnvironment).toBe('development');
        expect(resolve(processName, { NODE_ENV: 'test', DB_TARGET, PG_DATABASE_URL: LOCAL }).classification).toBe('LOCAL');
      }
    }
    // Tolerating it changes nothing else: the deny list, the remote-host rule of a development runtime and every other
    // forbidden name still refuse with DB_TARGET=local present.
    expectRefused('api', { NODE_ENV: 'development', DB_TARGET: 'local', PG_DATABASE_URL: PROD_APP }, /names the current production Neon endpoint/);
    expectRefused('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DB_TARGET: 'local', PG_DATABASE_URL: OTHER_NEON }, /development refuses a remote database/);
    expectRefused('api', { NODE_ENV: 'development', DB_TARGET: 'local', PG_DATABASE_URL: LOCAL, CREWFLOW_MIGRATION_APPROVED: 'x' }, /CREWFLOW_MIGRATION_APPROVED is present/);
  });

  it('7. a production API with the expected identity from the deployment environment is accepted', () => {
    const resolved = resolve('api', PROD_ENV());
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.runtimeEnvironment).toBe('production');
    expect(resolved.app.endpointKey).toBe('neon:ep-round-rain-aess0njf');
    expect(resolved.admin).toBeNull();
    expect(resolved.declared?.environment).toBe('production');
  });

  it('7b. a production WORKER with the expected identity and no DATABASE_URL_UNPOOLED is accepted — the ordinary worker never carries the privileged credential', () => {
    const resolved = resolve('worker', PROD_ENV());
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.admin).toBeNull();
  });

  it('8. Phase B: a production provisioner takes its credential as PG_DATABASE_URL — DATABASE_URL_UNPOOLED is no longer required', () => {
    const resolved = resolve('provisioner', PROD_ENV({ PG_DATABASE_URL: PROD_PROVISIONER }));
    expect(resolved.classification).toBe('PRODUCTION');
    expect(resolved.admin).toBeNull();
    expect(resolved.app.endpointKey).toBe('neon:ep-round-rain-aess0njf');
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

  it('8e. Phase B: a production provisioner WITH DATABASE_URL_UNPOOLED is refused (legacy name); outside production it is still its deprecated DDL connection', () => {
    expectRefused('provisioner', PROD_ENV({ PG_DATABASE_URL: PROD_PROVISIONER, DATABASE_URL_UNPOOLED: PROD_DIRECT }), /refuses the legacy database variable\(s\) DATABASE_URL_UNPOOLED/);
    const resolved = resolve('provisioner', { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL_OWNER });
    expect(resolved.admin?.endpointKey).toBe('127.0.0.1:55462');
    expect(resolved.admin?.label).toBe('DATABASE_URL_UNPOOLED');
  });

  it('9. a non-production provisioner whose unpooled URL is another endpoint is refused before identity', () => {
    expectRefused('provisioner', { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: OTHER_NEON }, /different databases or endpoints/);
  });

  it('10. B3: a NON-production process may not declare production (the dev .env incident path is now refused LIVE by the marker: a production-bound database refuses every non-production process, whatever the host)', () => {
    expectRefused('api', { NODE_ENV: 'development', DATABASE_URL: PROD_POOLED, ...DECLARED_PROD }, /non-production api process declares CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
    // A production-BOUND database is refused live by the marker (deployment-identity.spec.ts); today's UNMARKED production
    // endpoint is refused before any connection by the interim deny list (10b).
    expect(resolve('api', { NODE_ENV: 'development', DATABASE_URL: OTHER_NEON }).classification).toBe('NON-PRODUCTION');
  });

  it('10b. H-1 (interim, until production carries a bound marker): a non-production API / Worker / Provisioner pointed at the current production Neon endpoint is refused before connecting — direct or -pooler host, any region, any database, any of its URLs', () => {
    const otherRegion = `postgres://crewflow_app:${SECRET}@ep-round-rain-aess0njf.eu-central-1.aws.neon.tech/neondb?sslmode=require`;
    const otherDatabase = PROD_DIRECT.replace('/neondb?', '/scratch?');
    const pattern = /names the current production Neon endpoint .*\(neon:ep-round-rain-aess0njf, database (neondb|scratch)\)\. A non-production .* must never connect to it\..*Refusing to start\./;
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      for (const NODE_ENV of ['development', 'test', undefined]) {
        expectRefused(processName, { NODE_ENV, PG_DATABASE_URL: PROD_APP }, pattern);
        // The -pooler host (the API's shape; the Worker and provisioner already refuse a transaction pooler first).
        if (processName === 'api') expectRefused(processName, { NODE_ENV, DATABASE_URL: PROD_POOLED }, pattern);
        expectRefused(processName, { NODE_ENV, PG_DATABASE_URL: otherRegion }, pattern);
        expectRefused(processName, { NODE_ENV, PG_DATABASE_URL: otherDatabase }, pattern);
      }
      // Remote allowances and runtime labels never lift it.
      expectRefused(processName, { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'non-production', ALLOW_REMOTE_TEST_DATABASE: 'true', PG_DATABASE_URL: PROD_APP }, pattern);
    }
    // Any endpoint the process can open: the read replica too.
    expectRefused('api', { NODE_ENV: 'development', PG_DATABASE_URL: LOCAL, PG_DATABASE_REPLICA_URL: PROD_APP }, /PG_DATABASE_REPLICA_URL names the current production Neon endpoint/);
    // Production itself is not on this path (it is decided by the declared identity + the live marker).
    expect(resolve('api', PROD_ENV()).classification).toBe('PRODUCTION');
    // Another Neon endpoint, a loopback and a docker-service host are unaffected.
    expect(resolve('worker', { NODE_ENV: 'development', PG_DATABASE_URL: OTHER_NEON }).classification).toBe('NON-PRODUCTION');
    expect(resolve('worker', { NODE_ENV: 'development', PG_DATABASE_URL: LOCAL }).classification).toBe('LOCAL');
    expect(resolve('worker', { NODE_ENV: 'development', PG_DATABASE_URL: `postgres://crewflow_app:${SECRET}@postgres:5432/rab` }).classification).toBe('LOCAL');
  });

  it('10b2. N-1: a trailing-dot host or Neon password routing never slips past the deny list or the URL policy (every runtime process)', () => {
    const host = 'ep-round-rain-aess0njf.c-2.us-east-2.aws.neon.tech';
    const pattern = /names the current production Neon endpoint .*neon:ep-round-rain-aess0njf.*Refusing to start\./;
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      expectRefused(processName, { NODE_ENV: 'development', PG_DATABASE_URL: `postgres://crewflow_app:${SECRET}@${host}./neondb?sslmode=require` }, pattern);
      expectRefused(processName, { NODE_ENV: 'development', PG_DATABASE_URL: `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@${host}/neondb` }, pattern);
      for (const via of ['10.0.0.5', '127.0.0.1:15432', 'tunnel', 'prod-alias.example.net']) {
        expectRefused(processName, { NODE_ENV: 'development', PG_DATABASE_URL: `postgres://crewflow_app:endpoint%3Dep-round-rain-aess0njf%24${SECRET}@${via}/neondb` }, /Neon password routing/);
      }
    }
  });

  it('10c. H-1: the full boot guard refuses the production endpoint BEFORE opening any connection (the refusal is the deny list, never a connect error)', async () => {
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      await expect(assertRuntimeDatabaseIdentity(processName, { NODE_ENV: 'development', PG_DATABASE_URL: PROD_APP }, {})).rejects.toThrow(
        /names the current production Neon endpoint .*Refusing to start\./,
      );
    }
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

  it('11d2. N-4: a non-loopback IPv6 literal (no dot, e.g. fd00::5) is REMOTE: refused by RAB_RUNTIME_ENV=development, never classified LOCAL; ::1 stays LOCAL', () => {
    for (const processName of ['api', 'worker', 'provisioner'] as const) {
      for (const ipv6 of ['fd00::5', '2001:db8::1', 'fe80::1']) {
        const url = `postgres://crewflow_app:${SECRET}@[${ipv6}]:5432/rab`;
        expectRefused(processName, { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', PG_DATABASE_URL: url }, /development refuses a remote database/);
        expect(resolve(processName, { NODE_ENV: 'development', PG_DATABASE_URL: url }).classification).toBe('NON-PRODUCTION');
      }
      const loopback = `postgres://crewflow_app:${SECRET}@[::1]:55462/rab`;
      expect(resolve(processName, { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', PG_DATABASE_URL: loopback }).classification).toBe('LOCAL');
      expect(resolve(processName, { NODE_ENV: 'development', PG_DATABASE_URL: loopback }).classification).toBe('LOCAL');
    }
  });

  it('11e. RAB_RUNTIME_ENV=development with NODE_ENV=production is refused: production needs RAB_RUNTIME_ENV=production', () => {
    expectRefused('api', { NODE_ENV: 'production', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL }, /requires RAB_RUNTIME_ENV=production/);
  });

  it('12. NODE_ENV=test declaring production is refused as non-production (no test process touches production)', () => {
    expectRefused('api', { NODE_ENV: 'test', DATABASE_URL: PROD_POOLED, ...DECLARED_PROD }, /non-production api process declares/);
  });

  it('12b. F1: a query-string host/port/user override is refused for every runtime URL', () => {
    expectRefused('api', { NODE_ENV: 'development', DATABASE_URL: `${LOCAL}?host=db.attacker.example` }, /sets "host" as a query parameter/);
    expectRefused('worker', { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: `${LOCAL}?port=6543` }, /DATABASE_DIRECT_URL sets "port"/);
    expectRefused('api', PROD_ENV({ PG_DATABASE_URL: `${PROD_APP}&user=postgres` }), /sets "user" as a query parameter/);
    // RAB_RUNTIME_ENV=development "local only" can no longer be satisfied by a loopback URL that pg would redirect elsewhere.
    expectRefused('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: `${LOCAL}?hostaddr=203.0.113.9` }, /sets "hostaddr"/);
  });

  it('13. an unrecognised RAB_RUNTIME_ENV is refused', () => {
    expectRefused('api', { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'prod', DATABASE_URL: LOCAL }, /is not recognised/);
  });

  it('14. a missing PG_DATABASE_URL is refused, and never silently replaced by the elevated URL', () => {
    expectRefused('provisioner', { NODE_ENV: 'development', DATABASE_URL_UNPOOLED: LOCAL_OWNER }, /PG_DATABASE_URL is required/);
    expectRefused('api', { NODE_ENV: 'development' }, /PG_DATABASE_URL is required/);
  });

  it('15. no refusal message contains a credential, including for a malformed URL', () => {
    expectRefused('api', { NODE_ENV: 'development', DATABASE_URL: `postgres://u:${SECRET}@[bad/db` }, /is not a parseable postgres URL/);
    // The factory's own message names the accepted schemes (literally "postgres://"), never the value.
    expect(() => resolve('api', { NODE_ENV: 'development', PG_DATABASE_URL: `not a url ${SECRET}` })).toThrow(RuntimeDbError);
    expect(() => resolve('api', { NODE_ENV: 'development', PG_DATABASE_URL: `not a url ${SECRET}` })).toThrow(/PG_DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ URL \(value not shown\)/);
    expect(() => resolve('api', { NODE_ENV: 'development', PG_DATABASE_URL: `not a url ${SECRET}` })).not.toThrow(new RegExp(SECRET));
    expectRefused('api', PROD_ENV({ CREWFLOW_DEPLOYMENT_ID: `not-a-uuid-${SECRET}` }), /must be a uuid \(value not shown\)/);
  });

  // ------------------------------------------------------------------------------------------------ P0.6-1B
  // (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8A.1 item 5 — the one live connection path the Phase 0.5/0.6
  // reconciliation found genuinely outside this guard: rab-worker's `directDataSource`, which reads
  // DATABASE_DIRECT_URL (falling back to DATABASE_URL) for the advisory-lock-requiring jobs. This is a
  // THIRD, separate url from DATABASE_URL_UNPOOLED: it is still the restricted `crewflow_app` role, just
  // a direct (non-pgbouncer) connection string for session-level advisory locks — unrelated to the
  // provisioner's privileged-credential isolation, so the ordinary worker legitimately sets it.)
  describe('DATABASE_DIRECT_URL (rab-worker\'s directDataSource — the previously-unguarded path)', () => {
    it('16. Phase B: a production worker refuses DATABASE_DIRECT_URL (PG_DATABASE_URL is itself the direct session-lock connection)', () => {
      expectRefused('worker', PROD_ENV({ DATABASE_DIRECT_URL: PROD_DIRECT }), /refuses the legacy database variable\(s\) DATABASE_DIRECT_URL/);
    });

    it('17. a non-production worker with a deprecated DATABASE_DIRECT_URL naming the same endpoint (another login) is accepted and probed', () => {
      const resolved = resolve('worker', { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: LOCAL_DIRECT_USER });
      expect(resolved.direct?.endpointKey).toBe('127.0.0.1:55462');
      expect(resolved.direct?.label).toBe('DATABASE_DIRECT_URL');
    });

    it('18. DATABASE_DIRECT_URL unset (the real fallback-to-DATABASE_URL shape) needs no separate probe and is accepted normally', () => {
      const resolved = resolve('worker', PROD_ENV());
      expect(resolved.direct).toBeNull();
      expect(resolved.pg.lock).toBe(resolved.pg.primary);
    });

    it('19. DATABASE_DIRECT_URL explicitly equal to DATABASE_URL (the literal fallback value) is also treated as a no-op, never double-probed', () => {
      const resolved = resolve('worker', { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: LOCAL });
      expect(resolved.direct).toBeNull();
    });

    it('20. a non-production worker whose DATABASE_DIRECT_URL points at the production database is refused — caught by the earlier cross-URL identity check, before the production/non-production branch even runs', () => {
      expectRefused(
        'worker',
        { NODE_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: PROD_DIRECT },
        /different databases/,
      );
    });

    it('21. a production worker is refused when DATABASE_DIRECT_URL also came from .env, same rule as the other two URLs', () => {
      expectRefused('worker', PROD_ENV(), /present in a \.env file/, { DATABASE_DIRECT_URL: PROD_APP });
    });

    it('22. a DATABASE_DIRECT_URL at a different (even non-production) endpoint than DATABASE_URL is refused outright — any cross-URL identity mismatch is caught before any environment classification runs', () => {
      expectRefused(
        'worker',
        { NODE_ENV: 'development', RAB_RUNTIME_ENV: 'development', DATABASE_URL: LOCAL, DATABASE_DIRECT_URL: OTHER_NEON },
        /different databases/,
      );
    });
  });
});
