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
 *      (production-migration-approval.ts) and CF-41 migration identity (migration-identity.ts), computed exactly as
 *      GuardedMigrationDataSource computes them (same queries, same pure decisions, same order: approval, then identity).
 *   3b. Phase B schema compatibility (src/database/boot-checks/schema-compatibility.ts), ledger part: unknown ledger names
 *      interleaved with this code's migrations (not RETIRED_MIGRATIONS) refuse in both modes; a ledger AHEAD of the code
 *      (all unknown names newer: this is an older image) refuses in 'apply' mode — an older migration set never applies
 *      against a newer ledger — and is a warning in 'check' mode.
 *   4. `new MigrationExecutor(dataSource, queryRunner)` applies the pending migrations ON THAT SESSION, transaction mode
 *      from core.datasource.ts ('each': each migration and its ledger row commit together). A second run that waited finds
 *      nothing pending and changes nothing.
 *   5. With the lock still held: nothing may remain pending, then the caller's post-steps (deploy-prepare's checks).
 *   6. Unlock, release, destroy. A holder that dies at any point (signal, crash, pg_terminate_backend) loses its session:
 *      PostgreSQL rolls back the open migration transaction and frees the lock together; earlier migrations of that run
 *      stay committed with their ledger rows, so a re-run continues from exactly there. (A `transaction = false` migration
 *      that dies mid-way can leave partial DDL without a ledger row; each of the six is written to be re-run safely.)
 *
 * CF-41, M2 (read-only pending computation: the ledger is never created before the identity check), N1 and DB_TARGET are
 * enforced by the same functions as before; nothing here widens them. Workspace schemas are migrated, as before, by the core
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
  /** Runs while the lock is still held, after the run (post-checks, cache flush). A throw fails the run. */
  afterMigrations?: (ctx: { queryRunner: QueryRunner; dataSource: DataSource; applied: string[] }) => Promise<void>;
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
}

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
    const { waitedMs } = await acquireMigrationLock(session, dataSource, waitSeconds, log);
    locked = true;
    log(`migration lock acquired${waitedMs ? ` after waiting ${waitedMs} ms` : ''}`);

    // 3. Every gate again, now that no other run can change the ledger under us.
    const guarded = await assertTarget('migrations', guardEnv, dotenvValues, DEFER_UNREADABLE_MARKER);
    const [{ db }] = (await query('SELECT current_database() AS "db"')) as Array<{ db: string }>;
    if (db !== guarded.app.database) {
      throw new Error(`the migration session is connected to database "${db}", not the guarded "${guarded.app.database}". Refusing.`);
    }
    const pendingBefore = await pendingMigrationNames(query, dataSource);
    assertProductionMigrationApproval({ target: guarded.target, pendingMigrationNames: pendingBefore });
    const facts = await readMigrationIdentityFacts(query, dataSource);
    assertMigrationIdentity(facts);
    if (options.requireMigrationIdentity) assertIdentityCanMigrate(facts);
    options.extraIdentityCheck?.(facts);
    if (guarded.identityDeferred) {
      // CF-41 accepted a login that cannot read the marker: the full marker check on this session decides (refuses).
      await assertDeferredDeploymentIdentity(async (sql, params) => (await query(sql, params)) as Array<Record<string, unknown>>, {
        purpose: 'migrations',
        target: guarded.target,
        app: guarded.app,
        admin: guarded.admin,
        migrationEndpoint: guarded.migrationEndpoint,
      }, guardEnv);
    }
    // 3b. Ledger compatibility: an interleaved foreign chain always refuses; a newer ledger refuses an apply run.
    const [{ hasLedger }] = (await query(`SELECT to_regclass('core.migrations') IS NOT NULL AS "hasLedger"`)) as Array<{ hasLedger: boolean }>;
    if (hasLedger) {
      const appliedNames = ((await query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name);
      const compatibility = assessSchemaCompatibility(
        mode === 'apply' ? 'migrate-apply' : 'migrate-check',
        { expected: dataSource.migrations.map((m) => m.name || m.constructor.name), applied: appliedNames },
        { production: guarded.target === 'production' },
      );
      for (const warning of assertSchemaCompatible(compatibility, `migration run (${options.label})`)) log(`WARNING: ${warning}`);
    }
    log(`gates passed after the lock: target=${guarded.target} role=${facts.currentUser} pending=${pendingBefore.length}`);

    // 4. Apply on the locked session.
    let applied: string[] = [];
    if (mode === 'apply' && pendingBefore.length > 0) {
      const executor = new MigrationExecutor(dataSource, session);
      executor.transaction = dataSource.options.migrationsTransactionMode ?? 'all';
      applied = (await executor.executePendingMigrations()).map((m) => m.name);
    }

    // 5. Post-run, lock still held.
    if (mode === 'apply') {
      const still = await pendingMigrationNames(query, dataSource);
      if (still.length) throw new Error(`${still.length} migration(s) are still pending after the run: ${still.join(', ')}`);
    }
    if (options.afterMigrations) await options.afterMigrations({ queryRunner: session, dataSource, applied });
    return { target: guarded.target, pendingBefore, applied, waitedMs, currentUser: facts.currentUser };
  } finally {
    if (queryRunner) {
      if (locked && !(await releaseMigrationLock(queryRunner))) log('migration lock not released explicitly (session gone); it ends with the session');
      await queryRunner.release().catch(() => undefined);
    }
    await dataSource.destroy().catch(() => undefined);
  }
}

/** Never echo a connection string. */
export function redactConnectionStrings(message: string): string {
  return message.replace(/postgres(ql)?:\/\/\S+/gi, '<url>').replace(/rediss?:\/\/\S+/gi, '<url>');
}
