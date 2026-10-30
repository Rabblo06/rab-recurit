/**
 * Phase B (P7): the one PostgreSQL session advisory lock that serialises every migration run against one database.
 *
 * The lock is taken ON THE MIGRATION CONNECTION ITSELF (the TypeORM query runner the MigrationExecutor then runs every
 * pending migration on), never on a side connection: if that session dies (crash, SIGKILL, pg_terminate_backend, network
 * loss) PostgreSQL rolls back its open migration transaction AND releases the lock in the same instant, so a waiting run can
 * never start while a half-dead holder is still applying DDL. The retired prestart runner held its lock on a separate
 * pg.Client, which serialised prestart runs only against each other and left a check-then-act gap.
 *
 * Key: one fixed 64-bit value in the single-bigint advisory keyspace, 0x637265776d696772 (the ASCII bytes "crewmigr"). A
 * literal, not hashtext(): its value cannot change with a PostgreSQL version. Every other advisory key in this codebase is
 * either an int4 `hashtext(...)` (high 32 bits zero/sign-extended) or a two-int key (a different keyspace, objsubid 2), so it
 * cannot collide with a hashtext key, and a collision with a `hashtextextended(...)` key is a 2^-64 event that would only
 * make one of the two wait.
 *
 * Waiting is bounded: `pg_try_advisory_lock` first; when another run holds it, the holder's pid and application_name are
 * logged, then a blocking `pg_advisory_lock` runs under `lock_timeout` = the wait bound (default 600 s, CREWFLOW_MIGRATION_
 * LOCK_WAIT_SECONDS 1..840, always below the migration statement_timeout of 900 s), with a progress line every 15 s. A wait
 * that runs out fails the run with nothing applied. After acquisition the session's previous lock_timeout is restored
 * exactly, so every migration runs with the lock_timeout it always had (several manage their own; 1786676100000 depends on
 * CONCURRENTLY builds never being cut short by one).
 */
import { DataSource, QueryRunner } from 'typeorm';

export const MIGRATION_LOCK_KEY = 0x637265776d696772n;
export const MIGRATION_APPLICATION_NAME = 'crewflow-migrate';
export const DEFAULT_MIGRATION_LOCK_WAIT_SECONDS = 600;
/** Must stay below MIGRATION_STATEMENT_TIMEOUT_MS (900 s), or statement_timeout would end the wait first with a less clear error. */
export const MAX_MIGRATION_LOCK_WAIT_SECONDS = 840;
const PROGRESS_INTERVAL_MS = 15_000;

export class MigrationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLockError';
  }
}

/** Parses CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS. Unset = default; anything else must be an integer in 1..840 (fail closed). */
export function migrationLockWaitSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIGRATION_LOCK_WAIT_SECONDS;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_MIGRATION_LOCK_WAIT_SECONDS) {
    throw new MigrationLockError(`CREWFLOW_MIGRATION_LOCK_WAIT_SECONDS must be an integer from 1 to ${MAX_MIGRATION_LOCK_WAIT_SECONDS}.`);
  }
  return Number(value);
}

/** pg_locks spells a single-bigint advisory key as classid = high 32 bits, objid = low 32 bits, objsubid = 1. */
export function lockKeyParts(key: bigint = MIGRATION_LOCK_KEY): { classid: string; objid: string } {
  const unsigned = BigInt.asUintN(64, key);
  return { classid: (unsigned >> 32n).toString(), objid: (unsigned & 0xffffffffn).toString() };
}

export interface MigrationLockHolder {
  pid: number;
  applicationName: string | null;
}

/** Who holds the lock right now (another connection of the pool, never the waiting session). Empty when nobody does. */
export async function migrationLockHolders(dataSource: DataSource, key: bigint = MIGRATION_LOCK_KEY): Promise<MigrationLockHolder[]> {
  const { classid, objid } = lockKeyParts(key);
  const rows = (await dataSource.query(
    `SELECT l.pid, a.application_name AS "applicationName"
       FROM pg_catalog.pg_locks l LEFT JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
        AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 1`,
    [classid, objid],
  )) as Array<{ pid: number; applicationName: string | null }>;
  return rows.map((r) => ({ pid: Number(r.pid), applicationName: r.applicationName }));
}

const describeHolders = (holders: MigrationLockHolder[]): string =>
  holders.length ? holders.map((h) => `pid ${h.pid}${h.applicationName ? ` (${h.applicationName})` : ''}`).join(', ') : 'a session that just released it';

/**
 * Takes the migration lock on `queryRunner`'s own session, waiting at most `waitSeconds`. Throws MigrationLockError when the
 * wait runs out. `dataSource` is used only to name the holder in the log (a second pool connection, read-only).
 */
export async function acquireMigrationLock(
  queryRunner: QueryRunner,
  dataSource: DataSource,
  waitSeconds: number,
  log: (message: string) => void,
  key: bigint = MIGRATION_LOCK_KEY,
): Promise<{ waitedMs: number }> {
  const started = Date.now();
  const [first] = (await queryRunner.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint) AS "ok"', [key.toString()])) as Array<{ ok: boolean }>;
  if (first?.ok) return { waitedMs: 0 };

  const holders = await migrationLockHolders(dataSource, key).catch(() => [] as MigrationLockHolder[]);
  log(`another migration run holds the migration lock (${describeHolders(holders)}); waiting up to ${waitSeconds} s. Nothing has been applied by this run.`);
  const progress = setInterval(() => {
    migrationLockHolders(dataSource, key)
      .catch(() => [] as MigrationLockHolder[])
      .then((h) => log(`still waiting for the migration lock after ${Math.round((Date.now() - started) / 1000)} s (held by ${describeHolders(h)})`));
  }, PROGRESS_INTERVAL_MS);
  progress.unref();

  const [{ previous }] = (await queryRunner.query(`SELECT pg_catalog.current_setting('lock_timeout') AS "previous"`)) as Array<{ previous: string }>;
  try {
    await queryRunner.query(`SELECT pg_catalog.set_config('lock_timeout', $1, false)`, [`${waitSeconds * 1000}ms`]);
    await queryRunner.query('SELECT pg_catalog.pg_advisory_lock($1::bigint)', [key.toString()]);
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') {
      throw new MigrationLockError(
        `gave up waiting for the migration lock after ${waitSeconds} s (still held by ${describeHolders(await migrationLockHolders(dataSource, key).catch(() => []))}). ` +
          'Nothing was applied. Let the other run finish, then run again.',
      );
    }
    throw error;
  } finally {
    clearInterval(progress);
  }
  // Restore the session's own lock_timeout exactly: the migrations must run as they always have.
  await queryRunner.query(`SELECT pg_catalog.set_config('lock_timeout', $1, false)`, [previous]);
  return { waitedMs: Date.now() - started };
}

/** Best effort: the lock also ends with the session, which the caller closes right after. */
export async function releaseMigrationLock(queryRunner: QueryRunner, key: bigint = MIGRATION_LOCK_KEY): Promise<boolean> {
  try {
    const [row] = (await queryRunner.query('SELECT pg_catalog.pg_advisory_unlock($1::bigint) AS "released"', [key.toString()])) as Array<{
      released: boolean;
    }>;
    return Boolean(row?.released);
  } catch {
    return false;
  }
}
