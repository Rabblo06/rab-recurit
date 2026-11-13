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
 *   - D6: an unbound production database (absent or unbound marker) is bound on its FIRST, fresh install only, and only when
 *     CREWFLOW_DEPLOYMENT_ENVIRONMENT=production is declared; the bootstrap flag and PG_EXPECTED_DATABASE_NAME are
 *     synthesised for that run, re-derived after the lock (another replica may have bound it meanwhile). With the
 *     environment declared, CREWFLOW_DEPLOYMENT_ID may be omitted on that first install (generated and logged once).
 *   - BC-11 (owner decision 2026-11-05): the identity is OPTIONAL everywhere, production included. Undeclared: no marker
 *     check (a loud warning every start), no bootstrap, no auto-bind. Declared: the exact match against a bound marker.
 *   - client_connection_check_interval = 1 s and a SIGTERM self-cancel (main entry), so a killed child never keeps the lock
 *     for the length of a statement (M0-C, VERIFIED: up to 900 s otherwise).
 *   - after the chain: auto-bind (fresh install only), then deploy-post-checks on EVERY start (C-2), with an AHEAD ledger's
 *     provision-function-ahead / workspace-ahead findings as warnings (C-1: the image rollback stays healthy).
 *   - Phase X U-1 (SU-04, owner decision P1-5 2026-11-11): after a run that APPLIED at least one migration and whose
 *     post-checks passed, with the lock still held, the allow-listed `entitycache` epoch bump (cache-flush.ts /
 *     entity-cache-flush.ts: one INCR per cached entity, deletes nothing, touches no other key family: never bull:*,
 *     throttler keys or rab:* heartbeats). WARNING ONLY: a missing REDIS_URL, an unreachable Redis or a failed bump is
 *     logged and the start continues (cached entries then expire on their own TTL, at most 300 s).
 *   - on failure: refuse (OWNER-DB-ULTIMATE Part B3; the C3 CREWFLOW_UPGRADE_FAILURE choices are removed): a failed
 *     migration exits 66 and the next start retries it (the upgrade logbook records attempt N); configuration (64), the
 *     version check / approval (65), identity (67), post-check (68) and lock timeout (69) likewise never serve. Only a failed
 *     upgrade COMMAND, with every migration applied and the post-checks passed, serves (exit 70, upgrade:"failed").
 *
 * One machine-readable line on stdout at the end, never a secret:
 *   TWENTY_MIGRATE_RESULT {"state","applied","pending","failedMigration","exitCode","serve","reason","checks","upgrade"}
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
  DEPLOYMENT_ENVIRONMENT_VAR,
  DEPLOYMENT_ID_VAR,
  DeploymentEnvironment,
  EXPECTED_DATABASE_NAME_VAR,
  IDENTITY_BOOTSTRAP_VALUE,
  IDENTITY_BOOTSTRAP_VAR,
  isDeploymentEnvironment,
  readDeploymentMarker,
} from '../../../../deployment-identity/deployment-identity';
import { isProductionProcess } from '../../../../boot-checks/database-boot-gate-rules';
import { deployPostCheckProblems } from '../deploy-post-checks';
import { GuardedTarget, Query, runLockedMigrations } from '../locked-migration-runner';
import { assertMigrationApproval, readMigrationApproval } from '../migration-approval';
import { resolveMigrationConnection } from '../migration-database-url';
import { Classification, classifyDatabaseState, FreshInstallProof } from './fresh-install';
import { runCacheFlush } from '../../cache-flush';
import { UpgradeRun, UpgradeRunReport } from '../../../../../engine/core-modules/upgrade/upgrade-runner';
import { UPGRADE_COMMANDS } from '../../../../../engine/core-modules/upgrade/upgrade-commands/registry';
import type { UpgradeCommand } from '../../../../../engine/core-modules/upgrade/upgrade-commands/upgrade-command';
import { majorMinorKey, readAppVersion } from '../../../../../engine/core-modules/upgrade/upgrade-version';
import { attributeLedger } from './release-floor';

export const RESULT_LINE_PREFIX = 'TWENTY_MIGRATE_RESULT';

/** Test seams (Agent 5's harness). Honoured only with NODE_ENV=test on a disposable test database outside production. */
export const TEST_FAIL_AT_VAR = 'CREWFLOW_MIGRATION_TEST_FAIL_AT';
export const TEST_STOP_BEFORE_VAR = 'CREWFLOW_MIGRATION_TEST_STOP_BEFORE';
/**
 * OWNER-DB-ULTIMATE Part B test seams (same gate as the other seams; the CREWFLOW_TEST_* prefix is also refused by the
 * compose / env lint): extra no-op probe upgrade commands for the code version (comma-separated class-like names), and
 * the one command that fails.
 */
