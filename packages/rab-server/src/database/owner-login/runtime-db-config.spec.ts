import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { MIGRATION_APPROVAL_MODES, readRuntimeDbConfig, RuntimeDbConfigError, runtimeDbConfigProblems, STARTUP_EXIT_CODES } from './runtime-db-config';

/**
 * Owner-login architecture: the one parser of DISABLE_DB_MIGRATIONS / CREWFLOW_MIGRATE_ON_START /
 * CREWFLOW_MIGRATION_APPROVAL_MODE (and the removed CREWFLOW_DB_MODE / CREWFLOW_UPGRADE_FAILURE / CREWFLOW_UPGRADE_FAILURE_POLICY), and its literal shell copy in api-prestart.sh (run here with the real `sh` and compared
 * case by case, messages included).
 */
const PRESTART = path.resolve(__dirname, '../../../../rab-docker/rab/api-prestart.sh');
const API = { requireMigrateOnStart: true } as const;

type Env = Record<string, string | undefined>;
type Outcome = { ok: { disableDbMigrations: boolean; migrateOnStart: boolean; migrationApprovalMode: string } } | { refused: string };

function tsOutcome(env: Env, options = API): Outcome {
  try {
    return { ok: readRuntimeDbConfig(env, options) };
  } catch (error) {
    if (error instanceof RuntimeDbConfigError) return { refused: error.message };
    throw error;
  }
}

/** The BEGIN/END block of api-prestart.sh, run by `sh` with a stub `refuse` and the given environment only. */
function shellOutcome(env: Env): Outcome {
  const script = fs.readFileSync(PRESTART, 'utf8');
  const begin = script.indexOf('# BEGIN owner-login runtime-db-config');
  const end = script.indexOf('# END owner-login runtime-db-config');
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const driver = [
    'set -eu',
    'refuse() { printf "REFUSED:%s\\n" "$1"; exit 64; }',
    script.slice(begin, end),
    'crewflow_runtime_db_config',
    'printf "OK:%s:%s:%s\\n" "$DISABLE_MIGRATIONS" "$MIGRATE_ON_START" "$APPROVAL_MODE"',
  ].join('\n');
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const r = spawnSync('sh', ['-c', driver], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...clean } });
  const out = r.stdout.trim();
  if (out.startsWith('REFUSED:')) {
    expect(r.status).toBe(STARTUP_EXIT_CODES.config);
    return { refused: out.slice('REFUSED:'.length) };
  }
  expect(r.status).toBe(0);
  const [, disabled, migrate, approval] = out.split(':');
  return { ok: { disableDbMigrations: disabled === 'true', migrateOnStart: migrate === 'true', migrationApprovalMode: approval! } };
}

