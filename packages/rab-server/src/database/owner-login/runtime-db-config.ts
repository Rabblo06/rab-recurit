/**
 * Owner-login architecture (owner's FINAL decision 2026-11-04, PERMANENT-OWNER-LOGIN-ADDENDUM; M0 §7): the ONE pure parser
 * of the database start-up settings that remain. There is no mode switch: the API, the Worker and the short-lived migrate
 * child all use the one `PG_DATABASE_URL` (the schema-owning `crewflow_owner` login, M0 §5.1). No I/O, no database, no
 * logging. Consumers:
 *   - env.validation.ts (API and Worker configuration validation at boot);
 *   - the migrate child and the upgrade-failure policy (Agent 1; they delegate to these parsers);
 *   - packages/rab-docker/rab/api-prestart.sh keeps a literal SHELL copy of the same rules (it runs before Node);
 *     runtime-db-config.spec.ts runs that shell copy against the same table of cases and fails when the two drift.
 *
 * Settings:
 *   CREWFLOW_MIGRATE_ON_START         true | false. The API image entrypoint (api-prestart.sh) REQUIRES it — an operator must
 *                                     choose; there is no default for whether the API changes the schema on start.
 *                                     Everywhere else (Worker, CLI, tests) unset means false and it is never read.
 *   CREWFLOW_MIGRATION_APPROVAL_MODE  none | token. Default none EVERYWHERE, production included (owner decision BC-11,
 *                                     2026-11-05: optional and off by default, like Twenty). A present value is validated.
 *   CREWFLOW_UPGRADE_FAILURE          continue (default) | refuse. Owner decision C3 (2026-11-05, "exactly like Twenty"): an
 *                                     UPGRADE whose migration fails is logged as an ERROR and the API starts anyway (exit 70);
 *                                     a first install, the configuration, the identity, the lock, the approval and the post-
 *                                     checks stay fail-closed. refuse = the previous behaviour (the API never starts).
 *   CREWFLOW_UPGRADE_FAILURE_POLICY   DEPRECATED alias, still honoured: refuse -> refuse, continue-if-compatible -> continue.
 *                                     Set together with CREWFLOW_UPGRADE_FAILURE, the two must agree (else exit 64).
 *
 * Removed names, refused with an actionable message so nobody believes they still do something:
 *   CREWFLOW_DB_MODE        there is no mode switch any more (one architecture: the owner login);
 *   DISABLE_DB_MIGRATIONS   Twenty CRM's switch; Crewflow reads CREWFLOW_MIGRATE_ON_START.
 *
 * Values are compared exactly (case-sensitive, no trimming); unset and blank are the same thing (a compose `KEY=` line).
 * A refusal names the variable and the allowed values and never echoes the value.
 */

export type MigrationApprovalMode = 'none' | 'token';
export type UpgradeFailurePolicy = 'continue' | 'refuse';

export const MIGRATE_ON_START_VAR = 'CREWFLOW_MIGRATE_ON_START';
export const MIGRATION_APPROVAL_MODE_VAR = 'CREWFLOW_MIGRATION_APPROVAL_MODE';
export const UPGRADE_FAILURE_VAR = 'CREWFLOW_UPGRADE_FAILURE';
/** Deprecated alias of CREWFLOW_UPGRADE_FAILURE (owner decision C3): its two values map onto the new ones. */
export const UPGRADE_FAILURE_POLICY_VAR = 'CREWFLOW_UPGRADE_FAILURE_POLICY';
export const DEPRECATED_UPGRADE_FAILURE_POLICY_VALUES: Readonly<Record<string, UpgradeFailurePolicy>> = Object.freeze({
  refuse: 'refuse',
  'continue-if-compatible': 'continue',
});
/** Names that no longer exist; refused (see the header). */
export const REMOVED_DB_CONFIG_VARS: Readonly<Record<string, string>> = Object.freeze({
  CREWFLOW_DB_MODE: 'There is no database mode switch any more: the API, the Worker and migrations all use the one PG_DATABASE_URL owner login. Remove CREWFLOW_DB_MODE.',
  DISABLE_DB_MIGRATIONS: 'DISABLE_DB_MIGRATIONS is Twenty CRM\'s switch and is not read by Crewflow. Remove it and set CREWFLOW_MIGRATE_ON_START=true or false.',
});

