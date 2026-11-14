/**
 * Owner-login architecture (owner's FINAL decision 2026-11-04, PERMANENT-OWNER-LOGIN-ADDENDUM; M0 §7): the ONE pure parser
 * of the database start-up settings that remain. There is no mode switch: the API, the Worker and the short-lived migrate
 * child all use the one `PG_DATABASE_URL` (the schema-owning `crewflow_owner` login, M0 §5.1). No I/O, no database, no
 * logging. Consumers:
 *   - env.validation.ts (API and Worker configuration validation at boot);
 *   - the migrate child and the manual `upgrade` command (they delegate to these parsers);
 *   - packages/rab-docker/rab/api-prestart.sh keeps a literal SHELL copy of the same rules (it runs before Node);
 *     runtime-db-config.spec.ts runs that shell copy against the same table of cases and fails when the two drift.
 *
 * Settings:
 *   DISABLE_DB_MIGRATIONS             true | false (unset = false). Owner decision C1 (2026-11-05, "exactly like Twenty"):
 *                                     true means THIS PROCESS NEVER MIGRATES. On the API it overrides
 *                                     CREWFLOW_MIGRATE_ON_START (api-prestart.sh skips the migrate child and runs only the
 *                                     read-only pending check), and CREWFLOW_MIGRATE_ON_START is then not required. The Worker
 *                                     never migrates, whether this is set or not.
 *   CREWFLOW_MIGRATE_ON_START         true | false. The API image entrypoint (api-prestart.sh) REQUIRES it unless
 *                                     DISABLE_DB_MIGRATIONS=true — an operator must choose; there is no default for whether
 *                                     the API changes the schema on start. Everywhere else (Worker, CLI, tests) unset means
 *                                     false. A present value is always validated.
 *   CREWFLOW_MIGRATION_APPROVAL_MODE  none | token. Default none EVERYWHERE, production included (owner decision BC-11,
 *                                     2026-11-05: optional and off by default, like Twenty). A present value is validated.
 *
 * Removed names, refused with an actionable message so nobody believes they still do something:
 *   CREWFLOW_DB_MODE                  there is no mode switch any more (one architecture: the owner login).
 *   CREWFLOW_UPGRADE_FAILURE          OWNER-DB-ULTIMATE Part B3 (owner: "Remove the CREWFLOW_UPGRADE_FAILURE choices"): a
 *   CREWFLOW_UPGRADE_FAILURE_POLICY   failed migration always refuses (66) and the next start retries it; only a failed
 *                                     upgrade COMMAND serves (70). There is nothing left to choose.
 *   CREWFLOW_UPGRADE_INCOMPLETE       retired with the C3 relaxation (OWNER-DB-ULTIMATE Part B3).
 *
 * Values are compared exactly (case-sensitive, no trimming); unset and blank are the same thing (a compose `KEY=` line).
 * A refusal names the variable and the allowed values and never echoes the value.
 *
 * DB-SETUP (plan §2.2, 2026-11-12): checkRuntimeLogin is the runtime-login rule — in production the API, the Worker and the
 * migrate child refuse any PG_DATABASE_URL login other than crewflow_owner BEFORE connecting. It parses the URL with the
 * policy parser (owner-credential.ts isOwnerLoginUrl) but is still pure: no I/O, no connection, no logging. It is a separate function on
 * purpose (see its comment): the prestart shell copy and the bootstrap child legitimately hold the admin URL.
 */

import { readPrimaryDatabaseUrl } from '../postgres/pg-config';
import { isOwnerLoginUrl, OWNER_LOGIN, OwnerCredentialError } from './owner-credential';

export type MigrationApprovalMode = 'none' | 'token';

export const MIGRATE_ON_START_VAR = 'CREWFLOW_MIGRATE_ON_START';
/** Owner decision C1 (2026-11-05): Twenty's switch, accepted — true = this process never migrates (see the header). */
export const DISABLE_DB_MIGRATIONS_VAR = 'DISABLE_DB_MIGRATIONS';
export const MIGRATION_APPROVAL_MODE_VAR = 'CREWFLOW_MIGRATION_APPROVAL_MODE';
/** Names that no longer exist; refused (see the header). */
const UPGRADE_FAILURE_REMOVED =
  'was removed (OWNER-DB-ULTIMATE Part B3): a failed migration always refuses to start and is retried on the next start; only a failed upgrade command serves, with upgradeFailed:true on /healthz. Remove it from the environment.';
