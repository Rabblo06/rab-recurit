import { DataSource } from 'typeorm';

import { PasswordHashingService } from '../engine/core-modules/auth/services/password-hashing.service';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { SeedQaCommand } from './seed-qa.command';
import { SeedCommand } from './seed.command';
import { assertSeedCommandTarget, assertSeedDatabaseNotDeployed, seedCommandTargetProblems, SeedTargetError } from './seed-target-guard';

/**
 * X1.5 (cleanup audit NC-04): `seed` and `seed-qa` refuse staging and production targets inside the command, before any read
 * or write, whatever the generic CLI command gate allowed. Synthetic credentials; the refusals never echo them.
 */
const SECRET = 'S3cret-seed-PW-not-printed';
const LOCAL = {
  NODE_ENV: 'development',
  RAB_RUNTIME_ENV: 'development',
  DB_TARGET: 'local',
  PG_DATABASE_URL: `postgres://crewflow:${SECRET}@127.0.0.1:15499/rab`,
};
/** The Worker-bundle image test's `cli` service (run-integration.cjs runs `seed-qa` in the built image). */
const BUNDLE_TEST = {
  NODE_ENV: 'development',
  RAB_RUNTIME_ENV: 'development',
  DB_TARGET: 'local',
  DATABASE_URL: `postgres://rab:${SECRET}@pg:5432/rab`,
};
const PRODUCTION = {
  NODE_ENV: 'production',
  RAB_RUNTIME_ENV: 'production',
  DB_TARGET: 'production',
  ALLOW_PRODUCTION_DB_COMMANDS: 'true',
  CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'production',
  CREWFLOW_DEPLOYMENT_ID: '6f2a3c1e-0000-4000-8000-000000000001',
  PG_DATABASE_URL: `postgres://crewflow:${SECRET}@db.prod.example.com:5432/rab?sslmode=verify-full`,
};

