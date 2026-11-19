import { DataSource } from 'typeorm';

export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Per-resource, session-level PostgreSQL advisory lock for work that is too
 * long to hold a transaction open (a PDF render + email enqueue).
 *
 * WHY this and not `pg_advisory_xact_lock` in the scan transaction: an xact
 * lock is released the instant that scan transaction commits, i.e. BEFORE any
 * candidate is processed, so it only serialises the *discovery* query — two
 * workers (or one worker whose 5-minute tick overlaps itself) could both pick
 * the same report, both render, and both enqueue an email. This lock is held
 * for the whole per-candidate unit of work.
 *
 * Properties that make it the smallest correct mechanism here:
 *  - non-blocking (`pg_try_advisory_lock`): a worker that loses simply skips
 *    the candidate — the winner is already doing it;
 *  - crash-safe: a session lock is released by Postgres when the connection
 *    dies, so a killed worker can never leave a report stuck behind a stale
 *    lease (no lease table, no TTL to tune, no migration);
 *  - requires a DIRECT connection: callers pass the jobs process's
 *    `directDataSource` (restricted crewflow_app, DATABASE_DIRECT_URL falling
 *    back to DATABASE_URL — never DATABASE_URL_UNPOOLED, which the jobs process
 *    refuses to hold). Behind a transaction-mode pooler session locks would not
 *    hold, so this must never be pointed at a pooled URL. (The BullMQ per-scan
 *    lock is separate: its own dedicated connection and key namespace, see
 *    scan-lock.ts.)
 *
 * Callers must STILL re-verify the work is needed after acquiring the lock
 * (another worker may have finished between this worker's scan and now) and
 * gate the externally visible side effect (the email) on a compare-and-set.
 */
export async function withAdvisoryLock<T>(dataSource: DataSource, name: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
  // Transaction pooler support (PG_DATABASE_SESSION_URL): the runtime DataSource may then be transaction-scoped (every
  // statement in its own transaction, any backend). A session lock there would not hold: refused before any statement.
  // The marker is the factory's TransactionScopedClient (rab-server database/postgres/transaction-scoped-client.ts).
  const pool = (dataSource.driver as unknown as { master?: { options?: { Client?: { transactionScoped?: boolean } } } }).master;
  if (pool?.options?.Client?.transactionScoped === true) {
    throw new Error('withAdvisoryLock: a session advisory lock needs the direct session DataSource, not the transaction-pooled runtime one. Refusing.');
  }
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    const [{ locked }] = await queryRunner.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`, [name]);
    if (!locked) return { acquired: false };
    try {
      return { acquired: true, value: await work() };
    } finally {
      await queryRunner.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [name]);
    }
  } finally {
    await queryRunner.release();
  }
}