export const REMOVED_DB_CONFIG_VARS: Readonly<Record<string, string>> = Object.freeze({
  CREWFLOW_DB_MODE: 'There is no database mode switch any more: the API, the Worker and migrations all use the one PG_DATABASE_URL owner login. Remove CREWFLOW_DB_MODE.',
  CREWFLOW_UPGRADE_FAILURE: `CREWFLOW_UPGRADE_FAILURE ${UPGRADE_FAILURE_REMOVED}`,
  CREWFLOW_UPGRADE_FAILURE_POLICY: `CREWFLOW_UPGRADE_FAILURE_POLICY ${UPGRADE_FAILURE_REMOVED}`,
  CREWFLOW_UPGRADE_INCOMPLETE:
    'CREWFLOW_UPGRADE_INCOMPLETE was retired (OWNER-DB-ULTIMATE Part B3): nothing sets it, and no gate accepts a pending migration any more. Remove it from the environment.',
});

/**
 * Agent 1's migration test seams (the migrate child honours them only with NODE_ENV=test AND the server-side
 * crewflow.disposable_test_database=true AND a non-production target). This is the second layer: outside NODE_ENV=test they
 * are refused everywhere this parser runs (env validation, the runtime guard, api-prestart.sh). OWNER-DB-ULTIMATE Part B
 * (security review L1): the upgrade logbook's probe-command seams are held to the same second layer.
 */
export const MIGRATION_TEST_SEAM_VARS = Object.freeze([
  'CREWFLOW_MIGRATION_TEST_STOP_BEFORE',
  'CREWFLOW_MIGRATION_TEST_FAIL_AT',
  'CREWFLOW_TEST_UPGRADE_COMMANDS',
  'CREWFLOW_TEST_UPGRADE_FAIL_COMMAND',
] as const);
/**
 * Every test seam refused outside NODE_ENV=test: Agent 1's migration seams, and the server-path provisioning deferral seam
 * (modules/manager-workspace/services/workspace-provisioning-test-seam.ts; itself effective only with NODE_ENV=test AND a
 * database marked crewflow.disposable_test_database).
 */
export const TEST_SEAM_VARS = Object.freeze([...MIGRATION_TEST_SEAM_VARS, 'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING'] as const);

export const MIGRATION_APPROVAL_MODES: readonly MigrationApprovalMode[] = Object.freeze(['none', 'token'] as const);
export const DEFAULT_MIGRATION_APPROVAL_MODE: MigrationApprovalMode = 'none';

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
  /**
   * OWNER-DB-ULTIMATE Part B3: only an upgrade COMMAND failed; every migration applied and the post-checks passed (the schema
   * matches the code), so the API starts and /healthz reports upgradeFailed:true. Internal: api-prestart.sh serves on it.
   */
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
  /** DISABLE_DB_MIGRATIONS=true: this process never migrates. */
  disableDbMigrations: boolean;
  /** The EFFECTIVE value: CREWFLOW_MIGRATE_ON_START=true and DISABLE_DB_MIGRATIONS not true. */
  migrateOnStart: boolean;
  migrationApprovalMode: MigrationApprovalMode;
}

/** DISABLE_DB_MIGRATIONS (see the header): exactly true or false; unset or blank = false. */
export function readDisableDbMigrations(env: Env): boolean {
  const value = raw(env, DISABLE_DB_MIGRATIONS_VAR);
  return value !== undefined && oneOf(DISABLE_DB_MIGRATIONS_VAR, value, ['true', 'false'] as const) === 'true';
}

/**
 * CREWFLOW_MIGRATE_ON_START (see the header): the EFFECTIVE value. DISABLE_DB_MIGRATIONS=true overrides it (false) and lifts
 * the API's requirement; a value that is present is still validated.
 */
export function readMigrateOnStart(env: Env, options: ReadRuntimeDbConfigOptions = {}): boolean {
  const disabled = readDisableDbMigrations(env);
  const value = raw(env, MIGRATE_ON_START_VAR);
  if (value === undefined) {
    if (options.requireMigrateOnStart && !disabled) {
      throw new RuntimeDbConfigError(
        `${MIGRATE_ON_START_VAR} is required on the API service: set it to true (the API applies pending migrations on start, under the migration lock) or false (a release step runs them first). Refusing to start.`,
      );
    }
    return false;
  }
  return oneOf(MIGRATE_ON_START_VAR, value, ['true', 'false'] as const) === 'true' && !disabled;
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
    disableDbMigrations: readDisableDbMigrations(env),
    migrateOnStart: readMigrateOnStart(env, options),
    migrationApprovalMode: readMigrationApprovalMode(env, options),
  };
}

