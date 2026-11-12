import { UnrecoverableError } from 'bullmq';

import type { SecurityAuditSink } from '@rab/server/engine/core-modules/audit-sink/security-audit-sink';
import { AuditLogShippingRow, buildAuditRowSecurityEvent, buildLoginFailedSecurityEvent, LoginFailureReason } from '@rab/server/engine/core-modules/audit-events/build-security-audit-event';
import { AUDIT_EVENT_PAYLOAD_KEYS, AUDIT_PREAUTH_PAYLOAD_KEYS } from '@rab/server/engine/worker-shared/audit-event.contract';

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

const PREAUTH_REASONS = new Set(['invalid_credentials', 'ambiguous_accounts', 'provider_sign_in_refused']);
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * X1.1 (owner decision 2026-11-12 b): a pre-authentication failed login, queued by the API as a SYSTEM-scoped job of this
 * queue. Checked strictly (exactly the contract's keys, known reason, short codes, a sane time); anything else fails
 * without a retry. The address is masked again (idempotent) and the sink's redaction applies as for every event.
 */
export function parseAuditPreAuthJobData(data: unknown): { reason: LoginFailureReason; provider: string; providerReason?: string; email: string; at: number } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new UnrecoverableError('pre-auth audit job: the payload must be an object');
  const d = data as Record<string, unknown>;
  const allowed = new Set<string>(AUDIT_PREAUTH_PAYLOAD_KEYS);
  if (Object.keys(d).some((k) => !allowed.has(k))) throw new UnrecoverableError('pre-auth audit job: unexpected payload key');
  const at = d.at;
  if (d.v !== 1 || typeof d.reason !== 'string' || !PREAUTH_REASONS.has(d.reason)) throw new UnrecoverableError('pre-auth audit job: unknown version or reason');
  if (typeof d.provider !== 'string' || !CODE.test(d.provider)) throw new UnrecoverableError('pre-auth audit job: invalid provider');
  if (d.providerReason !== undefined && (typeof d.providerReason !== 'string' || !CODE.test(d.providerReason))) throw new UnrecoverableError('pre-auth audit job: invalid provider reason');
  if (typeof d.email !== 'string' || d.email.length > 128) throw new UnrecoverableError('pre-auth audit job: invalid masked address');
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 1_500_000_000_000 || at > 4_000_000_000_000) throw new UnrecoverableError('pre-auth audit job: invalid time');
  return { reason: d.reason as LoginFailureReason, provider: d.provider, ...(d.providerReason ? { providerReason: d.providerReason as string } : {}), email: d.email, at };
}

export async function shipPreAuthEventJob(job: { data: unknown }, deps: { sink: SecurityAuditSink }): Promise<{ outcome: AuditEventShipOutcome }> {
  const p = parseAuditPreAuthJobData(job.data);
  const event = buildLoginFailedSecurityEvent({ email: p.email, reason: p.reason, provider: p.provider, detailReason: p.providerReason, occurredAt: p.at }, 'api');
  await deps.sink.emit(event); // throws under `refuse` → BullMQ retries
  return { outcome: 'shipped' };
}
