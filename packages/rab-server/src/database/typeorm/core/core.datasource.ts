// Entity decorators (@Entity, @Column, ...) need reflect-metadata loaded
// before they run. NestJS's own bootstrap (main.ts, via @nestjs/core) loads
// it as a side effect, but standalone consumers of this datasource
// (setup-db.ts, the TypeORM CLI) don't go through Nest at all — load it
// here, once, so every consumer gets it regardless of entrypoint.
import 'reflect-metadata';

import { DataSource, DataSourceOptions } from 'typeorm';
import { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

import { assertDbTarget, DbTarget } from './database-target';
import { assertMigrationIdentity, MIGRATION_IDENTITY_FACTS_QUERY, MigrationIdentityError, ROLE_SPLIT_MIGRATION } from './migration-identity';
import { assertProductionMigrationApproval } from './production-migration-approval';

import { SLOW_QUERY_THRESHOLD_MS, SlowQueryLogger } from './slow-query-logger';
import { PushDevice } from '../../../engine/core-modules/push/entities/push-device.entity';
import { PushDelivery } from '../../../engine/core-modules/push/entities/push-delivery.entity';
import { StoredFile } from '../../../engine/core-modules/storage/entities/stored-file.entity';
import * as attendanceEntities from '../../../modules/attendance/entities';
import * as identityEntities from '../../../modules/identity/entities';
import * as managerEntities from '../../../modules/manager/entities';
import * as managerWorkspaceEntities from '../../../modules/manager-workspace/entities';
import * as notificationEntities from '../../../modules/notification/entities';
import * as offerEntities from '../../../modules/offer/entities';
import * as schedulingEntities from '../../../modules/scheduling/entities';
import * as staffEntities from '../../../modules/staff/entities';
import * as venueEntities from '../../../modules/venue/entities';

/**
 * Single DataSource, schema `core`. `synchronize: false` always — every
 * schema change is a versioned migration, never edited after merge (see
 * CLAUDE.md and rab-workforce-architecture.md §11).
 *
 * Entities are explicit imports, not a glob pattern. A glob-resolved
 * `require()` and a normal relative `import` of the same .ts file can end
 * up as two distinct module instances under ts-node on Windows (mixed
 * forward/backslash path strings hit Node's require cache differently),
 * which manifests as `EntityMetadataNotFoundError` even though the file
 * genuinely got loaded — TypeORM registered metadata against a different
 * `Organisation` class object than the one every service imports. Explicit
 * imports guarantee both call sites reference the exact same class.
 */
export const coreDataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: process.env.DATABASE_URL,
  // No DataSource-level default schema (HWS runtime cutover, Part 2). Core entities each declare `schema: 'core'`
  // explicitly; the 14 workspace entities declare none and resolve through whatever search_path TenantContextService
  // bound for the current transaction — 'core' when HWS_RUNTIME_ENABLED is false or the caller has no workspace, or the
  // caller's resolved physical workspace schema when HWS_RUNTIME_ENABLED is true and ctx.workspaceId is set. Raw SQL is
  // never affected either way: every occurrence in this codebase already schema-qualifies explicitly, and the postgres
  // driver never issues its own SET search_path (verified: no match for it anywhere in node_modules/typeorm's driver).
  synchronize: false,
  // Connection pool ceiling per process (node-postgres default is 10). Each API request holds ONE connection for
  // its whole tenant transaction, so this is the concurrency ceiling of one API instance. Tunable without a code
  // change; keep (instances x DB_POOL_MAX) below the database's max_connections.
  extra: {
    max: Number(process.env.DB_POOL_MAX) > 0 ? Number(process.env.DB_POOL_MAX) : 10,
    // A silently-dropped connection (managed-Postgres idle disconnect, a
    // network blip) otherwise leaves a query awaiting a response that will
    // never arrive — no error, no timeout, forever. Confirmed in production:
    // every rab-worker polling loop sharing one long-lived connection wedged
    // permanently this way after a network interruption. `query_timeout` is
    // the client-side backstop (node-postgres aborts and rejects even if the
    // server-side timeout below never fires because the socket is dead);
    // `statement_timeout` is the server-side one (aborts a genuinely
    // long-running query before it can hold a connection/lock indefinitely).
    // `keepAlive` lets the OS detect a dead idle socket proactively instead
    // of only on next use.
    query_timeout: 30_000,
    statement_timeout: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  },
  // Custom logger, not the `logging: [...]` string-array option — TypeORM's
  // own built-in loggers print bound `parameters` on `logQueryError`
  // (confirmed leaking real ids/values in this session's own test output);
  // SlowQueryLogger replaces that entirely with a version that never reads
  // `parameters` at all, for either errors or the new slow-query capability
  // below.
  logging: true,
  logger: new SlowQueryLogger(),
  maxQueryExecutionTime: SLOW_QUERY_THRESHOLD_MS,
  entities: [
    ...Object.values(identityEntities),
    ...Object.values(staffEntities),
    ...Object.values(managerEntities),
    ...Object.values(managerWorkspaceEntities),
    ...Object.values(venueEntities),
    ...Object.values(schedulingEntities),
    ...Object.values(offerEntities),
    ...Object.values(notificationEntities),
    ...Object.values(attendanceEntities),
    StoredFile,
    PushDevice,
    PushDelivery,
  ],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  // Dotted and permanent now that the DataSource default schema is removed (HWS runtime cutover, Part 2). Measured on
  // rab_crewflow_hws_phase3 (see HYPER-WORKSPACE-PHASE3-FOUNDATION.md): with no default schema, the unqualified name
  // 'migrations' resolves against search_path (now dynamic, no longer always 'core') and TypeORM reports every
  // migration as still pending; the dotted name resolves correctly regardless of search_path.
  migrationsTableName: 'core.migrations',
  // 'each': every pending migration runs in its own transaction by default (TypeORM's 'all' forbids any per-migration override).
  // Needed because CREATE INDEX CONCURRENTLY cannot run inside a transaction; such a migration opts out with `transaction = false`.
  // Changes only how pending migrations are wrapped; the schema they produce is unchanged.
  migrationsTransactionMode: 'each',
};

