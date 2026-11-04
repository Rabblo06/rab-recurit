/**
 * Owner-login architecture (PR 3): the short-lived migrate-on-start CHILD. The API entrypoint (api-prestart.sh, Agent 2)
 * runs it only when CREWFLOW_MIGRATE_ON_START=true, waits for it, and execs the server only on exit 0 or 70. It reuses the
 * locked runner unchanged in shape (one session, the migration lock, every gate after the lock) and adds:
 *
 *   - the target-guard environment, synthesised IN THIS PROCESS'S MEMORY ONLY (the runtime environment must not carry
 *     DB_TARGET / ALLOW_PRODUCTION_DB_COMMANDS / the identity bootstrap flag; env validation refuses them): production when
 *     CREWFLOW_DEPLOYMENT_ENVIRONMENT=production, else local. SECURITY TRADE-OFF ST-3 (M0 §9): whoever sets the API's
 *     environment can migrate production; mitigation CREWFLOW_MIGRATION_APPROVAL_MODE=token and migrate-on-start off in
 *     production (release step).
 *   - D6: an unbound production database (absent or unbound marker) is bound on its FIRST, fresh install only; the bootstrap
 *     flag and PG_EXPECTED_DATABASE_NAME are synthesised for that run, re-derived after the lock (another replica may have
 *     bound it meanwhile). CREWFLOW_DEPLOYMENT_ID is optional on that first install (generated and logged once) and
 *     MANDATORY as soon as a marker is bound.
 *   - client_connection_check_interval = 1 s and a SIGTERM self-cancel (main entry), so a killed child never keeps the lock
 *     for the length of a statement (M0-C, VERIFIED: up to 900 s otherwise).
 *   - after the chain: auto-bind (fresh install only), then deploy-post-checks on EVERY start (C-2), with an AHEAD ledger's
 *     provision-function-ahead / workspace-ahead findings as warnings (C-1: the image rollback stays healthy).
 *   - on failure: upgrade-failure-policy.ts decides, on a fresh session of the same login, whether the API may serve
 *     degraded (exit 70, logged as a FAILURE) — never after a first-install failure.
 *
 * One machine-readable line on stdout at the end, never a secret:
 *   TWENTY_MIGRATE_RESULT {"state","applied","pending","failedMigration","exitCode","serve","policy","reason","checks"}
 * (the prefix name is the interface agreed with Agent 2 before the owner-login rename; it is kept for compatibility.)
 *
 * This module has no side effects on import. The process entry is migrate-on-start.main.ts (it reads Agent 2's
 * runtime-db-config.ts and maps outcomes to STARTUP_EXIT_CODES).
 */
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createPgClient } from '../../../../postgres';
import {
  bindDeploymentIdentityInTransaction,
  canonicalConfirmHost,
} from '../../../../deployment-identity/bind-deployment-identity';
import {
  assertDeploymentIdentity,
  DEPLOYMENT_ENVIRONMENT_VAR,
  DEPLOYMENT_ID_VAR,
  DeploymentEnvironment,
  EXPECTED_DATABASE_NAME_VAR,
  IDENTITY_BOOTSTRAP_VALUE,
  IDENTITY_BOOTSTRAP_VAR,
  isDeploymentEnvironment,
  readDeploymentMarker,
} from '../../../../deployment-identity/deployment-identity';
import { deployPostCheckProblems } from '../deploy-post-checks';
import { GuardedTarget, Query, runLockedMigrations } from '../locked-migration-runner';
import { assertMigrationApproval, readMigrationApproval } from '../migration-approval';
import { resolveMigrationConnection } from '../migration-database-url';
import { Classification, classifyDatabaseState, FreshInstallProof, readFreshInstallProof } from './fresh-install';
import { assessUpgradeFailure, UpgradeCheck, UpgradeFailurePolicy } from './upgrade-failure-policy';

export const RESULT_LINE_PREFIX = 'TWENTY_MIGRATE_RESULT';

