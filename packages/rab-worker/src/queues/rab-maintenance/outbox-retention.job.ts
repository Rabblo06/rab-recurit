import { DataSource, EntityManager } from 'typeorm';

import { storageScopes } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { withAdvisoryLock } from '../../core/locking/advisory-lock';
import { runScopedForOrg } from '../../core/database/scoped-job';

/**
 * Wave 5 lane OPS (G6) — retention for TERMINAL outbox/event rows.
 *
 * OWNER DECISION PENDING: the retention periods are not decided. This job therefore ships:
 *   - OFF (`OUTBOX_RETENTION_ENABLED=false`, the default): the cycle returns immediately — no query, no delete;
 *   - in REPORT mode when switched on (`OUTBOX_RETENTION_MODE=report`, the default): it only COUNTS what a purge would
 *     delete, per table, and logs the totals. Nothing is deleted until an operator sets `OUTBOX_RETENTION_MODE=purge`.
 *   - with SUGGESTED periods (env defaults, labelled suggestions in WAVE5_LANE_OPS_REPORT.md): email 90 d, push 30 d,
 *     realtime 7 d, worker_event 30 d. The env validator refuses anything below DB5's floors (email/push/worker_event
 *     30 d, realtime 7 d) and the database functions refuse them again (SQLSTATE 22023) — two layers, same floor.
 *
 * DELETION PATH: only lane DB5's narrow functions (`core.purge_terminal_<table>(p_retention, p_batch)`, contract §5).
 * `crewflow_app` has no DELETE on these tables at all (REVOKEd by the same migration); the functions re-check the
 * terminal-status predicate under the row lock, so a PENDING/RETRY/PROCESSING row is never deleted. Each call runs
 * inside a tenant context bound by `TenantContextService` (FORCE RLS still applies inside the functions):
 *   - email_outbox / push_delivery: organisation-only policies → one scope per organisation;
 *   - realtime_event / worker_event: workspace-tagged rows are visible only with `rab.workspace_id` bound → the
 *     organisation scope plus every (organisation, workspace) scope (`storageScopes`, the same enumeration the
 *     realtime publisher uses).
 *
 * MULTI-REPLICA SAFETY: the whole cycle runs under one session advisory lock on the direct connection
 * (`withAdvisoryLock`, non-blocking): a second replica skips the cycle. Even without it two replicas could not
 * double-delete (FOR UPDATE SKIP LOCKED inside the functions) — the lock just avoids duplicated scans.
 *
 * BOUNDED WORK: at most `maxBatchesPerScope` × `batchSize` rows per (table, scope) per cycle; a backlog drains over
 * successive cycles.
 */
export const OUTBOX_RETENTION_LOCK = 'crewflow:outbox-retention:v1';

export type OutboxRetentionTable = 'email_outbox' | 'push_delivery' | 'realtime_event' | 'worker_event';

export interface OutboxRetentionConfig {
  enabled: boolean;
  mode: 'report' | 'purge';
  /** Days per table (already validated ≥ the DB floors by the env validator). */
  days: Record<OutboxRetentionTable, number>;
  batchSize: number;
  maxBatchesPerScope: number;
}

export interface OutboxRetentionResult {
  ran: boolean;
  /** Why the cycle did nothing: the flag is off, or another replica holds the lock. */
  skipped?: 'disabled' | 'locked';
  mode?: 'report' | 'purge';
  /** report: rows a purge would delete; purge: rows deleted. */
  rows: Record<OutboxRetentionTable, number>;
  scopes: number;
  /** Tables/scopes that stopped at maxBatchesPerScope with more rows left (drains next cycle). */
  truncated: number;
}

/** DB5 contract §5 floors — duplicated here only to fail fast with a clear message; the database is the authority. */
export const OUTBOX_RETENTION_MINIMUM_DAYS: Readonly<Record<OutboxRetentionTable, number>> = {
  email_outbox: 30,
  push_delivery: 30,
  realtime_event: 7,
  worker_event: 30,
};

/** Owner-decision placeholders (G6) — NOT decisions. Mirrors the env defaults. */
export const OUTBOX_RETENTION_SUGGESTED_DAYS: Readonly<Record<OutboxRetentionTable, number>> = {
  email_outbox: 90,
  push_delivery: 30,
  realtime_event: 7,
  worker_event: 30,
};

interface TableSpec {
  table: OutboxRetentionTable;
  purgeFn: string;
  /** Count predicate for REPORT mode — the same terminal statuses and age expression as the DB5 function. */
  countSql: string;
  /** Needs the per-workspace scopes as well as the organisation scope. */
  workspaceTagged: boolean;
}

