import { UnrecoverableError } from 'bullmq';

import type { SecurityAuditSink } from '@rab/server/engine/core-modules/audit-sink/security-audit-sink';
import { AuditLogShippingRow, buildAuditRowSecurityEvent } from '@rab/server/engine/core-modules/audit-events/build-security-audit-event';
import { AUDIT_EVENT_PAYLOAD_KEYS } from '@rab/server/engine/worker-shared/audit-event.contract';

/**
 * Phase X Part 2, X1.1: the Worker side of the off-host copy (Twenty's event-log ingestion: the queued event is written to
 * the configured sink). One job = one committed `core.audit_log` row:
 *   1. the ids-only payload is checked (exactly {organisationId, auditLogId}, both UUIDs) — anything else is failed
 *      without a retry and without a database read;
 *   2. the row is re-read under THAT organisation's tenant context (FORCE RLS, READ ONLY). No row → nothing is shipped:
 *      the business transaction rolled back after the hand-off (e.g. a raw ROLLBACK TO SAVEPOINT), or the payload's
 *      organisation is not the row's (a forged scope sees nothing);
 *   3. the redacted event (build-security-audit-event.ts + the sink's own redaction) is written to the sink. A sink failure
 *      THROWS (policy `refuse`, required in production), so BullMQ retries the job with its backoff
 *      (queue-registry.ts: 10 attempts, exponential from 5 s). Under policy `log` (development) the sink logs and the job
 *      completes.
 * Nothing here touches the action that produced the row: it committed before the job existed.
 */
export type AuditEventShipOutcome = 'shipped' | 'not-found' | 'not-shipped';

export interface AuditEventHandlerDeps {
  /** Reads the row by id under the organisation's tenant context; null when RLS shows no such row. */
  readRow(organisationId: string, auditLogId: string): Promise<AuditLogShippingRow | null>;
  sink: SecurityAuditSink;
  processLabel: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAuditEventJobData(data: unknown): { organisationId: string; auditLogId: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UnrecoverableError('audit event job: the payload must be an object');
  const keys = Object.keys(data).sort();
  if (keys.join(',') !== [...AUDIT_EVENT_PAYLOAD_KEYS].sort().join(',')) throw new UnrecoverableError('audit event job: the payload must carry exactly organisationId and auditLogId');
  const { organisationId, auditLogId } = data as Record<string, unknown>;
  if (typeof organisationId !== 'string' || !UUID.test(organisationId) || typeof auditLogId !== 'string' || !UUID.test(auditLogId)) {
    throw new UnrecoverableError('audit event job: organisationId and auditLogId must be UUIDs');
  }
  return { organisationId, auditLogId };
}

export async function shipAuditEventJob(job: { data: unknown }, deps: AuditEventHandlerDeps): Promise<{ outcome: AuditEventShipOutcome }> {
  const { organisationId, auditLogId } = parseAuditEventJobData(job.data);
  const row = await deps.readRow(organisationId, auditLogId);
  if (!row || row.id !== auditLogId || row.organisation_id !== organisationId) return { outcome: 'not-found' };
  const event = buildAuditRowSecurityEvent(row, deps.processLabel);
  if (!event) return { outcome: 'not-shipped' };
  await deps.sink.emit(event); // throws under `refuse` → BullMQ retries
  return { outcome: 'shipped' };
}

/** The row read, in a READ ONLY transaction bound to the organisation (`runScoped` = runScopedForOrg, workspace null). */
export async function readAuditRowForShipping(
  runScoped: <T>(organisationId: string, fn: (manager: { query<R>(sql: string, params?: unknown[]): Promise<R> }) => Promise<T>) => Promise<T>,
  organisationId: string,
  auditLogId: string,
): Promise<AuditLogShippingRow | null> {
  return runScoped(organisationId, async (manager) => {
    await manager.query('SET TRANSACTION READ ONLY');
    const rows = await manager.query<AuditLogShippingRow[]>(
      `SELECT id::text AS id, organisation_id::text AS organisation_id, actor_user_id::text AS actor_user_id,
              target_user_id::text AS target_user_id, action, entity_type, entity_id::text AS entity_id, metadata, created_at
         FROM core.audit_log
        WHERE id = $1`,
      [auditLogId],
    );
    return rows[0] ?? null;
  });
}