/** Test seams (Agent 5's harness). Honoured only with NODE_ENV=test on a disposable test database outside production. */
export const TEST_FAIL_AT_VAR = 'CREWFLOW_MIGRATION_TEST_FAIL_AT';
export const TEST_STOP_BEFORE_VAR = 'CREWFLOW_MIGRATION_TEST_STOP_BEFORE';

export class TestSeamRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestSeamRefusal';
  }
}

export interface TestSeams {
  failAt: string | null;
  stopBefore: number | null;
}

/**
 * Pure: the test seams of this run. Any seam set outside (NODE_ENV=test AND a database carrying the server-side
 * crewflow.disposable_test_database setting AND a non-production target) is a configuration refusal (exit 64), never a
 * silent no-op. FAIL_AT names one migration (class name); STOP_BEFORE is a 13-digit timestamp: the run loads only the
 * migrations before it (a database "behind head" for the pending scenarios).
 */
export function readTestSeams(env: Record<string, string | undefined>, ctx: { production: boolean; disposableTestDatabase: boolean }): TestSeams {
  const failAt = env[TEST_FAIL_AT_VAR]?.trim() || null;
  const stopRaw = env[TEST_STOP_BEFORE_VAR]?.trim() || null;
  if (!failAt && !stopRaw) return { failAt: null, stopBefore: null };
  if (env.NODE_ENV !== 'test' || ctx.production || !ctx.disposableTestDatabase) {
    throw new TestSeamRefusal(`${TEST_FAIL_AT_VAR} / ${TEST_STOP_BEFORE_VAR} are test seams: only NODE_ENV=test on a disposable test database, never production. Refusing.`);
  }
  if (failAt !== null && !/^[A-Za-z][A-Za-z0-9]*\d{13}$/.test(failAt)) throw new TestSeamRefusal(`${TEST_FAIL_AT_VAR} must be a migration class name. Refusing.`);
  if (stopRaw !== null && !/^\d{13}$/.test(stopRaw)) throw new TestSeamRefusal(`${TEST_STOP_BEFORE_VAR} must be a 13-digit migration timestamp. Refusing.`);
  return { failAt, stopBefore: stopRaw === null ? null : Number(stopRaw) };
}

const CORE_MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'core', 'migrations');
/** The code's migration class names, from the migration file names (`<13 digits>-<Name>.ts|js` holds class `<Name><13 digits>`). */
export function codeMigrationNames(dir: string = CORE_MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^[0-9]{13}-[^.]+[.](ts|js)$/.test(f))
    .sort()
    .map((f) => `${f.slice(14).replace(/[.](ts|js)$/, '')}${f.slice(0, 13)}`);
}
function migrationFilesBefore(stopBefore: number): string[] {
  return readdirSync(CORE_MIGRATIONS_DIR)
    .filter((f) => /^\d{13}-[^.]+\.(ts|js)$/.test(f) && Number(f.slice(0, 13)) < stopBefore)
    .map((f) => join(CORE_MIGRATIONS_DIR, f));
}

export type StartupOutcome = 'ok' | 'config' | 'behind' | 'migrationFailed' | 'identity' | 'postCheck' | 'lockTimeout' | 'degradedContinue';

export interface MigrateOnStartConfig {
  migrationApprovalMode: 'none' | 'token';
  upgradeFailurePolicy: UpgradeFailurePolicy;
}

export interface MigrateOnStartResult {
  state: Classification['state'] | 'UNKNOWN';
  applied: string[];
  pending: string[];
  failedMigration: string | null;
  outcome: StartupOutcome;
  serve: boolean;
  policy: UpgradeFailurePolicy;
  reason: string;
  checks: UpgradeCheck[];
}

export class PostCheckFailure extends Error {
  constructor(readonly problems: string[]) {
    super(`post-migration checks failed (${problems.length}): ${problems.slice(0, 20).join('; ')}`);
    this.name = 'PostCheckFailure';
  }
}