export const TEST_UPGRADE_COMMANDS_VAR = 'CREWFLOW_TEST_UPGRADE_COMMANDS';
export const TEST_FAIL_COMMAND_VAR = 'CREWFLOW_TEST_UPGRADE_FAIL_COMMAND';

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
}

export interface MigrateOnStartResult {
  state: Classification['state'] | 'UNKNOWN';
  applied: string[];
  pending: string[];
  failedMigration: string | null;
  outcome: StartupOutcome;
  serve: boolean;
  reason: string;
  /** Kept for the result-line shape (always empty since the C3 assessment was removed). */
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  /** OWNER-DB-ULTIMATE Part B: the upgrade logbook's view of this run (null when the run stopped before the check). */
  upgrade?: UpgradeRunReport | null;
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
  if (['RuntimeDbConfigError', 'UnsupportedPostgresVersionError', 'MigrationDatabaseUrlError', 'PgConfigError', 'TestSeamRefusal', 'AppVersionError'].includes(name)) return 'config';
  if (name === 'MigrationLockError') return 'lockTimeout';
  if (
    ['MigrationIdentityError', 'OwnerLoginIdentityError', 'DbTargetError', 'DeploymentIdentityError', 'BindIdentityError', 'DatabaseStateError', 'BootstrapRefusal'].includes(name)
  ) {
    return 'identity';
  }
  if (name === 'MigrationSessionDatabaseError') return 'identity';
  if (['UnapprovedProductionMigrationError', 'MigrationApprovalError', 'UnsupportedUpgradeStartError', 'UpgradeVersionTooOldError'].includes(name)) return 'behind';
  if (error instanceof Error && /needs the per-release approval|not a proven fresh install|APPROVAL_MODE=token needs/.test(error.message)) return 'behind';
  if (['PostCheckFailure', 'MigrationsStillPendingError'].includes(name)) return 'postCheck';
  return 'migrationFailed';
}

const AHEAD_TOLERATED = /^schema-compatibility (provision-function-ahead|workspace-ahead):/;

/** Pure: the post-check problems that fail this start (AHEAD: the newer-code findings are warnings, C-1). */
export function blockingPostCheckProblems(state: Classification['state'] | 'UNKNOWN', problems: readonly string[]): { blocking: string[]; warnings: string[] } {
  if (state !== 'AHEAD') return { blocking: [...problems], warnings: [] };
  return { blocking: problems.filter((p) => !AHEAD_TOLERATED.test(p)), warnings: problems.filter((p) => AHEAD_TOLERATED.test(p)) };
}

/**
 * Agent 2 (O3): DISABLE_DB_MIGRATIONS=true means "this process never migrates" (api-prestart.sh then never starts the child).
 * The child run directly with it refuses (exit 64, configuration) instead of migrating against the operator's setting. Pure.
 */
