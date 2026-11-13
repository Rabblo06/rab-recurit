/**
 * Phase B (P7): the locked migration runner used by setup-db.ts and deploy-prepare.ts (the one-off `rab-migrate` process).
 * The API and the Worker never import it.
 *
 * Order, all on ONE database session (a TypeORM query runner), so nothing is checked on one connection and applied on
 * another:
 *   1. Resolve the migration URL (PG_DATABASE_URL; migration-database-url.ts) and run the target guard
 *      (database-target.ts: DB_TARGET, production allow flag + expected identity, read-only probe). Refuses before any
 *      migration session exists.
 *   2. Open the migration DataSource (the migration timeouts of core.datasource.ts) and ONE query runner; take the
 *      migration advisory lock on it (migration-lock.ts: bounded wait, logged).
 *   3. With the lock held, re-run every gate, so a run that waited behind another acts on the state that run left:
 *      the target guard again, the locked session's database name against the guarded one, N1 production approval
 *      (production-migration-approval.ts; legacy path) or the upgrade floor (owner-login/release-floor.ts; owner login)
 *      and CF-41 migration identity (migration-identity.ts), computed exactly as
 *      GuardedMigrationDataSource computes them (same queries, same pure decisions, same order: approval, then identity).
 *   3b. Phase B schema compatibility (src/database/boot-checks/schema-compatibility.ts), ledger part: unknown ledger names
 *      interleaved with this code's migrations (not RETIRED_MIGRATIONS) refuse in both modes; a ledger AHEAD of the code
 *      (all unknown names newer: this is an older image) refuses in 'apply' mode — an older migration set never applies
 *      against a newer ledger — and is a warning in 'check' mode.
 *   3c. Final review F5: an apply run's approval (options.approvePending, migration-approval.ts) is checked against the
 *      pending set read in step 3 on the locked session — the last gate before step 4, so the set it approved is exactly the
 *      set that is applied. A production apply run without the gate refuses.
 *   4. `new MigrationExecutor(dataSource, queryRunner)` applies the pending migrations ON THAT SESSION, transaction mode
 *      from core.datasource.ts ('each': each migration and its ledger row commit together). A second run that waited finds
 *      nothing pending and changes nothing.
 *   5. With the lock still held: nothing may remain pending, then the caller's post-steps (deploy-prepare's checks).
 *   6. Unlock, release, destroy. A holder that dies at any point (signal, crash, pg_terminate_backend) loses its session:
 *      PostgreSQL rolls back the open migration transaction and frees the lock together; earlier migrations of that run
 *      stay committed with their ledger rows, so a re-run continues from exactly there. (A `transaction = false` migration
 *      that dies mid-way can leave partial DDL without a ledger row; each of them is written to be re-run safely. The
 *      list is owner-login/upgrade-failure-policy.ts NON_TRANSACTIONAL_MIGRATIONS, ten today, checked against the
 *      migration sources by its spec: 1786676100000, 1786719810000, 1786719920000, 1786719950000, 1786720110000,
 *      1786721090000, 1786721320000, 1786721430000, 1786721440000, 1786721450000.)
 *
 * Owner-login architecture (owner decision 2026-11-04, PR 3): the path is chosen by the SESSION LOGIN, never by an
 * environment switch.
 *   - `crewflow_owner` (OWNER_LOGIN): the owner-login lifecycle. After the lock the database is classified
 *     (owner-login/fresh-install.ts; FOREIGN refuses), the exact owner-login identity rule replaces CF-41
 *     (owner-login/owner-login-identity.ts), PostgreSQL below 16 or without reviewed workspace fingerprints is refused (D4),
 *     the UPGRADE FLOOR (owner-login/release-floor.ts, Phase X U-1, owner decision 2026-11-11) replaces N1 on this path: a
 *     production database that is not a proven fresh install may upgrade only from a supported release (R254 or later,
 *     a partial upgrade resumed included; an older or unknown history refuses with UnsupportedUpgradeStartError, exit 65),
 *     an EMPTY / BOOTSTRAP-PARTIAL database is bootstrapped
 *     (owner-login/bootstrap.ts) and the chain is applied by owner-login/owner-login-chain.ts (phase A as rab_owner, the
 *     pre-0b CREATE window, phase B as crewflow_owner, the fresh-only ROW_COPY shim). With nothing pending, a ledger AHEAD of
 *     the code is a warning, never a refusal (C-1), so an image rollback stays healthy.
 *   - any other login (the CF-41 superuser of a disposable/local cluster, or a restricted migrator): the LEGACY path,
 *     unchanged, logged loudly. RETAINED ONLY UNTIL PR #9 (REMOVE AFTER VERIFIED REPLACEMENT): today's production and
 *     every existing CI / compose flow still build and migrate through it.
 * The approval gate: the upgrade floor (owner login, unless fresh) or N1 (legacy path, unchanged until the clean-up PR), then
 * F5 as before — approvePending when the
 * caller supplies it, required for a production apply run unless `approvalMode: 'none'` (the migrate-on-start child with
 * CREWFLOW_MIGRATION_APPROVAL_MODE=none; never deploy-prepare).
 *
 * CF-41, M2 (read-only pending computation: the ledger is never created before the identity check), N1 (legacy path) and
 * DB_TARGET are enforced by the same functions as before. On the owner-login path N1 is REPLACED by the upgrade floor
 * (owner decision 2026-11-11, Phase X U-1): an existing production database at or past a supported release upgrades
 * without a per-migration approval list; every other gate is unchanged. Workspace schemas are migrated, as before, by the core
 * migrations that ship each module (migrate-workspace-schemas.ts remains the operator's resume tool).
 */