/**
 * Migration-only timeouts. A CREATE INDEX CONCURRENTLY build waits for every older transaction to finish, so on a large
 * table, or behind a long-open transaction, it can legitimately run for minutes. The runtime 30-second values would kill it
 * mid-build and leave an INVALID index behind. Only the migration DataSource gets these; the API and Worker keep the
 * runtime values above.
 *
 * `statement_timeout` (server) must fire before `query_timeout` (client). If the client gave up first, the server could keep
 * building while the runner had already reported failure.
 */
export const MIGRATION_STATEMENT_TIMEOUT_MS = 900_000; // 15 minutes
export const MIGRATION_QUERY_TIMEOUT_MS = 960_000; // 16 minutes

if (MIGRATION_QUERY_TIMEOUT_MS <= MIGRATION_STATEMENT_TIMEOUT_MS) {
  throw new Error('MIGRATION_QUERY_TIMEOUT_MS must exceed MIGRATION_STATEMENT_TIMEOUT_MS');
}

/**
 * Same options as the runtime DataSource, with the two timeouts raised AND the connection URL
 * swapped to `DATABASE_URL_UNPOOLED` instead of `DATABASE_URL`.
 *
 * P2/P3 Checkpoint 2 (restricted runtime role): `DATABASE_URL` now connects as `crewflow_app`,
 * which owns no table and cannot run DDL (see `assert-runtime-db-role.ts`) — migrations need
 * `crewflow`'s ownership-derived DDL authority, so they use the pre-existing elevated connection
 * string `DATABASE_URL_UNPOOLED` that `bootstrap-admin.command.ts`/`user-session-backfill.command.ts`/
 * `hws-backfill.command.ts --apply` already use for the same reason. This is the "keep
 * migration/bootstrap authority separate from runtime" requirement, enforced by which credential the
 * migration runner is handed, not by any in-process check — `coreDataSourceOptions` above (the one
 * the API and Worker actually run as) is untouched and still reads only `DATABASE_URL`.
 */
export const coreMigrationDataSourceOptions: DataSourceOptions = {
  ...coreDataSourceOptions,
  url: process.env.DATABASE_URL_UNPOOLED,
  extra: {
    ...(coreDataSourceOptions as PostgresConnectionOptions).extra,
    statement_timeout: MIGRATION_STATEMENT_TIMEOUT_MS,
    query_timeout: MIGRATION_QUERY_TIMEOUT_MS,
  },
};

