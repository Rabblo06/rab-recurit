import type { Client } from 'pg';
import { DataSource } from 'typeorm';

import { assertRuntimeDbRole } from '@rab/server/engine/utils/assert-runtime-db-role';
import { ReconnectingPgClient } from '../database/reconnecting-pg-client';
import type { AdvisoryLockResult } from './advisory-lock';

/**
 * Per-scan cluster lock for `WORKER_SCHEDULER=bullmq` (Lane A M3): at most ONE replica runs a given scan at a time,
 * even when a BullMQ job is delivered twice (stalled-job recovery, a slow scan outliving its interval, a reconcile
 * re-upsert racing a pickup).
 *
 *  - Non-blocking `pg_try_advisory_lock`: the loser skips (counted as `<loop>Skipped`, never stamped as a success).
 *  - SEPARATE key namespace — `hashtextextended('crewflow:scan-lock:v1:' || schedulerId, 0)` — distinct from every
 *    inner lock the cycles take themselves (`shift_report:<id>`, `final_timesheet:<id>`, `crewflow:login-handoff-cleanup:v1`,
 *    `crewflow:outbox-retention:v1`, `hashtext('rab_account_invite_cleanup')`), which all stay exactly as they are.
 *  - ONE dedicated connection per replica (`ReconnectingPgClient`, `crewflow_app`, direct URL), never a connection from
 *    `directDataSource`'s pool: the cycles that take inner session locks borrow from that pool, so outer locks held on
 *    pool connections could starve it (20 outer holders vs 10 connections → inner acquires wait forever). A session
 *    lock needs connection affinity, which a dedicated client gives for free.
 *  - Crash-safe: Postgres releases session locks when the session ends, so a killed replica never wedges a scan. If the
 *    lock connection drops mid-scan the lock is released early; the cycles' own protections (SKIP LOCKED claims, CAS,
 *    generations, worker_event idempotency, inner locks) still make an overlapping run correct — it is only wasted work.
 *  - Fails closed: if the lock connection cannot be (re)established the scan is NOT run unlocked; the job fails and is
 *    counted as a failure (the database is unreachable anyway).
 */
export const SCAN_LOCK_NAMESPACE = 'crewflow:scan-lock:v1:';

export const scanLockName = (schedulerId: string): string => `${SCAN_LOCK_NAMESPACE}${schedulerId}`;

export interface ScanLockLogger {
  log(message: string): void;
  warn(message: string): void;
}

export class ScanLock {
  private held = 0;
  // pg 8 queues concurrent queries on one client but deprecates it (removed in pg 9): serialise lock calls ourselves.
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  constructor(
    private readonly connection: ReconnectingPgClient,
    private readonly logger: ScanLockLogger,
  ) {}

  /** Builds the dedicated lock connection (crewflow_app, direct) and verifies its identity with the shared runtime role guard. */
  static async open(url: string, logger: ScanLockLogger): Promise<ScanLock> {
    const connection = new ReconnectingPgClient(
      // Short statement/query timeouts: lock calls are instantaneous; a hung one must not queue every other scan behind it.
      { connectionString: url, keepAlive: true, connectionTimeoutMillis: 10_000, statement_timeout: 5_000, query_timeout: 5_000 },
      { label: 'scan-lock', logger, initialBackoffMs: 1_000, maxBackoffMs: 30_000 },
    );
    try {
      const client = await connection.acquire();
      const shim = { query: async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows } as unknown as DataSource;
      await assertRuntimeDbRole(shim, 'worker-scan-lock');
    } catch (error) {
      await connection.close();
      throw error;
    }
    return new ScanLock(connection, logger);
  }

  get heldCount(): number {
    return this.held;
  }

  async run<T>(schedulerId: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>> {
    const name = scanLockName(schedulerId);
    const { client, locked } = await this.serial(async () => {
      const c: Client = await this.connection.acquire();
      const [row] = (await c.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [name])).rows;
      return { client: c, locked: row?.locked === true };
    });
    if (!locked) return { acquired: false };
    this.held += 1;
    try {
      return { acquired: true, value: await work() };
    } finally {
      this.held -= 1;
      await this.serial(async () => {
        if (!this.connection.isCurrent(client)) return;
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [name]);
      }).catch((error: Error) => {
        // The session is going away; the server releases the lock with it.
        this.logger.warn(`scan lock release for ${schedulerId} failed (${error.message}); it is released with the session`);
      });
      // Otherwise the session that held the lock is gone and the server already released it — never unlock on a new one.
    }
  }

  /** Closing the session releases every scan lock this replica holds. Never throws. */
  async close(): Promise<void> {
    await this.connection.close();
  }
}
