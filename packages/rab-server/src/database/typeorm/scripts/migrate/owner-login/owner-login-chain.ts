/**
 * Owner-login architecture (owner decision 2026-11-04, PR 3 "fresh-install and migration lifecycle"): applying the core chain as ONE login (`crewflow_owner`) on the locked migration session. No
 * migration file is edited; this only decides WHO each historical migration runs as (M0 §5.2 "Then the runner"):
 *
 *   phase A   every pending migration before the role split (CrewflowSingleCredentialRoleArchitecture1786682000000) runs
 *             with `SET ROLE rab_owner` (the database-owner role the historical chain was written for: a superuser- or
 *             crewflow_owner-built phase A would leave crewflow / crewflow_app without table privileges, CF-41). Then the
 *             runner ASSERTS current_user is still rab_owner (no phase-A migration may change the role) and RESETs.
 *   window    while Phase 0b (SecureOwnerCoreSchemaAndHelpers1786721100000) is not applied: GRANT CREATE ON SCHEMA core TO
 *             rab_secure_owner, which the 23 pre-0b hand-overs need (PostgreSQL requires the new owner to hold CREATE on
 *             the schema). SECURITY TRADE-OFF ST-2: VERIFIED to leave no residue (Phase 0b makes rab_secure_owner the owner
 *             of core, so the entry merges into the owner's own privileges).
 *   phase B   everything from the role split on, as crewflow_owner itself, with RANDOM bootstrap passwords that exist
 *             only in this process's memory for this phase and are discarded (crewflow and crewflow_app keep passwords
 *             nobody knows; no process logs in as either).
 *   ROW_COPY  the three migrations no non-BYPASSRLS login can run go through row-copy-shim.ts, ONLY when the caller
 *             proved a fresh install under the lock; otherwise the run refuses before applying anything.
 *
 * Each migration commits with its ledger row exactly as before (TypeORM MigrationExecutor, transaction mode 'each'), so a
 * run killed at any point resumes from the ledger. The gated 1786721330000 is never loaded (gated-migrations/); a chain
 * that contains it is refused.
 */
import { randomBytes } from 'node:crypto';

import type { DataSource, QueryRunner } from 'typeorm';
import { Migration } from 'typeorm/migration/Migration';
import { MigrationExecutor } from 'typeorm/migration/MigrationExecutor';

import { ROLE_SPLIT_MIGRATION } from '../../../core/migration-identity';
import { pendingMigrationNames, Query } from '../locked-migration-runner';
import { OWNER_LOGIN } from './bootstrap';
import { shimMigrationInstance, SHIMMED_MIGRATIONS } from './row-copy-shim';

export const PHASE_0B = 'SecureOwnerCoreSchemaAndHelpers1786721100000';
export const GATED_EXCLUDED_MIGRATION_TIMESTAMP = 1786721330000;
export const ROLE_SPLIT_TIMESTAMP = Number(/(\d{13})$/.exec(ROLE_SPLIT_MIGRATION)![1]);
/** The last of the four role migrations (create roles / set passwords): CREATEROLE is needed until it is applied. */
export const LAST_ROLE_MIGRATION_TIMESTAMP = 1786691000000;

export class OwnerLoginChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerLoginChainError';
  }
}

const timestampOf = (name: string) => Number(/(\d{13})$/.exec(name)?.[1] ?? Number.NaN);

/** A MigrationExecutor over a filtered, optionally re-instanced, subset of the loaded migrations. */
/** One stable, machine-readable line per migration (tests kill at exact points; operators see progress). Never a value. */
export const MIGRATION_EVENT_PREFIX = 'MIGRATION_EVENT';

/** Test seam only (migrate-on-start.ts gates it: NODE_ENV=test, a disposable test database, never production). */
export class InjectedMigrationFailure extends Error {
  constructor(name: string) {
    super(`${name}: failure injected by the test seam CREWFLOW_MIGRATION_TEST_FAIL_AT (rolled back with its transaction)`);
    this.name = 'InjectedMigrationFailure';
  }
}

/**
 * A MigrationExecutor over a filtered, optionally re-instanced, subset of the loaded migrations, logging
 * `MIGRATION_EVENT {"event":"start"|"recorded","name","phase"}` around each one ("recorded" = the ledger row is written in
 * the migration's own transaction, which commits right after; for a transaction=false migration, after its own commits).
 */
class SelectedMigrationExecutor extends MigrationExecutor {
  constructor(
    dataSource: DataSource,
    queryRunner: QueryRunner,
    private readonly select: (migration: Migration) => Migration | null,
    private readonly event: (event: 'start' | 'recorded', name: string) => void,
    private readonly failAt: string | null,
  ) {
    super(dataSource, queryRunner);
  }