import type { ClientConfig } from 'pg';
import { DataSource, DataSourceOptions } from 'typeorm';
import { MigrationExecutor } from 'typeorm/migration/MigrationExecutor';
import type { QueryRunner } from 'typeorm';

import { assertSchemaCompatible, assessSchemaCompatibility } from '../../../boot-checks/schema-compatibility';
import { pgClientConfig, PgSessionProbeOptions, pgTypeOrmConnectionOptions, probePgSessionAffinity } from '../../../postgres';
import { coreDataSourceOptions, MIGRATION_QUERY_TIMEOUT_MS, MIGRATION_STATEMENT_TIMEOUT_MS } from '../../core/core.datasource';
import { AssertDbTargetOptions, assertDbTarget, assertDeferredDeploymentIdentity, DbTarget, readDotenvValues } from '../../core/database-target';
import {
  assertMigrationIdentity,
  MIGRATION_IDENTITY_FACTS_QUERY,
  MigrationIdentityError,
  MigrationIdentityFacts,
  ROLE_SPLIT_MIGRATION,
} from '../../core/migration-identity';
import { assertProductionMigrationApproval } from '../../core/production-migration-approval';
import { assertSupportedUpgradeStart } from './owner-login/release-floor';
import { OWNER_LOGIN } from './owner-login/bootstrap';
import {
  assertFingerprintsComplete,
  assertSupportedPostgresMajor,
  postgresMajorOf,
  selectWorkspaceFingerprintMajor,
  SUPPORTED_FINGERPRINT_MAJORS,
} from '../../workspace-schema/v1/expected-fingerprints';
import { BootstrapResult, runOwnerLoginBootstrap } from './owner-login/bootstrap';
import { disableLegacyLogins } from './owner-login/legacy-logins';
import { Classification, classifyDatabaseState, FreshInstallProof, readFreshInstallProof } from './owner-login/fresh-install';
import { LAST_ROLE_MIGRATION_TIMESTAMP, runOwnerLoginChain } from './owner-login/owner-login-chain';
import { assertOwnerLoginMigrationIdentity, OwnerLoginIdentityError, readOwnerLoginIdentityFacts } from './owner-login/owner-login-identity';
import { acquireMigrationLock, MIGRATION_APPLICATION_NAME, migrationLockWaitSeconds, releaseMigrationLock } from './migration-lock';
import { ResolvedMigrationConnection, resolveMigrationConnection, targetGuardEnv } from './migration-database-url';

export type Query = (sql: string, parameters?: unknown[]) => Promise<unknown[]>;

/** The migration process needs one session for the run plus one for naming a lock holder; a small ceiling is plenty. */
export const MIGRATION_POOL_MAX = 4;
const CONNECTION_FIELDS: readonly string[] = ['url', 'host', 'port', 'username', 'password', 'database', 'ssl', 'extra'];

/**
 * The migration DataSource options: everything of core.datasource.ts's options except the connection, plus the factory's
 * connection for the resolved migration endpoint, with the migration timeouts (statement 900 s, query 960 s) and
 * application_name `crewflow-migrate`. Built from the caller's environment, never from whatever process.env holds.
 */
