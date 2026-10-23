import { DataSource } from 'typeorm';

import { withAdvisoryLock } from '../../core/locking/advisory-lock';

/**
 * Wave 4/5 — purge of cross-host login handoffs (`core.login_handoff`, DB5 contract §2), requested by the MFA lane.
 *
 * The rows are short-lived single-use security tokens (TTL ≤ 60 s; only a SHA-256 of the token is stored), not business
 * records: keeping them adds exposure (user/session/workspace linkage) and nothing else, so this job is ON by default
 * (`LOGIN_HANDOFF_CLEANUP_ENABLED=true`), unlike the owner-gated outbox retention.
 *
 * DELETION PATH: only DB5's `core.login_handoff_cleanup(p_batch)` — SECURITY DEFINER (owner rab_secure_owner), deletes
 * rows EXPIRED more than 1 h ago OR CONSUMED more than 1 h ago, at most `p_batch` (1..10000) per call, serialised by its
 * own transaction advisory lock. The window is fixed inside the function, never supplied by the caller. `crewflow_app`
 * holds no privilege on the table at all (DB5 REVOKE ALL), so this job cannot delete anything else.
 *
 * MULTI-REPLICA SAFETY: the cycle also holds a session advisory lock (`crewflow:login-handoff-cleanup:v1`) on the direct
 * crewflow_app connection, so a second replica skips the whole cycle instead of queueing behind the function's lock.
 * BOUNDED: ≤ `maxBatches` calls per cycle. A database that predates the LoginHandoff migration → `null` (no-op).
 */
export const LOGIN_HANDOFF_CLEANUP_LOCK = 'crewflow:login-handoff-cleanup:v1';
const BATCH = 1000;

export interface LoginHandoffCleanupConfig {
  enabled: boolean;
  /** Calls per cycle (each deletes ≤ 1000 rows). */
  maxBatches?: number;
  batchSize?: number;
}

export type LoginHandoffCleanupResult =
  | { ran: true; rowsDeleted: number; batches: number }
  | { ran: false; skipped: 'disabled' | 'locked' | 'not-installed' };

export async function runLoginHandoffCleanupCycle(
  runtimeDataSource: DataSource,
  lockDataSource: DataSource,
  config: LoginHandoffCleanupConfig,
): Promise<LoginHandoffCleanupResult> {
  if (!config.enabled) return { ran: false, skipped: 'disabled' };
  const [probe] = await runtimeDataSource.query<Array<{ p: string | null }>>(`SELECT to_regprocedure('core.login_handoff_cleanup(integer)')::text AS p`);
  if (!probe?.p) return { ran: false, skipped: 'not-installed' };
  const batchSize = Math.min(Math.max(config.batchSize ?? BATCH, 1), 10_000);
  const maxBatches = Math.max(config.maxBatches ?? 20, 1);

  const locked = await withAdvisoryLock(lockDataSource, LOGIN_HANDOFF_CLEANUP_LOCK, async () => {
    let rowsDeleted = 0;
    let batches = 0;
    for (;;) {
      const [row] = await runtimeDataSource.query<Array<{ rows_deleted: number }>>(`SELECT rows_deleted FROM core.login_handoff_cleanup($1::integer)`, [batchSize]);
      const n = Number(row?.rows_deleted ?? 0);
      rowsDeleted += n;
      batches += 1;
      if (n < batchSize || batches >= maxBatches) break;
    }
    return { rowsDeleted, batches };
  });
  if (!locked.acquired) return { ran: false, skipped: 'locked' };
  return { ran: true, ...locked.value };
}