/**
 * Agent 1's migration test seams (the migrate child honours them only with NODE_ENV=test AND the server-side
 * crewflow.disposable_test_database=true AND a non-production target). This is the second layer: outside NODE_ENV=test they
 * are refused everywhere this parser runs (env validation, the runtime guard, api-prestart.sh).
 */
export const MIGRATION_TEST_SEAM_VARS = Object.freeze(['CREWFLOW_MIGRATION_TEST_STOP_BEFORE', 'CREWFLOW_MIGRATION_TEST_FAIL_AT'] as const);
/**
 * Every test seam refused outside NODE_ENV=test: Agent 1's migration seams, and the server-path provisioning deferral seam
 * (modules/manager-workspace/services/workspace-provisioning-test-seam.ts; itself effective only with NODE_ENV=test AND a
 * database marked crewflow.disposable_test_database).
 */
export const TEST_SEAM_VARS = Object.freeze([...MIGRATION_TEST_SEAM_VARS, 'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING'] as const);

export const MIGRATION_APPROVAL_MODES: readonly MigrationApprovalMode[] = Object.freeze(['none', 'token'] as const);
export const UPGRADE_FAILURE_POLICIES: readonly UpgradeFailurePolicy[] = Object.freeze(['continue', 'refuse'] as const);
export const DEFAULT_MIGRATION_APPROVAL_MODE: MigrationApprovalMode = 'none';
export const DEFAULT_UPGRADE_FAILURE_POLICY: UpgradeFailurePolicy = 'continue';

/**
 * Start-up exit codes (M0 §7, agreed with Agent 1 through the lead). 64 is the only one this parser produces; the rest are
 * listed so the shell entrypoint, the migrate child and their tests share one table.
 */
export const STARTUP_EXIT_CODES = Object.freeze({
  ok: 0,
  config: 64,
  behind: 65,
  migrationFailed: 66,
  identity: 67,
  postCheck: 68,
  lockTimeout: 69,
  /** An UPGRADE migration failed and CREWFLOW_UPGRADE_FAILURE=continue (the default): ERROR logged, the API starts anyway. */
  degradedContinue: 70,
} as const);

export class RuntimeDbConfigError extends Error {
  readonly exitCode = STARTUP_EXIT_CODES.config;
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeDbConfigError';
  }
}

type Env = Record<string, string | undefined> | NodeJS.ProcessEnv;

function raw(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new RuntimeDbConfigError(`${name} must be exactly one of: ${allowed.join(', ')}. Refusing to start.`);
}

export interface ReadRuntimeDbConfigOptions {
  /** True only for the API image entrypoint (api-prestart.sh and its parity test): CREWFLOW_MIGRATE_ON_START has no default there. */
  requireMigrateOnStart?: boolean;
}

export interface RuntimeDbConfig {
  migrateOnStart: boolean;
  migrationApprovalMode: MigrationApprovalMode;
  upgradeFailurePolicy: UpgradeFailurePolicy;
}

/** CREWFLOW_MIGRATE_ON_START (see the header). */
export function readMigrateOnStart(env: Env, options: ReadRuntimeDbConfigOptions = {}): boolean {
  const value = raw(env, MIGRATE_ON_START_VAR);
  if (value === undefined) {
    if (options.requireMigrateOnStart) {
      throw new RuntimeDbConfigError(
        `${MIGRATE_ON_START_VAR} is required on the API service: set it to true (the API applies pending migrations on start, under the migration lock) or false (a release step runs them first). Refusing to start.`,
      );
    }
    return false;
  }
  return oneOf(MIGRATE_ON_START_VAR, value, ['true', 'false'] as const) === 'true';
}

