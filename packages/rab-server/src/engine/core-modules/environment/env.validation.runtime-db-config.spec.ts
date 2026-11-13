import { validate } from './env.validation';
import { resolveRuntimeDatabase, RuntimeDbError } from '../../../database/typeorm/core/runtime-database-guard';

/**
 * Owner-login architecture: env.validation runs the shared runtime-db-config parser (database/owner-login/runtime-db-config.ts)
 * for DISABLE_DB_MIGRATIONS / CREWFLOW_MIGRATE_ON_START / CREWFLOW_MIGRATION_APPROVAL_MODE and refuses the removed names
 * CREWFLOW_DB_MODE, CREWFLOW_UPGRADE_FAILURE and CREWFLOW_UPGRADE_FAILURE_POLICY (OWNER-DB-ULTIMATE Part B3). The second-URL and role-password names are refused by the runtime guard
 * (never-in-runtime-env.ts), which the API and Worker run before boot.
 */
const base = { REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32), PG_DATABASE_URL: 'postgres://crewflow_owner:pg-secret@localhost:5432/rab' };

describe('env validation: owner-login database start-up settings', () => {
  it('accepts the settings unset (not required outside the API image entrypoint) and every allowed value', () => {
    expect(() => validate(base)).not.toThrow();
    for (const CREWFLOW_MIGRATE_ON_START of ['true', 'false']) {
      for (const CREWFLOW_MIGRATION_APPROVAL_MODE of ['none', 'token']) {
        const v = validate({ ...base, CREWFLOW_MIGRATE_ON_START, CREWFLOW_MIGRATION_APPROVAL_MODE });
        expect([v.CREWFLOW_MIGRATE_ON_START, v.CREWFLOW_MIGRATION_APPROVAL_MODE]).toEqual([CREWFLOW_MIGRATE_ON_START, CREWFLOW_MIGRATION_APPROVAL_MODE]);
      }
    }
    // A compose `KEY=` line (blank) is unset.
    expect(() => validate({ ...base, CREWFLOW_MIGRATE_ON_START: '' })).not.toThrow();
    // A blank removed name is unset, as for every other name.
    expect(() => validate({ ...base, CREWFLOW_UPGRADE_FAILURE: '', CREWFLOW_UPGRADE_FAILURE_POLICY: '' })).not.toThrow();
  });

  it('refuses the removed CREWFLOW_UPGRADE_FAILURE and CREWFLOW_UPGRADE_FAILURE_POLICY with any value (OWNER-DB-ULTIMATE Part B3)', () => {
    expect(() => validate({ ...base, CREWFLOW_UPGRADE_FAILURE: 'continue' })).toThrow(/CREWFLOW_UPGRADE_FAILURE was removed \(OWNER-DB-ULTIMATE Part B3\)/);
    expect(() => validate({ ...base, CREWFLOW_UPGRADE_FAILURE: 'refuse' })).toThrow(/CREWFLOW_UPGRADE_FAILURE was removed \(OWNER-DB-ULTIMATE Part B3\)/);
    expect(() => validate({ ...base, CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' })).toThrow(
      /CREWFLOW_UPGRADE_FAILURE_POLICY was removed \(OWNER-DB-ULTIMATE Part B3\)/,
    );
  });

  it('CREWFLOW_UPGRADE_INCOMPLETE (set only by api-prestart.sh after a verified exit 70) must be a migration name or unknown', () => {
    for (const value of ['unknown', '1786730000000-Broken', 'StatementDispatchPointer1786721320000']) {
      expect(validate({ ...base, CREWFLOW_UPGRADE_INCOMPLETE: value }).CREWFLOW_UPGRADE_INCOMPLETE).toBe(value);
    }
    for (const value of ['a b', '<script>', 'x'.repeat(201), 'name;rm']) {
      expect(() => validate({ ...base, CREWFLOW_UPGRADE_INCOMPLETE: value })).toThrow(/CREWFLOW_UPGRADE_INCOMPLETE must be a migration name/);
    }
  });

  it('refuses a value outside the allowed set, never echoing it', () => {
    for (const [name, value] of [
      ['CREWFLOW_MIGRATE_ON_START', 'yes-S3cret'],
      ['CREWFLOW_MIGRATION_APPROVAL_MODE', 'allowlist-S3cret'],
      ['CREWFLOW_UPGRADE_FAILURE_POLICY', 'continue-S3cret'],
      ['CREWFLOW_UPGRADE_FAILURE', 'continue-S3cret'],
      ['DISABLE_DB_MIGRATIONS', 'yes-S3cret'],
    ] as const) {
      let message = '';
      try {
        validate({ ...base, [name]: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(new RegExp(`${name} must be exactly`));
      expect(message).not.toContain('S3cret');
    }
  });

  it('refuses the removed mode switch with an actionable message', () => {
    expect(() => validate({ ...base, CREWFLOW_DB_MODE: 'twenty' })).toThrow(/no database mode switch any more.*Remove CREWFLOW_DB_MODE/);
    expect(() => validate({ ...base, CREWFLOW_DB_MODE: 'separated' })).toThrow(/Remove CREWFLOW_DB_MODE/);
  });

  // ASSERTION CHANGE (owner decision C1, 2026-11-05): DISABLE_DB_MIGRATIONS used to be refused as "Twenty CRM's switch"; it is
  // now accepted (true | false; true = this process never migrates) on the API and the Worker alike.
  it('accepts DISABLE_DB_MIGRATIONS=true|false (owner decision C1), with or without CREWFLOW_MIGRATE_ON_START', () => {
    for (const DISABLE_DB_MIGRATIONS of ['true', 'false'] as const) {
      expect(validate({ ...base, DISABLE_DB_MIGRATIONS }).DISABLE_DB_MIGRATIONS).toBe(DISABLE_DB_MIGRATIONS);
      expect(() => validate({ ...base, DISABLE_DB_MIGRATIONS, CREWFLOW_MIGRATE_ON_START: 'true' })).not.toThrow();
    }
    expect(() => validate({ ...base, DISABLE_DB_MIGRATIONS: '' })).not.toThrow();
    expect(() => validate({ ...base, DISABLE_DB_MIGRATIONS: 'TRUE' })).toThrow(/DISABLE_DB_MIGRATIONS must be exactly/);
  });

  it('DB_TARGET / ALLOW_PRODUCTION_DB_COMMANDS: accepted by env validation (one-off CLI commands such as bootstrap-admin need them per invocation; database-target.ts decides) but refused by the API and Worker runtime guard', () => {
    // CLI side: the shared environment validation never refuses command authority.
    expect(() => validate({ ...base, DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' })).not.toThrow();
    expect(() => validate({ ...base, DB_TARGET: 'local' })).not.toThrow();
    // Runtime side: the long-running API and Worker refuse both, by name.
    for (const processName of ['api', 'worker'] as const) {
      for (const [name, value] of [['DB_TARGET', 'production'], ['ALLOW_PRODUCTION_DB_COMMANDS', 'true']] as const) {
        expect(() => resolveRuntimeDatabase({ processName, env: { NODE_ENV: 'development', PG_DATABASE_URL: base.PG_DATABASE_URL, [name]: value }, dotenvValues: {} })).toThrow(RuntimeDbError);
        expect(() => resolveRuntimeDatabase({ processName, env: { NODE_ENV: 'development', PG_DATABASE_URL: base.PG_DATABASE_URL, [name]: value }, dotenvValues: {} })).toThrow(
          new RegExp(`^${name} is present in the ${processName} process's environment`),
        );
      }
    }
  });

  it('migration test seams: accepted under NODE_ENV=test, refused otherwise (actionable)', () => {
    expect(() => validate({ ...base, NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_FAIL_AT: '1786700000000' })).not.toThrow();
    expect(() => validate({ ...base, NODE_ENV: 'development', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: '1786700000000' })).toThrow(
      /CREWFLOW_MIGRATION_TEST_STOP_BEFORE is a test seam: it is allowed only with NODE_ENV=test/,
    );
  });
});