  protected override getMigrations(): Migration[] {
    return super
      .getMigrations()
      .map((m) => this.select(m))
      .filter((m): m is Migration => m !== null)
      .map((m) => {
        const inner = m.instance!;
        const event = this.event;
        const failAt = this.failAt;
        const instance = {
          name: inner.name,
          transaction: (inner as { transaction?: boolean }).transaction,
          async up(runner: QueryRunner) {
            event('start', m.name);
            if (failAt === m.name) throw new InjectedMigrationFailure(m.name);
            return inner.up(runner);
          },
          down: (runner: QueryRunner) => inner.down(runner),
        };
        return new Migration(m.id, m.timestamp, m.name, instance as never, m.transaction);
      });
  }

  protected override async insertExecutedMigration(queryRunner: QueryRunner, migration: Migration): Promise<void> {
    await super.insertExecutedMigration(queryRunner, migration);
    this.event('recorded', migration.name);
  }
}

/**
 * Phase B's selection of one loaded migration (pure; exported for its regression spec). Before the split: not phase B.
 * A PENDING ROW_COPY migration is replaced by its shim on a proven fresh install and refused otherwise; every other
 * migration, an already-applied ROW_COPY one included (an existing database transitioned to the owner login), is
 * returned unchanged — TypeORM skips what the ledger has.
 */
export function selectPhaseBMigration(m: Migration, ctx: { pending: ReadonlySet<string>; freshInstall: boolean; shimmed: string[] }): Migration | null {
  if (m.timestamp < ROLE_SPLIT_TIMESTAMP) return null;
  if (!SHIMMED_MIGRATIONS.includes(m.name) || !ctx.pending.has(m.name)) return m;
  if (!ctx.freshInstall || !m.instance) throw new OwnerLoginChainError(`${m.name}: the ROW_COPY shim needs a proven fresh install. Refusing.`);
  ctx.shimmed.push(m.name);
  return new Migration(m.id, m.timestamp, m.name, shimMigrationInstance(m.name, m.instance) as never, m.transaction);
}

export interface OwnerLoginChainOptions {
  dataSource: DataSource;
  session: QueryRunner;
  log: (line: string) => void;
  /** The caller's fresh-install proof (fresh-install.ts) made on this locked session. Only then is the shim used. */
  freshInstall: boolean;
  /**
   * Test seam (golden-equivalence reference build only): run a ROW_COPY migration some other way (the reference chain
   * runs them as a superuser, M0 Agent A replay B). Never set by the production child.
   */
  rowCopyOverride?: (name: string) => Promise<void>;
  /** Test seam (gated by the caller): this migration throws inside its transaction instead of running. */
  testFailAt?: string | null;
  /** Where the role migrations read the bootstrap passwords from (default process.env; the values are random and discarded). */
  env?: NodeJS.ProcessEnv;
}

export interface OwnerLoginChainResult {
  applied: string[];
  phaseA: string[];
  phaseB: string[];
  shimmed: string[];
}

async function currentRole(query: Query): Promise<{ current: string; session: string }> {
  const [row] = (await query(`SELECT current_user::text AS "current", session_user::text AS "session"`)) as Array<{ current: string; session: string }>;
  return row!;
}