/** CREWFLOW_MIGRATION_APPROVAL_MODE (see the header). */
export function readMigrationApprovalMode(env: Env, options: ReadRuntimeDbConfigOptions = {}): MigrationApprovalMode {
  const value = raw(env, MIGRATION_APPROVAL_MODE_VAR);
  // Owner decision BC-11 (2026-11-05): the per-release approval token is OPTIONAL and OFF by default everywhere, production
  // included (like Twenty). A value that is present is still validated (anything but none | token refuses, exit 64);
  // `token` is enforced by the migrate child, and the approval value still reaches only that child, never main.js.
  void options;
  return value === undefined ? DEFAULT_MIGRATION_APPROVAL_MODE : oneOf(MIGRATION_APPROVAL_MODE_VAR, value, MIGRATION_APPROVAL_MODES);
}

/** CREWFLOW_UPGRADE_FAILURE, with its deprecated alias (see the header). Agent 1's parseUpgradeFailurePolicy delegates here. */
export function readUpgradeFailurePolicy(env: Env): UpgradeFailurePolicy {
  const value = raw(env, UPGRADE_FAILURE_VAR);
  const current = value === undefined ? undefined : oneOf(UPGRADE_FAILURE_VAR, value, UPGRADE_FAILURE_POLICIES);
  const legacy = raw(env, UPGRADE_FAILURE_POLICY_VAR);
  const aliased = legacy === undefined ? undefined : DEPRECATED_UPGRADE_FAILURE_POLICY_VALUES[legacy];
  if (legacy !== undefined && aliased === undefined) {
    throw new RuntimeDbConfigError(
      `${UPGRADE_FAILURE_POLICY_VAR} is deprecated and must be exactly one of: ${Object.keys(DEPRECATED_UPGRADE_FAILURE_POLICY_VALUES).join(', ')}; use ${UPGRADE_FAILURE_VAR}=continue|refuse instead. Refusing to start.`,
    );
  }
  if (current !== undefined && aliased !== undefined && current !== aliased) {
    throw new RuntimeDbConfigError(`${UPGRADE_FAILURE_VAR} and the deprecated ${UPGRADE_FAILURE_POLICY_VAR} disagree; remove ${UPGRADE_FAILURE_POLICY_VAR}. Refusing to start.`);
  }
  return current ?? aliased ?? DEFAULT_UPGRADE_FAILURE_POLICY;
}

/** Every remaining database start-up setting, validated together. Throws RuntimeDbConfigError (exit 64) on the first problem. */
export function readRuntimeDbConfig(env: Env, options: ReadRuntimeDbConfigOptions = {}): RuntimeDbConfig {
  for (const [name, why] of Object.entries(REMOVED_DB_CONFIG_VARS)) {
    if (raw(env, name) !== undefined) throw new RuntimeDbConfigError(`${why} Refusing to start.`);
  }
  if (raw(env, 'NODE_ENV') !== 'test') {
    for (const name of TEST_SEAM_VARS) {
      if (raw(env, name) !== undefined) {
        throw new RuntimeDbConfigError(`${name} is a test seam: it is allowed only with NODE_ENV=test on a disposable test database. Remove it. Refusing to start.`);
      }
    }
  }
  return {
    migrateOnStart: readMigrateOnStart(env, options),
    migrationApprovalMode: readMigrationApprovalMode(env, options),
    upgradeFailurePolicy: readUpgradeFailurePolicy(env),
  };
}

/** Problems as strings (env.validation.ts style), or an empty list. */
export function runtimeDbConfigProblems(env: Env, options: ReadRuntimeDbConfigOptions = {}): string[] {
  try {
    readRuntimeDbConfig(env, options);
    return [];
  } catch (error) {
    if (error instanceof RuntimeDbConfigError) return [error.message];
    throw error;
  }
}