/**
 * DB-SETUP (plan §2.2 / §5.2, "database setup like Twenty"): the ONE login a runtime process may connect as is
 * owner-credential.ts OWNER_LOGIN (crewflow_owner). In a deployment, `PG_DATABASE_URL` in the container definition is the
 * database ADMIN URL; api-prestart.sh (after the bootstrap child) and worker-start.sh replace it with the derived
 * crewflow_owner URL before any runtime process starts. A crewflow_owner URL is passed through unchanged (owner decision D5),
 * so it is accepted here exactly as before.
 */
export type RuntimeLoginProcess = 'api' | 'worker' | 'migrate';

/**
 * Production for this rule, fail closed: NODE_ENV, RAB_RUNTIME_ENV or DB_TARGET says production (trimmed, any case). A
 * superset of pg-config.ts isPgProductionEnvironment and never-in-runtime-env.ts, so a half-declared or mis-cased production
 * never falls into the warning branch.
 */
function looksLikeProduction(env: Env): boolean {
  return ['NODE_ENV', 'RAB_RUNTIME_ENV', 'DB_TARGET'].some((name) => env[name]?.trim().toLowerCase() === 'production');
}

export interface RuntimeLoginCheck {
  /** Outside production only: a non-crewflow_owner login is allowed (dev and test suites use other logins) but reported. */
  warning: string | null;
}

/**
 * The runtime-login rule (plan §2.2): in production, a runtime process whose `PG_DATABASE_URL` login is anything other than
 * crewflow_owner is refused (RuntimeDbConfigError, exit 64) BEFORE any connection is opened. Pure: it parses the URL with the
 * same policy parser every connection uses (owner-credential.ts isOwnerLoginUrl -> pg-url-policy.ts parsePgUrl) and never connects, logs, or echoes a value (not
 * the URL, not the login). Outside production it returns a warning instead.
 *
 * Deliberately NOT part of readRuntimeDbConfig and NOT in api-prestart.sh's literal shell copy: the prestart shell and the
 * bootstrap child hold the ADMIN URL by design until the swap, and CLI commands validate their environment through
 * env.validation.ts. Callers: runtime-database-guard.ts resolveRuntimeDatabase (API and Worker, also run by
 * check-pending-migrations.ts) and the migrate child (twenty-migrate.ts). The superseded separate provisioner process is left
 * exactly as it was (it is unused; removed in the final clean-up PR).
 *
 * An absent PG_DATABASE_URL is not this rule's business (pg-config.ts refuses it in production with its own message). A
 * present but unparseable one is refused in production (fail closed) with the policy parser's value-free message.
 */
export function checkRuntimeLogin(env: Env, processName: RuntimeLoginProcess): RuntimeLoginCheck {
  // The factory's own reader (pg-config.ts): PG_DATABASE_URL, or outside production the deprecated DATABASE_URL; trimmed.
  const value = readPrimaryDatabaseUrl(env)?.value ?? '';
  if (value === '') return { warning: null };
  const production = looksLikeProduction(env);
  let owner: boolean;
  try {
    owner = isOwnerLoginUrl(value);
  } catch (error) {
    if (!(error instanceof OwnerCredentialError)) throw error;
    if (production) throw new RuntimeDbConfigError(`The ${processName} process: ${error.message}`);
    return { warning: null };
  }
  if (owner) return { warning: null };
  if (production) {
    throw new RuntimeDbConfigError(
      `The ${processName} process: PG_DATABASE_URL does not log in as ${OWNER_LOGIN}. In production a runtime process connects ONLY as ${OWNER_LOGIN}; this process was not started through api-prestart.sh / worker-start.sh, which replace the database admin URL with the derived ${OWNER_LOGIN} URL before any runtime process starts (login not shown). Refusing to start before connecting.`,
    );
  }
  return {
    warning: `The ${processName} process: PG_DATABASE_URL does not log in as ${OWNER_LOGIN} (login not shown). Allowed outside production only; production refuses it before connecting.`,
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
