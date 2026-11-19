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
 * checkRuntimeLogin is the runtime-login rule — in production the API, the Worker and the migrate child refuse a
 * PG_DATABASE_URL (or PG_DATABASE_SESSION_URL) whose login is not crewflow_owner BEFORE connecting. It
 * parses the URL with the policy parser (owner-credential.ts runtimeUrlFacts) but is still pure: no I/O, no connection, no
 * logging. It is a separate function on purpose: the prestart shell copy does not parse URLs, and the bootstrap child
 * legitimately holds the admin URL.
 */

import { readPrimaryDatabaseUrl, readSessionDatabaseUrl } from '../postgres/pg-config';
import { OWNER_LOGIN, OWNER_PASSWORD_MIN_DISTINCT, OWNER_PASSWORD_MIN_LENGTH, OwnerCredentialError, runtimeUrlFacts } from './owner-credential';

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
 * Every test seam refused outside NODE_ENV=test: Agent 1's migration seams, the server-path provisioning deferral seam
 * (modules/manager-workspace/services/workspace-provisioning-test-seam.ts; itself effective only with NODE_ENV=test AND a
 * database marked crewflow.disposable_test_database), and the Part C2 search_path trap
 * (engine/core-modules/tenant/business-tables.ts; it also refuses itself at the first tenant transaction outside NODE_ENV=test).
 */
export const TEST_SEAM_VARS = Object.freeze([
  ...MIGRATION_TEST_SEAM_VARS,
  'CREWFLOW_TEST_DEFER_SERVER_PROVISIONING',
  'CREWFLOW_TEST_SEARCH_PATH_TRAP',
] as const);

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
 * The runtime-login rule (owner decision 2026-11-18, Twenty's way): the API, the Worker and the migrate child read
 * PG_DATABASE_URL straight from their environment, and it is ALWAYS the crewflow_owner URL at a direct host (Twenty: server
 * and worker receive the app user's URL, helm/twenty/templates/deployment-server.yaml:148-155). Nothing in front of them
 * builds or rewrites it any more, so this rule (with the boot gates' role checks once connected) is what refuses a wrong
 * one.
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
  /** Outside production only: a non-crewflow_owner login is allowed (dev and test suites) but reported. */
  warning: string | null;
}

/**
 * In production, a runtime process whose PG_DATABASE_URL, or PG_DATABASE_SESSION_URL when set, logs in as anything other than
 * crewflow_owner (or carries a weak password) is refused (RuntimeDbConfigError, exit 64) BEFORE any connection is opened.
 * A transaction pooler is NOT recognised from the URL any more (owner instruction 2026-11-19, "decide by capability"): with
 * PG_DATABASE_SESSION_URL set, PG_DATABASE_URL may be a transaction pooler (pg-config.ts); without it, the live session probe
 * refuses a PG_DATABASE_URL that behaves like one (pg-session-probe.ts).
 * Pure: it parses the URL with the same policy parser every connection uses (owner-credential.ts runtimeUrlFacts ->
 * pg-url-policy.ts parsePgUrl) and never connects, logs, or echoes a value (not the URL, not the login, not the host).
 * Outside production it returns a warning instead. A superuser / BYPASSRLS / CREATEDB / REPLICATION / CREATEROLE login is
 * refused once connected, by the boot gates (database-boot-gate-rules.ts gate 1).
 *
 * Callers: runtime-database-guard.ts resolveRuntimeDatabase (API and Worker, also run by check-pending-migrations.ts) and
 * the migrate child (twenty-migrate.ts). An absent PG_DATABASE_URL is not this rule's business (pg-config.ts refuses it in
 * production with its own message). A present but unparseable one is refused in production (fail closed) with the policy
 * parser's value-free message.
 */
export function checkRuntimeLogin(env: Env, processName: RuntimeLoginProcess): RuntimeLoginCheck {
  // The factory's own reader (pg-config.ts): PG_DATABASE_URL, or outside production the deprecated DATABASE_URL; trimmed.
  const value = readPrimaryDatabaseUrl(env)?.value ?? '';
  if (value === '') return { warning: null };
  const production = looksLikeProduction(env);
  let facts: { owner: boolean; strongPassword: boolean };
  try {
    facts = runtimeUrlFacts(value);
  } catch (error) {
    if (!(error instanceof OwnerCredentialError)) throw error;
    if (production) throw new RuntimeDbConfigError(`The ${processName} process: ${error.message}`);
    return { warning: null };
  }
  if (!facts.owner) {
    if (production) {
      throw new RuntimeDbConfigError(
        `The ${processName} process: PG_DATABASE_URL does not log in as ${OWNER_LOGIN}. In production a runtime process connects ONLY as ${OWNER_LOGIN}: PG_DATABASE_URL is always the ${OWNER_LOGIN} URL (an admin URL belongs only to db-setup, in PG_ADMIN_URL). Login not shown. Refusing to start before connecting.`,
      );
    }
    return {
      warning: `The ${processName} process: PG_DATABASE_URL does not log in as ${OWNER_LOGIN} (login not shown). Allowed outside production only; production refuses it before connecting.`,
    };
  }
  // PG_DATABASE_SESSION_URL (the direct session connection next to a transaction-pooled PG_DATABASE_URL): the same login
  // rule. Its login and database must also equal PG_DATABASE_URL's (pg-config.ts refuses otherwise).
  const session = readSessionDatabaseUrl(env)?.value ?? '';
  if (session !== '') {
    let sessionFacts: { owner: boolean; strongPassword: boolean };
    try {
      sessionFacts = runtimeUrlFacts(session);
    } catch (error) {
      if (!(error instanceof OwnerCredentialError)) throw error;
      if (production) throw new RuntimeDbConfigError(`The ${processName} process: ${error.message.split('PG_DATABASE_URL').join('PG_DATABASE_SESSION_URL')}`);
      return { warning: null };
    }
    if (production && (!sessionFacts.owner || !sessionFacts.strongPassword)) {
      throw new RuntimeDbConfigError(
        `The ${processName} process: PG_DATABASE_SESSION_URL must log in as ${OWNER_LOGIN} with a strong password, exactly like PG_DATABASE_URL (the same login and database; only the host and port differ). Value not shown. Refusing to start before connecting.`,
      );
    }
  }
  // Re-review (info): the M2 floor at the runtime too, so a weak mode-c password is refused even when a platform starts the
  // API before db-setup (OpenShip ignores depends_on conditions). Production only: test and development databases use short ones.
  if (production && !facts.strongPassword) {
    throw new RuntimeDbConfigError(
      `The ${processName} process: the crewflow_owner password inside PG_DATABASE_URL is too weak for production (at least ${OWNER_PASSWORD_MIN_LENGTH} characters with at least ${OWNER_PASSWORD_MIN_DISTINCT} different characters; openssl rand -hex 32). Value not shown. Refusing to start before connecting.`,
    );
  }
  return { warning: null };
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