export function migrationDataSourceOptions(connection: ResolvedMigrationConnection, overrides: Partial<DataSourceOptions> = {}): DataSourceOptions {
  const base = Object.fromEntries(
    Object.entries(Object.getOwnPropertyDescriptors(coreDataSourceOptions))
      .filter(([name]) => !CONNECTION_FIELDS.includes(name))
      .map(([name, descriptor]) => [name, descriptor.value]),
  );
  return {
    ...base,
    ...pgTypeOrmConnectionOptions(connection.resolved, {
      endpoint: connection.endpoint,
      purpose: 'runtime',
      sessionAffinity: true,
      statementTimeoutMs: MIGRATION_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: MIGRATION_QUERY_TIMEOUT_MS,
      max: MIGRATION_POOL_MAX,
    }),
    name: `crewflow-migrate-${process.pid}`,
    ...overrides,
  } as DataSourceOptions;
}

/** What the target guard returns that this runner uses. database-target.ts's ResolvedDbTarget satisfies it. */
export interface GuardedTarget {
  target: DbTarget;
  /** host: the factory's parse (owner decision A: a bound marker must have been bound at this host). */
  app: { database: string; host?: string };
  admin?: { host?: string } | null;
  migrationEndpoint?: 'primary' | 'elevated';
  /**
   * The login may not read the deployment identity marker (42501). The runner then lets CF-41 refuse first and runs the
   * full marker check on the locked session itself (database-target.ts assertDeferredDeploymentIdentity). Never a pass.
   */
  identityDeferred?: boolean;
}

export interface LockedMigrationOptions {
  /** Log prefix and target-guard purpose. */
  label: string;
  env?: Record<string, string | undefined>;
  dotenvValues?: Record<string, string>;
  log?: (message: string) => void;
  /**
   * 'apply' runs the pending migrations; 'check' takes the lock, runs every gate and reports what is pending without
   * applying anything (deploy-prepare's unapproved path).
   */
  mode?: 'apply' | 'check';
  /**
   * deploy-prepare: once the role split is applied, refuse an identity that could not run a migration even when nothing is
   * pending (a runtime credential handed to rab-migrate must fail, not "succeed" as a no-op). Off for setup-db.ts, whose
   * CF-41 behaviour is unchanged.
   */
  requireMigrationIdentity?: boolean;
  /** Extra identity rule run with the other gates after the lock, before anything is applied (deploy-prepare's phase rule). */
  extraIdentityCheck?: (facts: MigrationIdentityFacts) => void;
  /**
   * Final review F5: the approval gate of an apply run (migration-approval.ts assertMigrationApproval). Called with the pending
   * set read ON THE LOCKED SESSION, as the last gate before anything is applied, so the set it approves is the set that
   * runs. A throw refuses the run with nothing applied. Required in 'apply' mode when the target is production.
   */
  approvePending?: (pendingNames: readonly string[]) => void;
  /**
   * Runs while the lock is still held, after the run (post-checks, cache flush), in both modes. `pendingBefore` is the set
   * read on the locked session before step 4 (in 'check' mode it is still pending). A throw fails the run.
   */
  afterMigrations?: (ctx: {
    queryRunner: QueryRunner;
    dataSource: DataSource;
    applied: string[];
    pendingBefore: readonly string[];
    /** The guarded target of this run (target, database, host). */
    guarded?: GuardedTarget;
  }) => Promise<void>;
  /**
   * OWNER-DB-ULTIMATE Part B (owner login, apply mode): the upgrade logbook's previous-version check. Runs with the lock held
   * after every other gate and before anything is applied (bootstrap included); a throw refuses the run with nothing
   * applied (UpgradeVersionTooOldError → exit 65). The session is outside any transaction.
   */
  beforeApply?: (ctx: {
    query: Query;
    classification: Classification;
    proof: FreshInstallProof;
    pendingBefore: readonly string[];
    code: readonly string[];
    guarded: GuardedTarget;
  }) => Promise<void>;
  /**
   * OWNER-DB-ULTIMATE Part B: a migration (step 4) or the still-pending check (step 5) failed. Runs with the lock held,
   * before the error propagates, so the failure can be recorded in the logbook. Must not throw (a throw is ignored).
   */
  onApplyFailure?: (ctx: { query: Query; error: unknown }) => Promise<void>;
  /** Called with the migration session's backend pid before the lock is taken (the child's SIGTERM self-cancel). */
  onSession?: (pid: number) => void;
  /**
   * F5 approval policy of an apply run. 'token' (default; deploy-prepare, setup-db): approvePending when supplied, required
   * for a production apply. 'none': the migrate-on-start child with CREWFLOW_MIGRATION_APPROVAL_MODE=none — no token; the
   * upgrade floor still applies to every database that is not a proven fresh install. Honoured for the owner login only.
   */
  approvalMode?: 'none' | 'token';
  /**
   * The migrate-on-start child: refuse any login other than crewflow_owner (the legacy CF-41 path exists only for the
   * retained deploy-prepare / setup-db flows until PR #9; a runtime child must never fall back to it).
   */
  requireOwnerLogin?: boolean;
  /** Server-side check for a vanished client, in seconds (the child sets 1; M0-C: a killed holder otherwise keeps the lock). */
  connectionCheckIntervalSeconds?: number;
  /** Owner login: called with the classification and the fresh-install proof as soon as they are known. */
  onClassified?: (classification: Classification, proof: FreshInstallProof) => void;
  /** Test seam for the golden-equivalence reference build (owner-login-chain.ts rowCopyOverride). Never set in production. */
  rowCopyOverride?: (name: string) => Promise<void>;
  /** Test seam (migrate-on-start.ts gates it; owner login only): this migration fails inside its transaction. */
  testFailAt?: string | null;
  /**
   * The child: re-derives the target-guard environment AFTER the lock (the deployment-identity bootstrap flag depends on
   * the marker state, which another run may have changed while this one waited). Default: the same environment as before.
   */
  refreshGuardEnv?: () => Promise<Record<string, string | undefined>>;
  /** Test seam: the target guard (default: database-target.ts assertDbTarget). Used to exercise the production approval gate. */
  assertTarget?: (
    purpose: string,
    env: Record<string, string | undefined>,
    dotenvValues: Record<string, string>,
    options?: AssertDbTargetOptions,
  ) => Promise<GuardedTarget>;
  /** Test seam: extra DataSource options (for example a subset of migrations). Never used by the production entrypoints. */
  dataSourceOverrides?: Partial<DataSourceOptions>;
  /** Test seam: the live session-stability probe (default: pg-session-probe.ts probePgSessionAffinity). */
  sessionProbe?: (config: ClientConfig, options: PgSessionProbeOptions) => Promise<unknown>;
}

