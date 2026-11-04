import { validate } from './env.validation';

/**
 * Owner-login architecture: env.validation runs the shared runtime-db-config parser (database/owner-login/runtime-db-config.ts)
 * for CREWFLOW_MIGRATE_ON_START / CREWFLOW_MIGRATION_APPROVAL_MODE / CREWFLOW_UPGRADE_FAILURE_POLICY and refuses the removed
 * CREWFLOW_DB_MODE / DISABLE_DB_MIGRATIONS. The second-URL and role-password names are refused by the runtime guard
 * (never-in-runtime-env.ts), which the API and Worker run before boot.
 */
const base = { REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32), PG_DATABASE_URL: 'postgres://crewflow_owner:pg-secret@localhost:5432/rab' };

describe('env validation: owner-login database start-up settings', () => {
  it('accepts the settings unset (not required outside the API image entrypoint) and every allowed value', () => {
    expect(() => validate(base)).not.toThrow();
    for (const CREWFLOW_MIGRATE_ON_START of ['true', 'false']) {
      for (const CREWFLOW_MIGRATION_APPROVAL_MODE of ['none', 'token']) {
        for (const CREWFLOW_UPGRADE_FAILURE_POLICY of ['refuse', 'continue-if-compatible']) {
          const v = validate({ ...base, CREWFLOW_MIGRATE_ON_START, CREWFLOW_MIGRATION_APPROVAL_MODE, CREWFLOW_UPGRADE_FAILURE_POLICY });
          expect([v.CREWFLOW_MIGRATE_ON_START, v.CREWFLOW_MIGRATION_APPROVAL_MODE, v.CREWFLOW_UPGRADE_FAILURE_POLICY]).toEqual([
            CREWFLOW_MIGRATE_ON_START,
            CREWFLOW_MIGRATION_APPROVAL_MODE,
            CREWFLOW_UPGRADE_FAILURE_POLICY,
          ]);
        }
      }
    }
    // A compose `KEY=` line (blank) is unset.
    expect(() => validate({ ...base, CREWFLOW_MIGRATE_ON_START: '', CREWFLOW_UPGRADE_FAILURE_POLICY: '' })).not.toThrow();
  });

  it('refuses a value outside the allowed set, never echoing it', () => {
    for (const [name, value] of [
      ['CREWFLOW_MIGRATE_ON_START', 'yes-S3cret'],
      ['CREWFLOW_MIGRATION_APPROVAL_MODE', 'allowlist-S3cret'],
      ['CREWFLOW_UPGRADE_FAILURE_POLICY', 'continue-S3cret'],
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

  it('refuses the removed mode switch and Twenty CRM\'s migrate switch with an actionable message', () => {
    expect(() => validate({ ...base, CREWFLOW_DB_MODE: 'twenty' })).toThrow(/no database mode switch any more.*Remove CREWFLOW_DB_MODE/);
    expect(() => validate({ ...base, CREWFLOW_DB_MODE: 'separated' })).toThrow(/Remove CREWFLOW_DB_MODE/);
    expect(() => validate({ ...base, DISABLE_DB_MIGRATIONS: 'true' })).toThrow(/Twenty CRM's switch.*CREWFLOW_MIGRATE_ON_START/);
  });
});