const TABLES: readonly TableSpec[] = [
  {
    table: 'email_outbox',
    purgeFn: 'core.purge_terminal_email_outbox',
    countSql: `SELECT count(*)::int AS n FROM core.email_outbox
                WHERE status IN ('SENT', 'FAILED', 'CANCELLED')
                  AND coalesce(sent_at, failed_at, cancelled_at, updated_at) < now() - make_interval(days => $1)`,
    workspaceTagged: false,
  },
  {
    table: 'push_delivery',
    purgeFn: 'core.purge_terminal_push_delivery',
    countSql: `SELECT count(*)::int AS n FROM core.push_delivery
                WHERE status IN ('ACCEPTED', 'FAILED', 'CANCELLED')
                  AND coalesce(accepted_at, failed_at, cancelled_at, updated_at) < now() - make_interval(days => $1)`,
    workspaceTagged: false,
  },
  {
    table: 'realtime_event',
    purgeFn: 'core.purge_terminal_realtime_event',
    countSql: `SELECT count(*)::int AS n FROM core.realtime_event
                WHERE status IN ('completed', 'failed', 'cancelled')
                  AND coalesce(processed_at, last_error_at, updated_at) < now() - make_interval(days => $1)
                  AND workspace_id IS NOT DISTINCT FROM core.current_workspace()`,
    workspaceTagged: true,
  },
  {
    table: 'worker_event',
    purgeFn: 'core.purge_terminal_worker_event',
    countSql: `SELECT count(*)::int AS n FROM core.worker_event
                WHERE status IN ('completed', 'failed', 'cancelled')
                  AND coalesce(processed_at, last_error_at, updated_at) < now() - make_interval(days => $1)
                  AND workspace_id IS NOT DISTINCT FROM core.current_workspace()`,
    workspaceTagged: true,
  },
];

function emptyRows(): Record<OutboxRetentionTable, number> {
  return { email_outbox: 0, push_delivery: 0, realtime_event: 0, worker_event: 0 };
}

/** Throws (refuses the cycle) on a configuration the database would refuse anyway — never silently clamps. */
export function assertOutboxRetentionConfig(config: OutboxRetentionConfig): void {
  for (const spec of TABLES) {
    const days = config.days[spec.table];
    if (!Number.isInteger(days) || days < OUTBOX_RETENTION_MINIMUM_DAYS[spec.table]) {
      throw new Error(`outbox retention: ${spec.table} retention ${days} d is below the ${OUTBOX_RETENTION_MINIMUM_DAYS[spec.table]} d floor`);
    }
  }
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 10_000) throw new Error('outbox retention: batch size must be 1..10000');
  if (!Number.isInteger(config.maxBatchesPerScope) || config.maxBatchesPerScope < 1) throw new Error('outbox retention: maxBatchesPerScope must be ≥ 1');
  if (config.mode !== 'report' && config.mode !== 'purge') throw new Error('outbox retention: mode must be report or purge');
}

/**
 * One retention cycle. `runtimeDataSource` = pooled crewflow_app (every tenant-bound call); `lockDataSource` = the direct
 * crewflow_app connection (session advisory lock needs connection affinity — see advisory-lock.ts).
 */
export async function runOutboxRetentionCycle(
  runtimeDataSource: DataSource,
  lockDataSource: DataSource,
  tenantContext: TenantContextService,
  config: OutboxRetentionConfig,
): Promise<OutboxRetentionResult> {
  if (!config.enabled) return { ran: false, skipped: 'disabled', rows: emptyRows(), scopes: 0, truncated: 0 };
  assertOutboxRetentionConfig(config);

  const locked = await withAdvisoryLock(lockDataSource, OUTBOX_RETENTION_LOCK, async () => {
    const rows = emptyRows();
    let scopes = 0;
    let truncated = 0;
    for await (const scope of storageScopes(runtimeDataSource)) {
      scopes += 1;
      for (const spec of TABLES) {
        if (scope.workspaceId !== null && !spec.workspaceTagged) continue;
        const days = config.days[spec.table];
        if (config.mode === 'report') {
          const [row] = await runScopedForOrg(tenantContext, scope.organisationId, scope.workspaceId, async (manager) => {
            await manager.query('SET TRANSACTION READ ONLY');
            return manager.query<Array<{ n: number }>>(spec.countSql, [days]);
          });
          rows[spec.table] += Number(row?.n ?? 0);
          continue;
        }
        let batches = 0;
        for (;;) {
          const deleted = await runScopedForOrg(tenantContext, scope.organisationId, scope.workspaceId, (manager) =>
            purgeOnce(manager, spec.purgeFn, days, config.batchSize),
          );
          rows[spec.table] += deleted;
          batches += 1;
          if (deleted < config.batchSize) break;
          if (batches >= config.maxBatchesPerScope) {
            truncated += 1;
            break;
          }
        }
      }
    }
    return { rows, scopes, truncated };
  });

  if (!locked.acquired) return { ran: false, skipped: 'locked', rows: emptyRows(), scopes: 0, truncated: 0 };
  return { ran: true, mode: config.mode, ...locked.value };
}

async function purgeOnce(manager: EntityManager, fn: string, days: number, batch: number): Promise<number> {
  // `fn` is one of four fixed identifiers from TABLES above — never caller input.
  const rows: Array<{ n: number }> = await manager.query(`SELECT ${fn}(make_interval(days => $1), $2::integer) AS n`, [days, batch]);
  return Number(rows[0]?.n ?? 0);
}