const CASES: Array<[string, Env]> = [
  ['unset (API: required)', {}],
  ['blank (API: required)', { CREWFLOW_MIGRATE_ON_START: '' }],
  ['false', { CREWFLOW_MIGRATE_ON_START: 'false' }],
  ['true, development', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'development' }],
  ['true, production, approval unset', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' }],
  ['true, RAB_RUNTIME_ENV production only, approval unset', { CREWFLOW_MIGRATE_ON_START: 'true', RAB_RUNTIME_ENV: 'production' }],
  ['true, production, approval token', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }],
  ['true, production, approval none', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'none' }],
  ['false, production, approval unset', { CREWFLOW_MIGRATE_ON_START: 'false', NODE_ENV: 'production' }],
  ['TRUE (case)', { CREWFLOW_MIGRATE_ON_START: 'TRUE' }],
  ['1', { CREWFLOW_MIGRATE_ON_START: '1' }],
  ['" true" (spaces)', { CREWFLOW_MIGRATE_ON_START: ' true' }],
  ['approval Token', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_MIGRATION_APPROVAL_MODE: 'Token' }],
  ['approval allowlist', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_MIGRATION_APPROVAL_MODE: 'allowlist' }],
  // OWNER-DB-ULTIMATE Part B3: the C3 choices are removed; any value of either name is refused (blank = absent).
  ['CREWFLOW_UPGRADE_FAILURE=continue (removed)', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE: 'continue' }],
  ['CREWFLOW_UPGRADE_FAILURE=refuse (removed)', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE: 'refuse' }],
  ['CREWFLOW_UPGRADE_FAILURE blank = absent', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE: '' }],
  ['CREWFLOW_UPGRADE_FAILURE_POLICY=continue-if-compatible (removed)', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }],
  ['CREWFLOW_UPGRADE_FAILURE_POLICY=refuse (removed)', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' }],
  ['CREWFLOW_UPGRADE_FAILURE_POLICY blank = absent', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: '' }],
  ['both removed names: the first is reported', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE: 'continue', CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' }],
  ['a removed name wins over a bad value', { CREWFLOW_MIGRATE_ON_START: 'maybe', CREWFLOW_UPGRADE_FAILURE: 'x' }],
  ['CREWFLOW_UPGRADE_INCOMPLETE (retired)', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_INCOMPLETE: 'Beta1786000000100' }],
  ['CREWFLOW_UPGRADE_INCOMPLETE blank = absent', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_INCOMPLETE: '' }],
  ['CREWFLOW_DB_MODE=separated (removed)', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_DB_MODE: 'separated' }],
  ['CREWFLOW_DB_MODE=twenty (removed)', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_DB_MODE: 'twenty' }],
  ['CREWFLOW_DB_MODE blank = absent', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_DB_MODE: '' }],
  // Owner decision C1 (2026-11-05): DISABLE_DB_MIGRATIONS is accepted (true = this process never migrates).
  ['DISABLE_DB_MIGRATIONS=true, migrate-on-start unset (not required)', { DISABLE_DB_MIGRATIONS: 'true' }],
  ['DISABLE_DB_MIGRATIONS=true overrides CREWFLOW_MIGRATE_ON_START=true', { DISABLE_DB_MIGRATIONS: 'true', CREWFLOW_MIGRATE_ON_START: 'true' }],
  ['DISABLE_DB_MIGRATIONS=true, CREWFLOW_MIGRATE_ON_START=false', { DISABLE_DB_MIGRATIONS: 'true', CREWFLOW_MIGRATE_ON_START: 'false' }],
  ['DISABLE_DB_MIGRATIONS=true still validates a present CREWFLOW_MIGRATE_ON_START', { DISABLE_DB_MIGRATIONS: 'true', CREWFLOW_MIGRATE_ON_START: 'yes' }],
  ['DISABLE_DB_MIGRATIONS=false, migrate-on-start true', { DISABLE_DB_MIGRATIONS: 'false', CREWFLOW_MIGRATE_ON_START: 'true' }],
  ['DISABLE_DB_MIGRATIONS=false, migrate-on-start unset (still required)', { DISABLE_DB_MIGRATIONS: 'false' }],
  ['DISABLE_DB_MIGRATIONS blank = false', { DISABLE_DB_MIGRATIONS: '', CREWFLOW_MIGRATE_ON_START: 'true' }],
  ['DISABLE_DB_MIGRATIONS=TRUE (case)', { DISABLE_DB_MIGRATIONS: 'TRUE', CREWFLOW_MIGRATE_ON_START: 'true' }],
  ['DISABLE_DB_MIGRATIONS=1', { DISABLE_DB_MIGRATIONS: '1' }],
  ['DISABLE_DB_MIGRATIONS invalid is reported before a bad CREWFLOW_MIGRATE_ON_START', { DISABLE_DB_MIGRATIONS: 'yes', CREWFLOW_MIGRATE_ON_START: 'maybe' }],
  ['removed name wins over a bad value', { CREWFLOW_MIGRATE_ON_START: 'maybe', CREWFLOW_DB_MODE: 'twenty' }],
  ['test seam STOP_BEFORE in production', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'none', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: '1786700000000' }],
  ['test seam FAIL_AT in development', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'development', CREWFLOW_MIGRATION_TEST_FAIL_AT: '1786700000000' }],
  ['test seam FAIL_AT with NODE_ENV unset', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_TEST_FAIL_AT: 'x' }],
  // Security review L1 (Part B): the upgrade logbook's probe-command seams.
  ['upgrade probe commands seam in production', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_TEST_UPGRADE_COMMANDS: 'Probe' }],
  ['upgrade fail-command seam in production', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_TEST_UPGRADE_FAIL_COMMAND: 'Probe' }],
  ['upgrade seams under NODE_ENV=test (allowed)', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'test', CREWFLOW_TEST_UPGRADE_COMMANDS: 'Probe', CREWFLOW_TEST_UPGRADE_FAIL_COMMAND: 'Probe' }],
  ['provisioning deferral seam in production', { CREWFLOW_MIGRATE_ON_START: 'false', NODE_ENV: 'production', CREWFLOW_TEST_DEFER_SERVER_PROVISIONING: 'true' }],
  ['provisioning deferral seam under NODE_ENV=test (allowed)', { CREWFLOW_MIGRATE_ON_START: 'false', NODE_ENV: 'test', CREWFLOW_TEST_DEFER_SERVER_PROVISIONING: 'true' }],
  ['test seams under NODE_ENV=test (allowed)', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: 'a', CREWFLOW_MIGRATION_TEST_FAIL_AT: 'b' }],
  // DB-SETUP (plan §2.2): the prestart shell holds the database ADMIN URL until the swap, so neither copy applies the
  // runtime-login rule (checkRuntimeLogin; runtime-login.spec.ts) — both accept it here.
  ['production with an admin PG_DATABASE_URL (runtime-login rule is not part of this parser)', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production', PG_DATABASE_URL: 'postgres://doadmin:S3cret@db:5432/crewflow?sslmode=verify-full' }],
  ['DB_TARGET + ALLOW_PRODUCTION_DB_COMMANDS are outside this parser (CLI authority; the runtime guard refuses them)', { CREWFLOW_MIGRATE_ON_START: 'false', DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' }],
];

describe('runtime-db-config (owner-login architecture)', () => {
  it('the API entrypoint requires CREWFLOW_MIGRATE_ON_START; elsewhere unset means false', () => {
    expect(tsOutcome({})).toEqual({ refused: expect.stringMatching(/^CREWFLOW_MIGRATE_ON_START is required on the API service/) });
    expect(readRuntimeDbConfig({}, {})).toEqual({ disableDbMigrations: false, migrateOnStart: false, migrationApprovalMode: 'none' });
    expect(runtimeDbConfigProblems({})).toEqual([]);
  });

  it('defaults: approval none — production included (BC-11: the approval token is optional, off by default)', () => {
    expect(readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true' }, API)).toEqual({ disableDbMigrations: false, migrateOnStart: true, migrationApprovalMode: 'none' });
    // Production with migrate-on-start and NO approval mode: accepted, none.
    expect(readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', RAB_RUNTIME_ENV: 'production' }, API).migrationApprovalMode).toBe('none');
    // Production with token: token (enforced by the migrate child).
    expect(readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }).migrationApprovalMode).toBe('token');
    // A present but invalid value still refuses (exit 64).
    expect(() => readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'allowlist' })).toThrow(RuntimeDbConfigError);
    expect(() => readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'allowlist' })).toThrow(/must be exactly one of: none, token/);
  });

  it('allowed sets are exactly the documented ones', () => {
    expect(MIGRATION_APPROVAL_MODES).toEqual(['none', 'token']);
    expect(STARTUP_EXIT_CODES).toEqual({ ok: 0, config: 64, behind: 65, migrationFailed: 66, identity: 67, postCheck: 68, lockTimeout: 69, degradedContinue: 70 });
  });

  it('a refusal never echoes the value', () => {
    for (const name of ['CREWFLOW_MIGRATE_ON_START', 'CREWFLOW_MIGRATION_APPROVAL_MODE', 'CREWFLOW_UPGRADE_FAILURE', 'CREWFLOW_UPGRADE_FAILURE_POLICY', 'CREWFLOW_DB_MODE', 'DISABLE_DB_MIGRATIONS']) {
      const [problem] = runtimeDbConfigProblems({ CREWFLOW_MIGRATE_ON_START: 'false', [name]: 'S3cret-value-do-not-print' });
      expect(problem).toBeDefined();
      expect(problem).not.toContain('S3cret-value-do-not-print');
    }
  });

  it('migration test seams: allowed only under NODE_ENV=test; refused in production and everywhere else with an actionable message', () => {
    for (const name of ['CREWFLOW_MIGRATION_TEST_STOP_BEFORE', 'CREWFLOW_MIGRATION_TEST_FAIL_AT', 'CREWFLOW_TEST_UPGRADE_COMMANDS', 'CREWFLOW_TEST_UPGRADE_FAIL_COMMAND', 'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING']) {
      expect(runtimeDbConfigProblems({ NODE_ENV: 'test', [name]: '1786700000000' })).toEqual([]);
      for (const NODE_ENV of ['production', 'development', undefined]) {
        expect(runtimeDbConfigProblems({ NODE_ENV, [name]: '1786700000000' })).toEqual([
          `${name} is a test seam: it is allowed only with NODE_ENV=test on a disposable test database. Remove it. Refusing to start.`,
        ]);
      }
    }
  });

  it('DISABLE_DB_MIGRATIONS (owner decision C1): true = this process never migrates; it lifts the API requirement and overrides migrate-on-start', () => {
    expect(readRuntimeDbConfig({ DISABLE_DB_MIGRATIONS: 'true' }, API)).toMatchObject({ disableDbMigrations: true, migrateOnStart: false });
    expect(readRuntimeDbConfig({ DISABLE_DB_MIGRATIONS: 'true', CREWFLOW_MIGRATE_ON_START: 'true' }, API)).toMatchObject({ disableDbMigrations: true, migrateOnStart: false });
    expect(readRuntimeDbConfig({ DISABLE_DB_MIGRATIONS: 'false', CREWFLOW_MIGRATE_ON_START: 'true' }, API)).toMatchObject({ disableDbMigrations: false, migrateOnStart: true });
    // The Worker (no requirement): set or unset, it never migrates.
    expect(readRuntimeDbConfig({ DISABLE_DB_MIGRATIONS: 'true' })).toMatchObject({ disableDbMigrations: true, migrateOnStart: false });
    expect(() => readRuntimeDbConfig({ DISABLE_DB_MIGRATIONS: 'yes' })).toThrow('DISABLE_DB_MIGRATIONS must be exactly one of: true, false. Refusing to start.');
    expect(() => readRuntimeDbConfig({ DISABLE_DB_MIGRATIONS: 'false' }, API)).toThrow(/^CREWFLOW_MIGRATE_ON_START is required on the API service/);
  });

  it('CREWFLOW_UPGRADE_FAILURE and CREWFLOW_UPGRADE_FAILURE_POLICY are removed (OWNER-DB-ULTIMATE Part B3): any value refuses (64)', () => {
    for (const name of ['CREWFLOW_UPGRADE_FAILURE', 'CREWFLOW_UPGRADE_FAILURE_POLICY']) {
      for (const value of ['continue', 'refuse', 'continue-if-compatible', 'constructor']) {
        expect(() => readRuntimeDbConfig({ [name]: value })).toThrow(new RegExp(`^${name} was removed \\(OWNER-DB-ULTIMATE Part B3\\)`));
      }
      expect(readRuntimeDbConfig({ [name]: '' })).toEqual({ disableDbMigrations: false, migrateOnStart: false, migrationApprovalMode: 'none' });
    }
  });

  it('RuntimeDbConfigError carries exit code 64', () => {
    expect(new RuntimeDbConfigError('x').exitCode).toBe(64);
  });

  it.each(CASES)('api-prestart.sh shell copy agrees with the parser: %s', (_label, env) => {
    expect(shellOutcome(env)).toEqual(tsOutcome(env));
  });
});
