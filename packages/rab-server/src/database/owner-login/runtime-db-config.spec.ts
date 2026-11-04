import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  MIGRATION_APPROVAL_MODES,
  readRuntimeDbConfig,
  RuntimeDbConfigError,
  runtimeDbConfigProblems,
  STARTUP_EXIT_CODES,
  UPGRADE_FAILURE_POLICIES,
} from './runtime-db-config';

/**
 * Owner-login architecture: the one parser of CREWFLOW_MIGRATE_ON_START / CREWFLOW_MIGRATION_APPROVAL_MODE /
 * CREWFLOW_UPGRADE_FAILURE_POLICY, and its literal shell copy in api-prestart.sh (run here with the real `sh` and compared
 * case by case, messages included).
 */
const PRESTART = path.resolve(__dirname, '../../../../rab-docker/rab/api-prestart.sh');
const API = { requireMigrateOnStart: true } as const;

type Env = Record<string, string | undefined>;
type Outcome = { ok: { migrateOnStart: boolean; migrationApprovalMode: string; upgradeFailurePolicy: string } } | { refused: string };

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
    'printf "OK:%s:%s:%s\\n" "$MIGRATE_ON_START" "$APPROVAL_MODE" "$UPGRADE_POLICY"',
  ].join('\n');
  const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const r = spawnSync('sh', ['-c', driver], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...clean } });
  const out = r.stdout.trim();
  if (out.startsWith('REFUSED:')) {
    expect(r.status).toBe(STARTUP_EXIT_CODES.config);
    return { refused: out.slice('REFUSED:'.length) };
  }
  expect(r.status).toBe(0);
  const [, migrate, approval, policy] = out.split(':');
  return { ok: { migrateOnStart: migrate === 'true', migrationApprovalMode: approval!, upgradeFailurePolicy: policy! } };
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
  ['policy continue-if-compatible', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue-if-compatible' }],
  ['policy refuse', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: 'refuse' }],
  ['policy continue', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: 'continue' }],
  ['policy blank = refuse', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_UPGRADE_FAILURE_POLICY: '' }],
  ['CREWFLOW_DB_MODE=separated (removed)', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_DB_MODE: 'separated' }],
  ['CREWFLOW_DB_MODE=twenty (removed)', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_DB_MODE: 'twenty' }],
  ['CREWFLOW_DB_MODE blank = absent', { CREWFLOW_MIGRATE_ON_START: 'false', CREWFLOW_DB_MODE: '' }],
  ['DISABLE_DB_MIGRATIONS (Twenty CRM)', { CREWFLOW_MIGRATE_ON_START: 'true', DISABLE_DB_MIGRATIONS: 'false' }],
  ['removed name wins over a bad value', { CREWFLOW_MIGRATE_ON_START: 'maybe', CREWFLOW_DB_MODE: 'twenty' }],
  ['test seam STOP_BEFORE in production', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'none', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: '1786700000000' }],
  ['test seam FAIL_AT in development', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'development', CREWFLOW_MIGRATION_TEST_FAIL_AT: '1786700000000' }],
  ['test seam FAIL_AT with NODE_ENV unset', { CREWFLOW_MIGRATE_ON_START: 'true', CREWFLOW_MIGRATION_TEST_FAIL_AT: 'x' }],
  ['test seams under NODE_ENV=test (allowed)', { CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'test', CREWFLOW_MIGRATION_TEST_STOP_BEFORE: 'a', CREWFLOW_MIGRATION_TEST_FAIL_AT: 'b' }],
  ['DB_TARGET + ALLOW_PRODUCTION_DB_COMMANDS are outside this parser (CLI authority; the runtime guard refuses them)', { CREWFLOW_MIGRATE_ON_START: 'false', DB_TARGET: 'production', ALLOW_PRODUCTION_DB_COMMANDS: 'true' }],
];

describe('runtime-db-config (owner-login architecture)', () => {
  it('the API entrypoint requires CREWFLOW_MIGRATE_ON_START; elsewhere unset means false', () => {
    expect(tsOutcome({})).toEqual({ refused: expect.stringMatching(/^CREWFLOW_MIGRATE_ON_START is required on the API service/) });
    expect(readRuntimeDbConfig({}, {})).toEqual({ migrateOnStart: false, migrationApprovalMode: 'none', upgradeFailurePolicy: 'refuse' });
    expect(runtimeDbConfigProblems({})).toEqual([]);
  });

  it('defaults: approval none, policy refuse; production + migrate-on-start needs an explicit approval mode', () => {
    expect(readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true' }, API)).toEqual({ migrateOnStart: true, migrationApprovalMode: 'none', upgradeFailurePolicy: 'refuse' });
    expect(() => readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production' })).toThrow(/must be set explicitly/);
    expect(readRuntimeDbConfig({ CREWFLOW_MIGRATE_ON_START: 'true', NODE_ENV: 'production', CREWFLOW_MIGRATION_APPROVAL_MODE: 'token' }).migrationApprovalMode).toBe('token');
  });

  it('allowed sets are exactly the documented ones', () => {
    expect(MIGRATION_APPROVAL_MODES).toEqual(['none', 'token']);
    expect(UPGRADE_FAILURE_POLICIES).toEqual(['refuse', 'continue-if-compatible']);
    expect(STARTUP_EXIT_CODES).toEqual({ ok: 0, config: 64, behind: 65, migrationFailed: 66, identity: 67, postCheck: 68, lockTimeout: 69, degradedContinue: 70 });
  });

  it('a refusal never echoes the value', () => {
    for (const name of ['CREWFLOW_MIGRATE_ON_START', 'CREWFLOW_MIGRATION_APPROVAL_MODE', 'CREWFLOW_UPGRADE_FAILURE_POLICY', 'CREWFLOW_DB_MODE']) {
      const [problem] = runtimeDbConfigProblems({ CREWFLOW_MIGRATE_ON_START: 'false', [name]: 'S3cret-value-do-not-print' });
      expect(problem).toBeDefined();
      expect(problem).not.toContain('S3cret-value-do-not-print');
    }
  });

  it('migration test seams: allowed only under NODE_ENV=test; refused in production and everywhere else with an actionable message', () => {
    for (const name of ['CREWFLOW_MIGRATION_TEST_STOP_BEFORE', 'CREWFLOW_MIGRATION_TEST_FAIL_AT']) {
      expect(runtimeDbConfigProblems({ NODE_ENV: 'test', [name]: '1786700000000' })).toEqual([]);
      for (const NODE_ENV of ['production', 'development', undefined]) {
        expect(runtimeDbConfigProblems({ NODE_ENV, [name]: '1786700000000' })).toEqual([
          `${name} is a migration test seam: it is allowed only with NODE_ENV=test on a disposable test database. Remove it. Refusing to start.`,
        ]);
      }
    }
  });

  it('RuntimeDbConfigError carries exit code 64', () => {
    expect(new RuntimeDbConfigError('x').exitCode).toBe(64);
  });

  it.each(CASES)('api-prestart.sh shell copy agrees with the parser: %s', (_label, env) => {
    expect(shellOutcome(env)).toEqual(tsOutcome(env));
  });
});