export interface LockedMigrationResult {
  target: DbTarget;
  pendingBefore: string[];
  applied: string[];
  waitedMs: number;
  currentUser: string;
  /** PostgreSQL major of the server (read after the lock). */
  serverMajor?: number;
  /** Which path ran: the owner-login lifecycle, or the legacy CF-41 path (until PR #9). */
  path?: 'owner-login' | 'legacy';
  ownerLogin?: { classification: Classification; proof: FreshInstallProof; bootstrap: BootstrapResult | null };
}

/**
 * D4: the workspace fingerprints of the server's major. The owner login refuses below 16 and any major without reviewed
 * fingerprints. The legacy path (until PR #9) selects 16 or 18 when it is one of them and otherwise keeps today's
 * behaviour (the PG16 table, so a mismatch fails closed at the fingerprint comparison), with a warning.
 */
export function selectFingerprintsForRun(serverVersionNum: string, strict: boolean, log: (line: string) => void): number {
  const major = postgresMajorOf(serverVersionNum);
  if (strict) {
    const supported = assertSupportedPostgresMajor(major);
    assertFingerprintsComplete(supported);
    selectWorkspaceFingerprintMajor(supported);
    return major;
  }
  if ((SUPPORTED_FINGERPRINT_MAJORS as readonly number[]).includes(major)) selectWorkspaceFingerprintMajor(major);
  else log(`WARNING: PostgreSQL ${major} has no reviewed workspace fingerprints (${SUPPORTED_FINGERPRINT_MAJORS.join(', ')} only); workspace fingerprint checks will refuse`);
  return major;
}

/**
 * The F5 decision of an apply run (pure; exported for its spec). Agent 5 finding (MEDIUM, 2026-11-04): with
 * CREWFLOW_MIGRATION_APPROVAL_MODE=token the child used to demand the token only for a PRODUCTION target, so `token` without
 * a token applied pending migrations to a non-fresh non-production database. Design decision (Agent 1, flagged to the
 * owner): `token` set explicitly gates EVERY non-fresh apply with something pending, whatever the target — the operator
 * chose per-release approval for this deployment. A proven fresh install still needs none (owner rule). deploy-prepare
 * (approvalMode unset) keeps its F5 behaviour: an apply run always carries the token; production refuses without it.
 */
export function approvalDecision(f: {
  mode: 'apply' | 'check';
  ownerLogin: boolean;
  approvalMode: 'none' | 'token' | undefined;
  fresh: boolean;
  pending: number;
  hasApprover: boolean;
  production: boolean;
}): 'check' | 'none-mode' | 'refuse-token' | 'f5' {
  if (f.mode !== 'apply') return 'check';
  if (f.ownerLogin && f.approvalMode === 'none') return 'none-mode';
  if (f.ownerLogin && f.approvalMode === 'token' && !f.fresh && f.pending > 0 && !f.hasApprover) return 'refuse-token';
  return 'f5';
}