/** Error → outcome, by error name (the classes live in many modules; a name never carries a value). Unknown = migration failure. */
export function outcomeOf(error: unknown): StartupOutcome {
  const name = error instanceof Error ? error.name : '';
  if (['RuntimeDbConfigError', 'UnsupportedPostgresVersionError', 'MigrationDatabaseUrlError', 'PgConfigError', 'TestSeamRefusal'].includes(name)) return 'config';
  if (name === 'MigrationLockError') return 'lockTimeout';
  if (
    ['MigrationIdentityError', 'OwnerLoginIdentityError', 'DbTargetError', 'DeploymentIdentityError', 'BindIdentityError', 'DatabaseStateError', 'BootstrapRefusal'].includes(name)
  ) {
    return 'identity';
  }
  if (['UnapprovedProductionMigrationError', 'MigrationApprovalError'].includes(name)) return 'behind';
  if (error instanceof Error && /needs the per-release approval|not a proven fresh install/.test(error.message)) return 'behind';
  if (name === 'PostCheckFailure') return 'postCheck';
  return 'migrationFailed';
}

const AHEAD_TOLERATED = /^schema-compatibility (provision-function-ahead|workspace-ahead):/;

/** Pure: the post-check problems that fail this start (AHEAD: the newer-code findings are warnings, C-1). */
export function blockingPostCheckProblems(state: Classification['state'] | 'UNKNOWN', problems: readonly string[]): { blocking: string[]; warnings: string[] } {
  if (state !== 'AHEAD') return { blocking: [...problems], warnings: [] };
  return { blocking: problems.filter((p) => !AHEAD_TOLERATED.test(p)), warnings: problems.filter((p) => AHEAD_TOLERATED.test(p)) };
}

export type MarkerState = 'absent' | 'unbound' | 'bound';

/**
 * Pure: the target-guard environment of this run (never written to process.env). `marker` is the marker state read on
 * this database; `generatedId` is the id to use when production has none declared on a fresh install.
 */
export function synthesiseGuardEnv(
  env: Record<string, string | undefined>,
  marker: MarkerState,
  database: string,
  generatedId: string,
): { guardEnv: Record<string, string | undefined>; generatedDeploymentId: string | null } {
  const production = env[DEPLOYMENT_ENVIRONMENT_VAR]?.trim() === 'production';
  const guardEnv: Record<string, string | undefined> = { ...env, DB_TARGET: production ? 'production' : 'local' };
  delete guardEnv.ALLOW_PRODUCTION_DB_COMMANDS;
  delete guardEnv[IDENTITY_BOOTSTRAP_VAR];
  if (!production) return { guardEnv, generatedDeploymentId: null };
  guardEnv.ALLOW_PRODUCTION_DB_COMMANDS = 'true';
  let generatedDeploymentId: string | null = null;
  if (marker !== 'bound') {
    guardEnv[IDENTITY_BOOTSTRAP_VAR] = IDENTITY_BOOTSTRAP_VALUE;
    if (!guardEnv[EXPECTED_DATABASE_NAME_VAR]?.trim()) guardEnv[EXPECTED_DATABASE_NAME_VAR] = database;
    if (!guardEnv[DEPLOYMENT_ID_VAR]?.trim()) {
      guardEnv[DEPLOYMENT_ID_VAR] = generatedId;
      generatedDeploymentId = generatedId;
    }
  }
  return { guardEnv, generatedDeploymentId };
}

export interface MigrateOnStartDeps {
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  runner?: typeof runLockedMigrations;
  /** Agent 3's posture / drift monitor, when it exists (upgrade-failure-policy.ts). */
  postureCheck?: (query: Query) => Promise<string[]>;
  /** Receives the migration session pid (the main entry's SIGTERM self-cancel). */
  onSession?: (pid: number) => void;
}