/**
 * Every connection a migration makes goes through `initialize()`, and that runs the explicit target guard first: DB_TARGET
 * must be set, production needs the explicit allow flag and the expected identity, and a read-only probe confirms the
 * target before any DDL runs. This covers setup-db.ts and the TypeORM CLI (`migration:run`, `migration:revert`) alike.
 */
export class GuardedMigrationDataSource extends DataSource {
  /** Set by initialize() from the guard's resolution. Undefined means unknown, which the approval check treats as restricted. */
  private dbTarget: DbTarget | undefined;

  override async initialize(): Promise<this> {
    this.dbTarget = (await assertDbTarget('migrations')).target;
    return super.initialize();
  }

  // N1: a production-target run refuses, before any DDL and as a whole, any pending migration that is not on the reviewed
  // production approval list (production-migration-approval.ts). Local and test targets are unaffected.
  // CF-41: refuse the wrong identity for the pending work before any migration runs (migration-identity.ts).
  override async runMigrations(options?: Parameters<DataSource['runMigrations']>[0]): ReturnType<DataSource['runMigrations']> {
    assertProductionMigrationApproval({ target: this.dbTarget, pendingMigrationNames: await this.pendingMigrationNames() });
    await this.assertIdentityForPendingMigrations();
    return super.runMigrations(options);
  }

  /** Loaded migrations not yet recorded in core.migrations (all of them when the ledger does not exist yet). */
  private async pendingMigrationNames(): Promise<string[]> {
    const [ledger] = (await this.query(`SELECT to_regclass('core.migrations') IS NOT NULL AS "hasLedger"`)) as Array<{ hasLedger: boolean }>;
    const applied = new Set<string>(
      ledger?.hasLedger ? ((await this.query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name) : [],
    );
    return this.migrations.map((m) => m.name || m.constructor.name).filter((name) => !applied.has(name));
  }

  override async undoLastMigration(options?: Parameters<DataSource['undoLastMigration']>[0]): Promise<void> {
    // A revert replays a down() that may touch rab_secure_owner objects: require the bootstrap identity once split.
    await this.assertIdentityForPendingMigrations(1);
    return super.undoLastMigration(options);
  }

  private async assertIdentityForPendingMigrations(minimumPending = 0): Promise<void> {
    const [row] = (await this.query(MIGRATION_IDENTITY_FACTS_QUERY)) as Array<{
      currentUser: string;
      isSuperuser: boolean;
      hasLedger: boolean;
      canActAsOwnerRoles: boolean;
    }>;
    if (!row) throw new MigrationIdentityError('Cannot read the connecting role. Refusing to run migrations.');
    const roleSplitApplied = row.hasLedger
      ? ((await this.query(`SELECT 1 FROM core.migrations WHERE name = $1`, [ROLE_SPLIT_MIGRATION])) as unknown[]).length > 0
      : false;
    const pending = Math.max(minimumPending, (await this.showMigrations()) ? 1 : 0);
    // Phase A work still to do: loaded migrations (by their 13-digit timestamp suffix) that sort before the role split and
    // are not in the ledger yet.
    const applied = new Set<string>(
      row.hasLedger ? ((await this.query(`SELECT name FROM core.migrations`)) as Array<{ name: string }>).map((r) => r.name) : [],
    );
    const timestampOf = (name: string) => Number(/(\d{13})$/.exec(name)?.[1] ?? Number.MAX_SAFE_INTEGER);
    const splitAt = timestampOf(ROLE_SPLIT_MIGRATION);
    const pendingBeforeRoleSplit = this.migrations.filter((m) => m.name && !applied.has(m.name) && timestampOf(m.name) < splitAt).length;
    assertMigrationIdentity({ ...row, roleSplitApplied, pendingMigrations: pending, pendingBeforeRoleSplit });
  }
}

/**
 * Used by the migration runner (setup-db.ts) and the TypeORM CLI (`migration:run`, `migration:revert`, `migration:generate`).
 * The API and Worker never import this; they use `coreDataSourceOptions` through Nest.
 */
export const coreMigrationDataSource = new GuardedMigrationDataSource(coreMigrationDataSourceOptions);

export default coreMigrationDataSource;