describe('seed / seed-qa target guard (X1.5, audit NC-04)', () => {
  it('allows local development (loopback) and the Worker-bundle image test (compose host pg, legacy DATABASE_URL)', () => {
    expect(seedCommandTargetProblems(LOCAL)).toEqual([]);
    expect(seedCommandTargetProblems(BUNDLE_TEST)).toEqual([]);
    expect(seedCommandTargetProblems({ ...LOCAL, NODE_ENV: 'test', RAB_RUNTIME_ENV: undefined, DB_TARGET: 'test' })).toEqual([]);
  });

  it('refuses a production target with full production command authority (the gap the generic gate left open)', () => {
    const problems = seedCommandTargetProblems(PRODUCTION).join('\n');
    expect(problems).toMatch(/DB_TARGET must be local or test \(got production\)/);
    expect(problems).toMatch(/ALLOW_PRODUCTION_DB_COMMANDS is production command authority/);
    expect(problems).toMatch(/NODE_ENV=production declares a deployed environment/);
    expect(problems).toMatch(/RAB_RUNTIME_ENV=production/);
    expect(problems).toMatch(/CREWFLOW_DEPLOYMENT_ENVIRONMENT=production/);
    expect(problems).toMatch(/PG_DATABASE_URL must be a loopback or docker-service database \(got host "db\.prod\.example\.com"\)/);
    expect(problems).not.toContain(SECRET);
  });

  it.each<[string, Record<string, string | undefined>, RegExp]>([
    ['DB_TARGET=staging', { ...LOCAL, DB_TARGET: 'staging' }, /DB_TARGET must be local or test \(got staging\)/],
    ['DB_TARGET=production alone', { ...LOCAL, DB_TARGET: 'production' }, /got production/],
    ['DB_TARGET unset', { ...LOCAL, DB_TARGET: undefined }, /got unset/],
    ['an unrecognised DB_TARGET (not echoed)', { ...LOCAL, DB_TARGET: `x-${SECRET}` }, /got an unrecognised value/],
    ['ALLOW_PRODUCTION_DB_COMMANDS on a local target', { ...LOCAL, ALLOW_PRODUCTION_DB_COMMANDS: 'true' }, /ALLOW_PRODUCTION_DB_COMMANDS is production command authority/],
    ['the identity bootstrap flag', { ...LOCAL, CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP: 'unbound-production-database' }, /CREWFLOW_DEPLOYMENT_IDENTITY_BOOTSTRAP/],
    ['NODE_ENV=production', { ...LOCAL, NODE_ENV: 'production' }, /NODE_ENV=production declares a deployed environment/],
    ['RAB_RUNTIME_ENV=staging', { ...LOCAL, RAB_RUNTIME_ENV: 'Staging' }, /RAB_RUNTIME_ENV=staging declares a deployed environment/],
    ['a declared staging deployment', { ...LOCAL, CREWFLOW_DEPLOYMENT_ENVIRONMENT: 'staging' }, /CREWFLOW_DEPLOYMENT_ENVIRONMENT=staging/],
    ['a remote (managed) database host', { ...LOCAL, PG_DATABASE_URL: `postgres://crewflow:${SECRET}@ep-x.eu-west-2.aws.neon.tech/neondb` }, /must be a loopback or docker-service database/],
    ['an unparseable URL (not echoed)', { ...LOCAL, PG_DATABASE_URL: `nope ${SECRET}` }, /not a parseable postgres URL \(value not shown\)/],
    ['no database URL', { ...LOCAL, PG_DATABASE_URL: undefined }, /PG_DATABASE_URL is required/],
  ])('refuses %s', (_name, env, pattern) => {
    let message = '';
    try {
      assertSeedCommandTarget('seed-qa', env);
    } catch (error) {
      expect(error).toBeInstanceOf(SeedTargetError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/^seed-qa refused/);
    expect(message).toMatch(pattern);
    expect(message).not.toContain(SECRET);
  });

  describe('live check: a database bound to a deployed environment', () => {
    const queryFor = (environment: string | null) => async (sql: string) => {
      if (/to_regprocedure/.test(sql)) return [{ present: true, database: 'rab', disposable_test: false }];
      if (/deployment_identity_check/.test(sql)) {
        return environment === null
          ? []
          : [{ environment, deployment_id: '6f2a3c1e-0000-4000-8000-000000000001', bound_database: 'rab', bound_hosts: ['127.0.0.1'] }];
      }
      throw new Error(`unexpected SQL in the read-only probe: ${sql.slice(0, 40)}`);
    };

    it.each(['production', 'staging'])('refuses a database bound to %s', async (environment) => {
      await expect(assertSeedDatabaseNotDeployed('seed', queryFor(environment))).rejects.toThrow(
        new RegExp(`seed refused: the database is bound to ${environment}`),
      );
    });

    it.each(['development', 'test', 'ci'])('allows a database bound to %s', async (environment) => {
      await expect(assertSeedDatabaseNotDeployed('seed', queryFor(environment))).resolves.toBeUndefined();
    });

    it('allows an unbound database and one without the marker function (fresh local / bundle-test databases)', async () => {
      await expect(assertSeedDatabaseNotDeployed('seed', queryFor(null))).resolves.toBeUndefined();
      await expect(
        assertSeedDatabaseNotDeployed('seed', async () => [{ present: false, database: 'rab', disposable_test: false }]),
      ).resolves.toBeUndefined();
    });
  });

  describe('the commands refuse before touching the database', () => {
    const untouchable = new Proxy({} as DataSource, {
      get(_target, prop) {
        throw new Error(`the seed touched the database (${String(prop)}) before refusing`);
      },
    });
    const tenant = {} as TenantContextService;
    const hashing = {} as PasswordHashingService;
    const saved = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    });

    it.each([
      ['seed', () => new SeedCommand(untouchable, tenant, hashing)],
      ['seed-qa', () => new SeedQaCommand(untouchable, tenant, hashing)],
    ] as const)('%s with production command authority is refused with nothing read or written', async (name, make) => {
      Object.assign(process.env, PRODUCTION, { SEED_ADMIN_PASSWORD: 'x'.repeat(16), SEED_QA_PASSWORD: 'x'.repeat(16) });
      delete process.env.DATABASE_URL;
      await expect(make().run()).rejects.toThrow(new RegExp(`^${name} refused`));
    });

    it.each([
      ['seed', () => new SeedCommand(untouchable, tenant, hashing)],
      ['seed-qa', () => new SeedQaCommand(untouchable, tenant, hashing)],
    ] as const)('%s with DB_TARGET=staging is refused with nothing read or written', async (name, make) => {
      Object.assign(process.env, LOCAL, { DB_TARGET: 'staging' });
      await expect(make().run()).rejects.toThrow(new RegExp(`^${name} refused[\\s\\S]*got staging`));
    });
  });
});