const timestampOrNull = (name: string): number | null => {
  const m = /(\d{13})$/.exec(name);
  return m ? Number(m[1]) : null;
};

/** Loaded migrations not yet in core.migrations (all of them when the ledger does not exist). Read-only, like GuardedMigrationDataSource. */
export async function pendingMigrationNames(query: Query, dataSource: DataSource): Promise<string[]> {
  const [ledger] = (await query(`SELECT to_regclass('core.migrations') IS NOT NULL AS "hasLedger"`)) as Array<{ hasLedger: boolean }>;
  const applied = new Set<string>(
    ledger?.hasLedger ? ((await query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name) : [],
  );
  return dataSource.migrations.map((m) => m.name || m.constructor.name).filter((name) => !applied.has(name));
}

/**
 * The CF-41 facts, computed exactly as GuardedMigrationDataSource.assertIdentityForPendingMigrations computes them (same
 * query, `pendingMigrations` as 0/1, phase-A count by 13-digit timestamp), but on the caller's session.
 */
export async function readMigrationIdentityFacts(query: Query, dataSource: DataSource): Promise<MigrationIdentityFacts> {
  const [row] = (await query(MIGRATION_IDENTITY_FACTS_QUERY)) as Array<{
    currentUser: string;
    isSuperuser: boolean;
    hasLedger: boolean;
    canActAsOwnerRoles: boolean;
  }>;
  if (!row) throw new MigrationIdentityError('Cannot read the connecting role. Refusing to run migrations.');
  const roleSplitApplied = row.hasLedger ? ((await query(`SELECT 1 FROM core.migrations WHERE name = $1`, [ROLE_SPLIT_MIGRATION])) as unknown[]).length > 0 : false;
  const pending = (await pendingMigrationNames(query, dataSource)).length > 0 ? 1 : 0;
  const applied = new Set<string>(
    row.hasLedger ? ((await query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name) : [],
  );
  const timestampOf = (name: string) => Number(/(\d{13})$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
  const splitAt = timestampOf(ROLE_SPLIT_MIGRATION);
  const pendingBeforeRoleSplit = dataSource.migrations.filter((m) => m.name && !applied.has(m.name) && timestampOf(m.name) < splitAt).length;
  return {
    currentUser: row.currentUser,
    isSuperuser: row.isSuperuser,
    canActAsOwnerRoles: row.canActAsOwnerRoles,
    roleSplitApplied,
    pendingMigrations: pending,
    pendingBeforeRoleSplit,
  };
}

/** deploy-prepare's extra rule (see LockedMigrationOptions.requireMigrationIdentity). Pure. */
export function assertIdentityCanMigrate(facts: MigrationIdentityFacts): void {
  if (facts.roleSplitApplied && !facts.isSuperuser && !facts.canActAsOwnerRoles) {
    throw new MigrationIdentityError(
      `Refusing: "${facts.currentUser}" is not a migration identity (it cannot act as both rab_secure_owner and crewflow). ` +
        'rab-migrate must run with the migration-only credential, never a runtime one, even when nothing is pending.',
    );
  }
}

const defaultAssertTarget = async (
  purpose: string,
  env: Record<string, string | undefined>,
  dotenvValues: Record<string, string>,
  options?: AssertDbTargetOptions,
) => assertDbTarget(purpose, env, dotenvValues, options);

/** Both target-guard calls defer an unreadable marker to after CF-41 (see GuardedTarget.identityDeferred). */
const DEFER_UNREADABLE_MARKER: AssertDbTargetOptions = { deferUnreadableMarker: true };

export async function runLockedMigrations(options: LockedMigrationOptions): Promise<LockedMigrationResult> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.log(`[${options.label}] ${message}`)); // eslint-disable-line no-console
  const dotenvValues = options.dotenvValues ?? readDotenvValues();
  const assertTarget = options.assertTarget ?? defaultAssertTarget;
  const mode = options.mode ?? 'apply';

  // 1. Before any migration session exists.
  const connection = resolveMigrationConnection(env, dotenvValues);
  for (const warning of connection.warnings) log(`WARNING: ${warning}`);
  const waitSeconds = migrationLockWaitSeconds(env.CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS);
  const guardEnv = targetGuardEnv(env, connection.url);
  await assertTarget('migrations', guardEnv, dotenvValues, DEFER_UNREADABLE_MARKER);

  // Security review L-3: the migration lock is a SESSION advisory lock taken outside a transaction, so the migration
  // connection must be session-stable. The URL denylist (pg-url-policy.ts) only knows documented pooler shapes; a
  // self-hosted transaction-mode PgBouncer on 5432/6432 passes it. The same live two-connection probe the Worker runs
  // (pg-session-probe.ts), on the migration endpoint itself, before any migration session or lock exists. Refuses on failure.
  await (options.sessionProbe ?? probePgSessionAffinity)(
    pgClientConfig(connection.resolved, { endpoint: connection.endpoint, purpose: 'probe', sessionAffinity: true, statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }),
    { label: 'the migration session connection' },
  );

  const dataSourceOptions = migrationDataSourceOptions(connection, options.dataSourceOverrides) as DataSourceOptions & {
    synchronize?: boolean;
    dropSchema?: boolean;
    migrationsRun?: boolean;
  };
  if (dataSourceOptions.synchronize || dataSourceOptions.dropSchema || dataSourceOptions.migrationsRun) {
    throw new Error('refusing: synchronize, dropSchema and migrationsRun must all be off (the migration runner never resets a database)');
  }

  // 2. One session; the lock lives on it.
  const dataSource = new DataSource(dataSourceOptions);
  await dataSource.initialize();
  let queryRunner: QueryRunner | undefined;
  let locked = false;
  try {
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    const session = queryRunner;
    const query: Query = (sql, parameters) => session.query(sql, parameters) as Promise<unknown[]>;
    await query(`SELECT pg_catalog.set_config('application_name', $1, false)`, [MIGRATION_APPLICATION_NAME]);
    const [{ pid }] = (await query('SELECT pg_catalog.pg_backend_pid() AS "pid"')) as Array<{ pid: number }>;
    log(`migration session pid ${pid}; taking the migration lock`);
    options.onSession?.(Number(pid));
    const { waitedMs } = await acquireMigrationLock(session, dataSource, waitSeconds, log);
    locked = true;
    log(`migration lock acquired${waitedMs ? ` after waiting ${waitedMs} ms` : ''}`);

    if (options.connectionCheckIntervalSeconds) {
      await query(`SELECT pg_catalog.set_config('client_connection_check_interval', $1, false)`, [`${options.connectionCheckIntervalSeconds}s`]);
    }
    const [who] = (await query(`SELECT session_user::text AS "login", current_setting('server_version_num') AS "num"`)) as Array<{ login: string; num: string }>;
    const ownerLogin = who?.login === OWNER_LOGIN;
    if (!ownerLogin && options.requireOwnerLogin) {
      throw new OwnerLoginIdentityError(`the migrate-on-start child runs only as ${OWNER_LOGIN}; this login is not it (no legacy fallback). Refusing.`);
    }
    if (!ownerLogin) {
      log(
        '*** LEGACY migration identity (not crewflow_owner): the separated-layout CF-41 path is RETAINED ONLY UNTIL PR #9. ' +
          'Move this deployment to the owner login (packages/rab-docker/postgres-init/owner-login/). ***',
      );
    }
    const serverMajor = selectFingerprintsForRun(who!.num, ownerLogin, log);

    // 3. Every gate again, now that no other run can change the ledger under us.
    const lockedGuardEnv = options.refreshGuardEnv ? targetGuardEnv(await options.refreshGuardEnv(), connection.url) : guardEnv;
    const guarded = await assertTarget('migrations', lockedGuardEnv, dotenvValues, DEFER_UNREADABLE_MARKER);
    const [{ db }] = (await query('SELECT current_database() AS "db"')) as Array<{ db: string }>;
    if (db !== guarded.app.database) throw new MigrationSessionDatabaseError(db, guarded.app.database);
    const pendingBefore = await pendingMigrationNames(query, dataSource);
    let ownerState: { classification: Classification; proof: FreshInstallProof } | null = null;
    if (ownerLogin) {
      // Classify first (FOREIGN refuses before any other decision), then the exact identity rule, then the upgrade floor
      // unless this is a proven fresh install (owner rule: on EMPTY the full chain is allowed under the shim). Phase X U-1
      // (owner decision 2026-11-11): the floor replaces N1 on this path only; the legacy branch below keeps N1.
      const expected = dataSource.migrations.map((m) => m.name || m.constructor.name);
      const classification = await classifyDatabaseState(query, expected);
      const proof = await readFreshInstallProof(query, classification.state);
      options.onClassified?.(classification, proof);
      log(`database state ${classification.state} (${classification.reason}); fresh install ${proof.fresh ? 'PROVEN' : `not proven: ${proof.reasons.join('; ')}`}`);
      if (classification.state === 'FOREIGN') throw new DatabaseStateError(classification);
      const identity = await readOwnerLoginIdentityFacts(query);
      const roleWork =
        classification.state === 'EMPTY' ||
        classification.state === 'BOOTSTRAP-PARTIAL' ||
        pendingBefore.some((n) => (timestampOrNull(n) ?? 0) <= LAST_ROLE_MIGRATION_TIMESTAMP);
      assertOwnerLoginMigrationIdentity(identity, { needCreateRole: roleWork && mode === 'apply' });
      if (!proof.fresh) {
        const floor = assertSupportedUpgradeStart({
          target: guarded.target,
          state: classification.state,
          fresh: proof.fresh,
          applied: classification.applied,
          code: expected,
        });
        log(`upgrade floor: ${floor.reason}`);
      }
      ownerState = { classification, proof };
    } else {
      assertProductionMigrationApproval({ target: guarded.target, pendingMigrationNames: pendingBefore });
    }
    const facts = await readMigrationIdentityFacts(query, dataSource);
    if (!ownerLogin) {
      assertMigrationIdentity(facts);
      if (options.requireMigrationIdentity) assertIdentityCanMigrate(facts);
    }
    options.extraIdentityCheck?.(facts);
    if (guarded.identityDeferred) {
      // CF-41 accepted a login that cannot read the marker: the full marker check on this session decides (refuses).
      await assertDeferredDeploymentIdentity(async (sql, params) => (await query(sql, params)) as Array<Record<string, unknown>>, {
        purpose: 'migrations',
        target: guarded.target,
        app: guarded.app,
        admin: guarded.admin,
        migrationEndpoint: guarded.migrationEndpoint,
      }, lockedGuardEnv);
    }
    // 3b. Ledger compatibility: an interleaved foreign chain always refuses; a newer ledger refuses an apply run.
    const [{ hasLedger }] = (await query(`SELECT to_regclass('core.migrations') IS NOT NULL AS "hasLedger"`)) as Array<{ hasLedger: boolean }>;
    if (hasLedger) {
      const appliedNames = ((await query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name);
      // C-1 (owner login): with nothing pending, an older image looks at a newer ledger exactly like a check run (warn).
      const lenient = mode === 'check' || (ownerLogin && pendingBefore.length === 0);
      const compatibility = assessSchemaCompatibility(
        lenient ? 'migrate-check' : 'migrate-apply',
        { expected: dataSource.migrations.map((m) => m.name || m.constructor.name), applied: appliedNames },
        { production: guarded.target === 'production' },
      );
      for (const warning of assertSchemaCompatible(compatibility, `migration run (${options.label})`)) log(`WARNING: ${warning}`);
    }
    // 3c. F5: the approval is checked against the set pending now, with the lock held (it cannot change before the apply).
    const approval = approvalDecision({
      mode,
      ownerLogin,
      approvalMode: options.approvalMode,
      fresh: ownerState?.proof.fresh === true,
      pending: pendingBefore.length,
      hasApprover: Boolean(options.approvePending),
      production: guarded.target === 'production',
    });
    if (approval === 'refuse-token') {
      throw new Error(
        `${options.label}: CREWFLOW_MIGRATION_APPROVAL_MODE=token needs CREWFLOW_MIGRATION_APPROVED for the ${pendingBefore.length} pending migration(s) of this existing database (any target). Nothing was applied. Refusing.`,
      );
    }
    if (approval === 'none-mode') {
      // The migrate-on-start child with approval mode none: the upgrade floor above is the gate on an existing database (ST-3).
      log(`approval mode none: ${ownerState?.proof.fresh ? 'proven fresh install' : 'upgrade floor checked'}; no per-release token`);
    } else if (mode === 'apply') {
      if (options.approvePending) options.approvePending(pendingBefore);
      else if (ownerLogin && ownerState?.proof.fresh) log('proven fresh install: the full chain is allowed without a per-release token (owner rule)');
      else if (guarded.target === 'production') {
        throw new Error(`${options.label}: a production apply run needs the per-release approval gate (CREWFLOW_MIGRATION_APPROVED). Nothing was applied. Refusing.`);
      }
    }
    log(`gates passed after the lock: target=${guarded.target} role=${facts.currentUser} pending=${pendingBefore.length}`);
    if (mode === 'apply' && ownerLogin && ownerState && options.beforeApply) {
      await options.beforeApply({
        query,
        classification: ownerState.classification,
        proof: ownerState.proof,
        pendingBefore,
        code: dataSource.migrations.map((m) => m.name || m.constructor.name),
        guarded,
      });
    }

    // 4. Apply on the locked session.
    let applied: string[] = [];
    let bootstrap: BootstrapResult | null = null;
    try {
      if (ownerLogin && ownerState) {
        const state = ownerState.classification.state;
        if (mode === 'apply' && (state === 'EMPTY' || state === 'BOOTSTRAP-PARTIAL')) bootstrap = await runOwnerLoginBootstrap(query, { log });
        if (mode === 'apply' && pendingBefore.length > 0) {
          applied = (await runOwnerLoginChain({ dataSource, session, log, freshInstall: ownerState.proof.fresh, rowCopyOverride: options.rowCopyOverride, testFailAt: options.testFailAt }))
            .applied;
        }
      } else if (mode === 'apply' && pendingBefore.length > 0) {
        const executor = new MigrationExecutor(dataSource, session);
        executor.transaction = dataSource.options.migrationsTransactionMode ?? 'all';
        applied = (await executor.executePendingMigrations()).map((m) => m.name);
      }

      // 5. Post-run, lock still held.
      if (mode === 'apply') {
        const still = await pendingMigrationNames(query, dataSource);
        if (still.length) throw new MigrationsStillPendingError(still);
      }
    } catch (error) {
      if (mode === 'apply' && options.onApplyFailure) await options.onApplyFailure({ query, error }).catch(() => undefined);
      throw error;
    }
    // BC-17 (owner decision 2026-11-05): an owner-login install ends with the legacy logins crewflow / crewflow_app NOLOGIN
    // PASSWORD NULL (crewflow_owner created them, so it holds ADMIN). Run on every fresh install AND after any run that
    // re-ran a role migration (1786682000000 / 1786687000000 set a new random password, also on a role an earlier install on
    // this cluster already made NOLOGIN). Existing databases are moved by the transition SQL (provider admin).
    if (mode === 'apply' && ownerLogin && ownerState) {
      const s = ownerState.classification.state;
      const reranRoleMigration = applied.some((n) => (timestampOrNull(n) ?? Number.MAX_SAFE_INTEGER) <= LAST_ROLE_MIGRATION_TIMESTAMP);
      if (s === 'EMPTY' || s === 'BOOTSTRAP-PARTIAL' || ownerState.proof.fresh || reranRoleMigration) {
        await disableLegacyLogins(query as (sql: string) => Promise<unknown[]>, log);
      }
    }
    if (options.afterMigrations) await options.afterMigrations({ queryRunner: session, dataSource, applied, pendingBefore, guarded });
    return {
      target: guarded.target,
      pendingBefore,
      applied,
      waitedMs,
      currentUser: facts.currentUser,
      serverMajor,
      path: ownerLogin ? 'owner-login' : 'legacy',
      ...(ownerState ? { ownerLogin: { ...ownerState, bootstrap } } : {}),
    };
  } finally {
    if (queryRunner) {
      if (locked && !(await releaseMigrationLock(queryRunner))) log('migration lock not released explicitly (session gone); it ends with the session');
      await queryRunner.release().catch(() => undefined);
    }
    await dataSource.destroy().catch(() => undefined);
  }
}

/** Owner login: the database is not this application's (or not in a state this code may touch). Nothing was changed. */
export class DatabaseStateError extends Error {
  constructor(readonly classification: Classification) {
    super(`refusing a ${classification.state} database: ${classification.reason}. Nothing was changed.`);
    this.name = 'DatabaseStateError';
  }
}

/**
 * SU-07: the locked session is not on the database the target guard checked. Nothing was changed. Named so migrate-on-start
 * maps it to `identity` (exit 67, fail closed under every policy); as a plain Error it was a "migration failure".
 */
export class MigrationSessionDatabaseError extends Error {
  constructor(actual: string, guarded: string) {
    super(`the migration session is connected to database "${actual}", not the guarded "${guarded}". Refusing.`);
    this.name = 'MigrationSessionDatabaseError';
  }
}

/**
 * SU-07: the run finished but migrations of this code are still pending on the locked session. Named so migrate-on-start
 * maps it to `postCheck` (exit 68, fail closed under every policy); as a plain Error it was a "migration failure".
 */
export class MigrationsStillPendingError extends Error {
  constructor(readonly still: readonly string[]) {
    super(`${still.length} migration(s) are still pending after the run: ${still.join(', ')}`);
    this.name = 'MigrationsStillPendingError';
  }
}

/** Never echo a connection string. */
export function redactConnectionStrings(message: string): string {
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>').replace(/rediss?:\/\/\S+/gi, '<url>');
}
