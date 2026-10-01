import { DataSource } from 'typeorm';

export type AdvisoryLockResult<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Per-resource, session-level PostgreSQL advisory lock for work that is too
 * long to hold a transaction open (a Playwright PDF render + email enqueue).
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
 *  - requires a DIRECT connection: the worker's owner DataSource is built from
 *    DATABASE_URL_UNPOOLED — behind a transaction-mode pooler session locks
 *    would not hold, so this must never be pointed at a pooled URL.
 *
 * Callers must STILL re-verify the work is needed after acquiring the lock
 * (another worker may have finished between this worker's scan and now) and
 * gate the externally visible side effect (the email) on a compare-and-set.
 */
export async function withAdvisoryLock<T>(dataSource: DataSource, name: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
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