export function migrateChildConfigRefusal(config: object): string | null {
  // `object`: the parsed RuntimeDbConfig (Agent 2 adds `disableDbMigrations` to it on o3/app-startup).
  return (config as { disableDbMigrations?: unknown }).disableDbMigrations === true
    ? 'DISABLE_DB_MIGRATIONS=true: this deployment does not migrate on start, so the migrate child refuses to run. Unset it (or set CREWFLOW_MIGRATE_ON_START=true without it) to let the API apply migrations, or run the release migration step. Refusing.'
    : null;
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
  // Owner decision BC-11 (2026-11-05): the declaration is optional in production, so it can no longer be what makes this
  // run a production one. Production = the API's own runtime classification (isProductionProcess('api'), exactly the rule
  // its boot gate applies) OR a declared production identity. An undeclared production run therefore keeps DB_TARGET=
  // production (N1, TLS, the production refusals) instead of falling back to local.
  const declaredProduction = env[DEPLOYMENT_ENVIRONMENT_VAR]?.trim() === 'production';
  const production = declaredProduction || isProductionProcess('api', env);
  const guardEnv: Record<string, string | undefined> = { ...env, DB_TARGET: production ? 'production' : 'local' };
  delete guardEnv.ALLOW_PRODUCTION_DB_COMMANDS;
  delete guardEnv[IDENTITY_BOOTSTRAP_VAR];
  if (!production) {
    // Agent 5 finding (MEDIUM): outside production a declared identity on a database WITHOUT a bound marker was refused by
    // the target guard ("declares test/<id>, but the database has no deployment identity marker") before anything ran, so a
    // fresh non-production install could never reach its own auto-bind (D6). The guard sees the declaration only once the
    // marker is bound; until then it judges the database as undeclared (exactly as a run without the variables; a remote
    // unmarked host stays refused by H-1), and the auto-bind binds the ORIGINAL declaration, fresh install only. Production
    // is unchanged: it keeps its declaration and the one-time bootstrap rules below.
    if (marker !== 'bound') {
      delete guardEnv[DEPLOYMENT_ENVIRONMENT_VAR];
      delete guardEnv[DEPLOYMENT_ID_VAR];
    }
    return { guardEnv, generatedDeploymentId: null };
  }
  guardEnv.ALLOW_PRODUCTION_DB_COMMANDS = 'true';
  let generatedDeploymentId: string | null = null;
  // BC-11: the first-install bootstrap and auto-bind happen only when the identity is DECLARED; an undeclared production
  // install leaves the marker unbound (no bootstrap flag, no generated id) and the guard warns instead of checking.
  if (marker !== 'bound' && declaredProduction) {
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
  /** Receives the migration session pid (the main entry's SIGTERM self-cancel). */
  onSession?: (pid: number) => void;
  /** Test seam: the allow-listed entity-cache epoch bump (default: cache-flush.ts runCacheFlush). */
  cacheFlush?: (namespace: string, env: Record<string, string | undefined>) => Promise<void>;
  /**
   * OWNER-DB-ULTIMATE Part B3: set ONLY by the manual `upgrade --force` command (command/upgrade.command.ts). The automatic
   * start path (twenty-migrate.ts) never passes it, and no environment variable maps to it. Skips only the previous-version
   * check; every logbook row of the run records forced = true.
   */
  upgradeForce?: true;
}

/** How long the warning-only epoch bump may hold up the start (the migration lock is still held). */
export const ENTITY_CACHE_BUMP_TIMEOUT_MS = 15_000;

/**
 * SU-04 (owner decision P1-5): the allow-listed `entitycache` epoch bump after an applying run. Never throws: every failure
 * is a WARNING and the start continues. Returns what happened (for the log and the specs).
 */
export async function bumpEntityCacheAfterUpgrade(input: {
  applied: readonly string[];
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  flush?: (namespace: string, env: Record<string, string | undefined>) => Promise<void>;
  timeoutMs?: number;
}): Promise<'skipped-nothing-applied' | 'skipped-no-redis' | 'bumped' | 'warning'> {
  if (input.applied.length === 0) return 'skipped-nothing-applied';
  if (!input.env.REDIS_URL?.trim()) {
    input.log('WARNING: REDIS_URL is not set: the entity-cache epoch was NOT bumped after the upgrade (cached entries expire within 300 s)');
    return 'skipped-no-redis';
  }
  const flush = input.flush ?? runCacheFlush;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      flush('entitycache', input.env),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`timed out after ${input.timeoutMs ?? ENTITY_CACHE_BUMP_TIMEOUT_MS} ms`), { name: 'Timeout' })), input.timeoutMs ?? ENTITY_CACHE_BUMP_TIMEOUT_MS);
      }),
    ]);
    input.log(`entity-cache epoch bumped after ${input.applied.length} applied migration(s) (allow-listed namespace entitycache only)`);
    return 'bumped';
  } catch (error) {
    const what = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    input.log(
      `WARNING: the entity-cache epoch bump after the upgrade failed (${what.replace(/postgres(ql)?:\/\/\S+/gi, '<url>').replace(/rediss?:\/\/\S+/gi, '<url>').slice(0, 200)}); ` +
        'continuing the start (cached entries expire within 300 s)',
    );
    return 'warning';
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/**
 * The owner-login release step and any other owner-login command without DB_TARGET: the target authority derived from the
 * deployment environment exactly as the child derives it (synthesiseGuardEnv over the live marker state), in memory only.
 * Returns null when DB_TARGET is set explicitly or the URL's login is not crewflow_owner (the legacy path is unchanged).
 */
/** Whether the process's one database URL names the owner login (parsed only; never connects, never logged). */
export function urlNamesOwnerLogin(env: Record<string, string | undefined>): boolean {
  try {
    return decodeURIComponent(new URL(env.PG_DATABASE_URL ?? '').username) === 'crewflow_owner';
  } catch {
    return false;
  }
}

export async function deriveOwnerLoginGuardEnv(env: Record<string, string | undefined>, generatedId: string = randomUUID()): Promise<Record<string, string | undefined> | null> {
  if (env.DB_TARGET?.trim()) return null;
  if (!urlNamesOwnerLogin(env)) return null;
  const { marker, database } = await readMarkerState(env);
  return synthesiseGuardEnv(env, marker, database, generatedId).guardEnv;
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
  let upgradeRun: UpgradeRun | null = null;
  const result = (outcome: StartupOutcome, extra: Partial<MigrateOnStartResult> = {}): MigrateOnStartResult => ({
    state: classification?.state ?? 'UNKNOWN',
    applied,
    pending: [],
    failedMigration: null,
    outcome,
    serve: outcome === 'ok',
    reason: outcome === 'ok' ? 'schema current' : outcome,
    checks: [],
    upgrade: upgradeRun?.report ?? null,
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
    const seamCtx = { production, disposableTestDatabase: pre.disposableTestDatabase };
    const testFailCommand = readTestFailCommand(env, seamCtx);
    const codeVersion = readAppVersion(env);
    const probes = readTestUpgradeCommands(env, seamCtx);
    if (probes.length || testFailCommand) log(`TEST SEAMS ACTIVE: upgrade probe commands=${probes.map((c) => c.name).join(',') || '-'} failCommand=${testFailCommand ?? '-'}`);
    const registry = probes.length ? withProbeCommands(UPGRADE_COMMANDS, codeVersion, probes) : undefined;
    const run = new UpgradeRun({ codeVersion, force: deps.upgradeForce === true, log, testFailCommand, registry });
    upgradeRun = run;

    const locked = await runner({
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
      // OWNER-DB-ULTIMATE Part B: the upgrade logbook (engine/core-modules/upgrade/upgrade-runner.ts), hook calls only.
      beforeApply: async ({ query, classification: c, proof: p, code, guarded }) => {
        const fresh = c.state === 'EMPTY' || c.state === 'BOOTSTRAP-PARTIAL' || p.fresh;
        await run.beforeApply(query, {
          fresh,
          attribution: fresh ? null : attributeLedger(c.applied, code),
          unrestrictedTarget: guarded.target === 'local' || guarded.target === 'test',
        });
      },
      onApplyFailure: ({ query, error }) => run.onApplyFailure(query, error),
      afterMigrations: async ({ queryRunner, applied: done, guarded }) => {
        applied = done;
        const query: Query = (sql, parameters) => queryRunner.query(sql, parameters) as Promise<unknown[]>;
        await autoBindFreshInstall({ query, env, guardEnv: guardEnvUsed, guarded, classification, proof, log });
        const problems = await deployPostCheckProblems(query);
        const { blocking, warnings } = blockingPostCheckProblems(classification?.state ?? 'UNKNOWN', problems);
        for (const w of warnings) log(`WARNING (ledger ahead, C-1): ${w}`);
        if (blocking.length) {
          const failure = new PostCheckFailure(blocking);
          await run.onApplyFailure(query, failure);
          throw failure;
        }
        log(`post-checks passed (${done.length} applied)`);
        await run.afterApply(query);
        await bumpEntityCacheAfterUpgrade({ applied: done, env, log, flush: deps.cacheFlush });
      },
    });
    applied = locked.applied;
    const state = (classification as Classification | null)?.state ?? 'UNKNOWN';
    if (run.report.commandFailure) {
      // OWNER-DB-ULTIMATE Part B3: only an upgrade COMMAND failed; every migration applied and the post-checks passed (the
      // schema matches this code), so the API serves with upgrade:"failed" (exit 70, internal). The next start retries it.
      return result('degradedContinue', { serve: true, reason: `upgrade command ${run.report.commandFailure.name} failed (${run.report.commandFailure.errorName}); schema current` });
    }
    if (state === 'AHEAD') log('WARNING: the ledger is AHEAD of this image (rollback). Nothing applied; serving with the newer schema (expand-only releases only).');
    return result('ok', { reason: state === 'AHEAD' ? 'ledger ahead of the code (image rollback): warned, not refused (C-1)' : `schema current (${applied.length} applied)` });
  } catch (error) {
    const outcome = outcomeOf(error);
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    log(`FAILED (${outcome}): ${message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>')}`);
    let c = classification as Classification | null;
    const code = codeMigrationNames();
    if (c === null) {
      // The run failed before it classified (e.g. a lock timeout): classify now, read-only, on a fresh session. Unknown
      // stays unknown (never serves).
      try {
        await withLoginClient(env, async (query) => {
          c = await classifyDatabaseState(query, code);
        });
      } catch {
        c = null;
      }
    }
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
    // OWNER-DB-ULTIMATE Part B3 ("version too old, or a migration fails: refuse; retry next start"): every failure of the
    // migrations or the gates refuses (the C3 continue path and CREWFLOW_UPGRADE_FAILURE are removed: a failed
    // migration never serves). The logbook already holds the failed row (UpgradeRun.onApplyFailure); the next start is
    // attempt N+1. Only a failed upgrade COMMAND serves (exit 70), decided above in the success path.
    if (outcome === 'migrationFailed') {
      log(`ERROR: the schema upgrade FAILED at ${failedMigration ?? 'an unknown migration'}; refusing to start (exit 66). The next start retries it.`);
    }
    return result(outcome, { pending, failedMigration, serve: false, reason: message.slice(0, 300) });
  }
}

/**
 * OWNER-DB-ULTIMATE Part B test seam: the upgrade command that fails, gated exactly like readTestSeams (NODE_ENV=test, a
 * disposable test database, never production); a bad value or a seam outside that gate is a configuration refusal (64).
 */
export function readTestUpgradeCommands(env: Record<string, string | undefined>, ctx: { production: boolean; disposableTestDatabase: boolean }): UpgradeCommand[] {
  const raw = env[TEST_UPGRADE_COMMANDS_VAR]?.trim() || null;
  if (raw === null) return [];
  if (env.NODE_ENV !== 'test' || ctx.production || !ctx.disposableTestDatabase) {
    throw new TestSeamRefusal(`${TEST_UPGRADE_COMMANDS_VAR} is a test seam: only NODE_ENV=test on a disposable test database, never production. Refusing.`);
  }
  const names = raw.split(',').map((n) => n.trim());
  if (names.length > 10 || names.some((n) => !/^[A-Za-z][A-Za-z0-9]{0,60}$/.test(n)) || new Set(names).size !== names.length) {
    throw new TestSeamRefusal(`${TEST_UPGRADE_COMMANDS_VAR} must be 1 to 10 distinct command names. Refusing.`);
  }
  // Idempotent no-ops, ordered as listed, after every real command's timestamp range.
  return names.map((name, i) => ({ name, timestamp: 1799999990000 + i, run: async ({ log }) => log(`test probe upgrade command ${name}: no-op`) }));
}

/** Pure: the registry with the probe commands appended to the code version's release. */
export function withProbeCommands(
  registry: Readonly<Record<string, readonly UpgradeCommand[]>>,
  codeVersion: string,
  probes: readonly UpgradeCommand[],
): Record<string, readonly UpgradeCommand[]> {
  const key = majorMinorKey(codeVersion);
  return { ...registry, [key]: [...(registry[key] ?? []), ...probes] };
}

export function readTestFailCommand(env: Record<string, string | undefined>, ctx: { production: boolean; disposableTestDatabase: boolean }): string | null {
  const value = env[TEST_FAIL_COMMAND_VAR]?.trim() || null;
  if (value === null) return null;
  if (env.NODE_ENV !== 'test' || ctx.production || !ctx.disposableTestDatabase) {
    throw new TestSeamRefusal(`${TEST_FAIL_COMMAND_VAR} is a test seam: only NODE_ENV=test on a disposable test database, never production. Refusing.`);
  }
  if (!/^[A-Za-z][A-Za-z0-9]{0,150}$/.test(value)) throw new TestSeamRefusal(`${TEST_FAIL_COMMAND_VAR} must be an upgrade command name. Refusing.`);
  return value;
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
  // The guard environment may hide a non-production declaration while the marker is unbound (synthesiseGuardEnv): the
  // bind uses the process's own declaration, or production's generated id.
  const environment = (guardEnv[DEPLOYMENT_ENVIRONMENT_VAR] ?? input.env[DEPLOYMENT_ENVIRONMENT_VAR])?.trim();
  if (!environment) {
    log('fresh install without CREWFLOW_DEPLOYMENT_ENVIRONMENT: the marker stays unbound (the identity is optional; declare it and bind with db:bind-identity to enable the check)');
    return;
  }
  if (!isDeploymentEnvironment(environment)) throw new Error(`${DEPLOYMENT_ENVIRONMENT_VAR} is not a deployment environment. Refusing.`);
  const deploymentId = (guardEnv[DEPLOYMENT_ID_VAR] ?? input.env[DEPLOYMENT_ID_VAR])?.trim().toLowerCase();
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