async function withLoginClient<T>(env: Record<string, string | undefined>, fn: (query: Query) => Promise<T>): Promise<T> {
  const connection = resolveMigrationConnection(env);
  const client = createPgClient(connection.resolved, { endpoint: connection.endpoint, purpose: 'probe', sessionAffinity: true, statementTimeoutMs: 30_000, queryTimeoutMs: 35_000 });
  await client.connect();
  try {
    return await fn(async (sql, params) => (await client.query(sql, params as unknown[])).rows);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function readMarkerState(env: Record<string, string | undefined>): Promise<{ marker: MarkerState; database: string; disposableTestDatabase: boolean }> {
  return withLoginClient(env, async (query) => {
    const { marker, database, disposableTestDatabase } = await readDeploymentMarker(query as never);
    return { marker: marker.state, database, disposableTestDatabase };
  });
}

/**
 * M0-C (VERIFIED on PG16): a killed migrator keeps the lock until its running statement ends (up to 900 s). On SIGTERM the
 * child cancels its own migration statement through a second connection of the SAME login (pg_cancel_backend is allowed
 * on one's own backends), so the transaction rolls back and the session's lock is released at once; then it exits 143.
 * client_connection_check_interval = 1 s (set on the session) covers SIGKILL. Returns the uninstaller.
 */
export function installSigtermSelfCancel(
  env: Record<string, string | undefined>,
  getPid: () => number | null,
  log: (line: string) => void,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let handling = false;
  const handler = () => {
    if (handling) return;
    handling = true;
    const pid = getPid();
    log(`SIGTERM: ${pid ? `cancelling the migration statement of backend ${pid}` : 'no migration session yet'}; exiting`);
    const done = () => exit(143);
    if (!pid) return done();
    withLoginClient(env, (query) => query('SELECT pg_catalog.pg_cancel_backend($1)', [pid]))
      .catch(() => undefined)
      .finally(done);
  };
  process.on('SIGTERM', handler);
  return () => process.off('SIGTERM', handler);
}

export async function runMigrateOnStart(config: MigrateOnStartConfig, deps: MigrateOnStartDeps = {}): Promise<MigrateOnStartResult> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(`[migrate-on-start] ${line}`)); // eslint-disable-line no-console
  const runner = deps.runner ?? runLockedMigrations;
  const generatedId = randomUUID();
  let classification: Classification | null = null;
  let proof: FreshInstallProof | null = null;
  let applied: string[] = [];
  let production = false;
  let guardEnvUsed: Record<string, string | undefined> = env;
  const result = (outcome: StartupOutcome, extra: Partial<MigrateOnStartResult> = {}): MigrateOnStartResult => ({
    state: classification?.state ?? 'UNKNOWN',
    applied,
    pending: [],
    failedMigration: null,
    outcome,
    serve: outcome === 'ok',
    policy: config.upgradeFailurePolicy,
    reason: outcome === 'ok' ? 'schema current' : outcome,
    checks: [],
    ...extra,
  });

  try {
    const pre = await readMarkerState(env);
    const first = synthesiseGuardEnv(env, pre.marker, pre.database, generatedId);
    guardEnvUsed = first.guardEnv;
    production = first.guardEnv.DB_TARGET === 'production';
    const approval = config.migrationApprovalMode === 'token' ? readMigrationApproval(env) : null;
    const seams = readTestSeams(env, { production, disposableTestDatabase: pre.disposableTestDatabase });
    if (seams.failAt || seams.stopBefore) log(`TEST SEAMS ACTIVE: failAt=${seams.failAt ?? '-'} stopBefore=${seams.stopBefore ?? '-'}`);

    const run = await runner({
      label: 'migrate-on-start',
      env: first.guardEnv,
      log,
      mode: 'apply',
      approvalMode: config.migrationApprovalMode,
      requireOwnerLogin: true,
      connectionCheckIntervalSeconds: 1,
      onSession: deps.onSession,
      testFailAt: seams.failAt,
      ...(seams.stopBefore ? { dataSourceOverrides: { migrations: migrationFilesBefore(seams.stopBefore) } } : {}),
      refreshGuardEnv: async () => {
        const now = await readMarkerState(env);
        const again = synthesiseGuardEnv(env, now.marker, now.database, generatedId);
        guardEnvUsed = again.guardEnv;
        return again.guardEnv;
      },
      onClassified: (c, p) => {
        classification = c;
        proof = p;
      },
      approvePending: approval === null ? undefined : (pending) => assertMigrationApproval(approval, pending),
      afterMigrations: async ({ queryRunner, applied: done, guarded }) => {
        applied = done;
        const query: Query = (sql, parameters) => queryRunner.query(sql, parameters) as Promise<unknown[]>;
        await autoBindFreshInstall({ query, env, guardEnv: guardEnvUsed, guarded, classification, proof, log });
        const problems = await deployPostCheckProblems(query);
        const { blocking, warnings } = blockingPostCheckProblems(classification?.state ?? 'UNKNOWN', problems);
        for (const w of warnings) log(`WARNING (ledger ahead, C-1): ${w}`);
        if (blocking.length) throw new PostCheckFailure(blocking);
        log(`post-checks passed (${done.length} applied)`);
      },
    });
    applied = run.applied;
    const state = (classification as Classification | null)?.state ?? 'UNKNOWN';
    if (state === 'AHEAD') log('WARNING: the ledger is AHEAD of this image (rollback). Nothing applied; serving with the newer schema (expand-only releases only).');
    return result('ok', { reason: state === 'AHEAD' ? 'ledger ahead of the code (image rollback): warned, not refused (C-1)' : `schema current (${applied.length} applied)` });
  } catch (error) {
    const outcome = outcomeOf(error);
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    log(`FAILED (${outcome}): ${message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`);
    let c = classification as Classification | null;
    let p = proof as FreshInstallProof | null;
    const code = codeMigrationNames();
    if (c === null) {
      // The run failed before it classified (e.g. a lock timeout): classify now, read-only, on a fresh session. Unknown
      // stays "first install" (never serves).
      try {
        await withLoginClient(env, async (query) => {
          c = await classifyDatabaseState(query, code);
          p = await readFreshInstallProof(query, c.state);
        });
      } catch {
        c = null;
      }
    }
    const freshInstall = c === null || c.state === 'EMPTY' || c.state === 'BOOTSTRAP-PARTIAL' || p?.fresh === true;
    if (c !== null) classification = c;
    let pending: string[] = [];
    let failedMigration: string | null = null;
    try {
      pending = await withLoginClient(env, async (query) => {
        const [{ has }] = (await query(`SELECT to_regclass('core.migrations') IS NOT NULL AS "has"`)) as Array<{ has: boolean }>;
        const done = new Set(has ? ((await query('SELECT name FROM core.migrations')) as Array<{ name: string }>).map((r) => r.name) : []);
        return code.filter((n) => !done.has(n));
      });
      if (outcome === 'migrationFailed' && pending.length) failedMigration = pending[0]!;
    } catch {
      // Unreadable after the failure: keep the failure, report nothing as pending-known.
    }
    if (outcome === 'config' || outcome === 'identity' || outcome === 'behind') {
      // Never a candidate for continue-if-compatible: the configuration, the identity or the approval is wrong.
      return result(outcome, { pending, failedMigration, serve: false, reason: message.slice(0, 300) });
    }
    const verdict = await withLoginClient(env, (query) =>
      assessUpgradeFailure({
        policy: config.upgradeFailurePolicy,
        freshInstall,
        failedMigration,
        expectedMigrations: code,
        query,
        production,
        deploymentIdentityCheck: async (q) => {
          try {
            const host = canonicalConfirmHost(resolveMigrationConnection(env).resolved.primary.target.host);
            await assertDeploymentIdentity(q as never, { processLabel: 'api process', production, env, connectionHost: host });
            return null;
          } catch (e) {
            return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : 'deployment identity check failed';
          }
        },
        postureCheck: deps.postureCheck,
      }),
    ).catch((e: unknown) => ({
      serve: false,
      policy: config.upgradeFailurePolicy,
      reason: `the assessment could not run (${e instanceof Error ? e.name : 'error'}): fail closed`,
      checks: [] as UpgradeCheck[],
    }));
    for (const check of verdict.checks) log(`  check ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
    if (verdict.serve) {
      log(`*** UPGRADE FAILED (${outcome}) — continue-if-compatible passed every check: the API will serve DEGRADED (exit 70). This is NOT a success. ***`);
      return result('degradedContinue', { pending, failedMigration, serve: true, reason: verdict.reason, checks: verdict.checks });
    }
    return result(outcome, { pending, failedMigration, serve: false, reason: `${message.slice(0, 200)} | ${verdict.reason}`, checks: verdict.checks });
  }
}

/**
 * D6 / owner rule "auto-bind only on an EMPTY or fresh-install database": binds the deployment identity marker inside the
 * locked run, after the marker migration, when (and only when) this run started on a fresh install and the marker is
 * still unbound. A non-production install binds only when CREWFLOW_DEPLOYMENT_ENVIRONMENT is declared.
 */
async function autoBindFreshInstall(input: {
  query: Query;
  env: Record<string, string | undefined>;
  guardEnv: Record<string, string | undefined>;
  guarded: GuardedTarget | undefined;
  classification: Classification | null;
  proof: FreshInstallProof | null;
  log: (line: string) => void;
}): Promise<void> {
  const { query, guardEnv, guarded, classification, proof, log } = input;
  const fresh = classification !== null && (classification.state === 'EMPTY' || classification.state === 'BOOTSTRAP-PARTIAL' || proof?.fresh === true);
  const q = query as unknown as (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  const { marker, database } = await readDeploymentMarker(q);
  if (marker.state !== 'unbound') return;
  if (!fresh) {
    log('deployment identity marker is unbound on an existing database: NOT auto-bound (fresh install only); bind it with db:bind-identity');
    return;
  }
  const environment = guardEnv[DEPLOYMENT_ENVIRONMENT_VAR]?.trim();
  if (!environment) {
    log('fresh install without CREWFLOW_DEPLOYMENT_ENVIRONMENT: the marker stays unbound (non-production)');
    return;
  }
  if (!isDeploymentEnvironment(environment)) throw new Error(`${DEPLOYMENT_ENVIRONMENT_VAR} is not a deployment environment. Refusing.`);
  const deploymentId = guardEnv[DEPLOYMENT_ID_VAR]?.trim().toLowerCase();
  if (!deploymentId) {
    log('fresh install without CREWFLOW_DEPLOYMENT_ID: the marker stays unbound (non-production)');
    return;
  }
  const host = canonicalConfirmHost(guarded?.app.host ?? '');
  const production = guarded?.target === 'production';
  await bindDeploymentIdentityInTransaction(q, {
    args: {
      environment: environment as DeploymentEnvironment,
      deploymentId,
      reason: 'automatic first bind of a fresh install by the migrate-on-start child (owner login)',
      actor: 'crewflow migrate-on-start',
      confirmDatabase: database,
      confirmHosts: [host],
      confirmCurrentDeploymentId: null,
    },
    target: {
      target: guarded?.target ?? 'local',
      declared: { environment: environment as DeploymentEnvironment, deploymentId },
      bootstrapRequested: production && guardEnv[IDENTITY_BOOTSTRAP_VAR] === IDENTITY_BOOTSTRAP_VALUE,
    },
    host,
    log,
  });
  if (guardEnv[DEPLOYMENT_ID_VAR] && !input.env[DEPLOYMENT_ID_VAR]?.trim()) {
    log(
      `*** FIRST BIND: this database is now bound to ${environment}/${deploymentId}. Set CREWFLOW_DEPLOYMENT_ID=${deploymentId} on every process ` +
        'of this deployment NOW: it is mandatory from the next start on. ***',
    );
  }
}