export async function runOwnerLoginChain(options: OwnerLoginChainOptions): Promise<OwnerLoginChainResult> {
  const { dataSource, session, log } = options;
  const query: Query = (sql, parameters) => session.query(sql, parameters) as Promise<unknown[]>;
  const env = options.env ?? process.env;
  const loaded = dataSource.migrations.map((m) => m.name || m.constructor.name);
  if (loaded.some((n) => timestampOf(n) === GATED_EXCLUDED_MIGRATION_TIMESTAMP)) {
    throw new OwnerLoginChainError(`migration ${GATED_EXCLUDED_MIGRATION_TIMESTAMP} is loaded; it is gated and must never run. Refusing.`);
  }
  const pending = await pendingMigrationNames(query, dataSource);
  const pendingRowCopy = pending.filter((n) => SHIMMED_MIGRATIONS.includes(n));
  if (pendingRowCopy.length && !options.freshInstall && !options.rowCopyOverride) {
    throw new OwnerLoginChainError(
      `${pendingRowCopy.join(', ')} pending on a database that is not a proven fresh install: they need a SUPERUSER or BYPASSRLS identity, ` +
        'which the owner login never has, and the D3(b) shim is fresh-install only. Nothing was applied. Refusing.',
    );
  }
  const start = await currentRole(query);
  if (start.current !== start.session) throw new OwnerLoginChainError(`the session starts as ${start.current}, not its login. Refusing.`);

  const result: OwnerLoginChainResult = { applied: [], phaseA: [], phaseB: [], shimmed: [] };
  let phase: 'A' | 'B' = 'A';
  const event = (kind: 'start' | 'recorded', name: string) => log(`${MIGRATION_EVENT_PREFIX} ${JSON.stringify({ event: kind, name, phase })}`);
  const run = async (select: (m: Migration) => Migration | null) => {
    const executor = new SelectedMigrationExecutor(dataSource, session, select, event, options.testFailAt ?? null);
    executor.transaction = dataSource.options.migrationsTransactionMode ?? 'each';
    return (await executor.executePendingMigrations()).map((m) => m.name);
  };

  // ── Phase A, as rab_owner ─────────────────────────────────────────────────────────────────────────────────────────
  if (pending.some((n) => timestampOf(n) < ROLE_SPLIT_TIMESTAMP)) {
    await query(`SET ROLE rab_owner`);
    try {
      result.phaseA = await run((m) => (m.timestamp < ROLE_SPLIT_TIMESTAMP ? m : null));
      const after = await currentRole(query);
      if (after.current !== 'rab_owner') throw new OwnerLoginChainError(`phase A ended as ${after.current}, not rab_owner: a phase-A migration changed the role. Refusing.`);
    } finally {
      await query(`RESET ROLE`);
    }
    log(`phase A: ${result.phaseA.length} migration(s) applied as rab_owner`);
  }
  const back = await currentRole(query);
  if (back.current !== back.session || back.session !== start.session) throw new OwnerLoginChainError(`RESET ROLE did not restore ${start.session}. Refusing.`);

  // ── The pre-0b hand-over window ───────────────────────────────────────────────────────────────────────────────────
  const remaining = await pendingMigrationNames(query, dataSource);
  if (remaining.length === 0) return { ...result, applied: [...result.phaseA] };
  if (remaining.includes(PHASE_0B)) {
    const [grant] = (await query(`SELECT has_schema_privilege('rab_secure_owner', 'core', 'CREATE') AS "has"`)) as Array<{ has: boolean }>;
    if (!grant?.has) {
      await query(`GRANT CREATE ON SCHEMA core TO rab_secure_owner`);
      log('ST-2: GRANT CREATE ON SCHEMA core TO rab_secure_owner (for the pre-Phase-0b hand-overs; merges into the owner at Phase 0b)');
    }
  }

  // ── Phase B, as crewflow_owner, random discarded bootstrap passwords ─────────────────────────────────────────────
  phase = 'B';
  const saved = { a: env.CREWFLOW_BOOTSTRAP_PASSWORD, b: env.CREWFLOW_APP_BOOTSTRAP_PASSWORD };
  env.CREWFLOW_BOOTSTRAP_PASSWORD = randomBytes(32).toString('hex');
  env.CREWFLOW_APP_BOOTSTRAP_PASSWORD = randomBytes(32).toString('hex');
  try {
    if (options.rowCopyOverride) {
      // Reference build: apply up to each ROW_COPY migration normally, hand that one to the override, continue.
      for (const name of [...pendingRowCopy].sort((x, y) => timestampOf(x) - timestampOf(y))) {
        const ts = timestampOf(name);
        result.phaseB.push(...(await run((m) => (m.timestamp >= ROLE_SPLIT_TIMESTAMP && m.timestamp < ts ? m : null))));
        await options.rowCopyOverride(name);
        result.phaseB.push(name);
      }
      result.phaseB.push(...(await run((m) => (m.timestamp >= ROLE_SPLIT_TIMESTAMP ? m : null))));
    } else {
      const pendingNow = new Set(await pendingMigrationNames(query, dataSource));
      result.phaseB = await run((m) => selectPhaseBMigration(m, { pending: pendingNow, freshInstall: options.freshInstall, shimmed: result.shimmed }));
    }
  } finally {
    // Discard: neither value is kept, logged or returned.
    if (saved.a === undefined) delete env.CREWFLOW_BOOTSTRAP_PASSWORD;
    else env.CREWFLOW_BOOTSTRAP_PASSWORD = saved.a;
    if (saved.b === undefined) delete env.CREWFLOW_APP_BOOTSTRAP_PASSWORD;
    else env.CREWFLOW_APP_BOOTSTRAP_PASSWORD = saved.b;
  }
  const end = await currentRole(query);
  if (end.current !== OWNER_LOGIN && end.current !== start.session) throw new OwnerLoginChainError(`phase B ended as ${end.current}. Refusing.`);
  log(`phase B: ${result.phaseB.length} migration(s) applied as ${start.session}${result.shimmed.length ? ` (ROW_COPY shim: ${result.shimmed.join(', ')})` : ''}`);
  return { ...result, applied: [...result.phaseA, ...result.phaseB] };
}
