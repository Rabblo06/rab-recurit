/**
 * Phase X Part 2, X1.1 (owner decision 2026-11-12, "Twenty's event-log style"): the OFF-HOST COPY of security audit events.
 * Pure constants (no Nest, no Redis, no BullMQ runtime import, no `modules/` import), shared by the producer
 * (engine/core-modules/audit-events/audit-event-queue.service.ts, in the API, the Worker and the CLI), the Worker consumer
 * and the queue registry.
 *
 * The flow (Twenty's event-logs: the event is built after the action, handed to a queue, and a sink writes it):
 *   1. `AuditService.record` (and the few raw audit-table writers, listed in security-audit-event-catalogue.spec.ts) write the row inside the business
 *      transaction, exactly as before. `core.audit_log` stays the record.
 *   2. AFTER COMMIT (the engine AfterCommitPublisher) one job is added to `crewflow-audit-events` for a row whose action is
 *      in the security catalogue (security-audit-event-catalogue.ts). The payload is identifiers only.
 *   3. The Worker re-reads that row under the organisation's tenant context (FORCE RLS) and writes the redacted event to
 *      the configured sink (security-audit-sink.ts: stdout in production). A sink failure fails the JOB, and BullMQ retries
 *      it; the action was committed long before and is never touched.
 *
 * BEST EFFORT (accepted by the owner 2026-11-12): an event is lost when Redis or the sink fails beyond the retries, or the
 * process dies between the commit and the publish; and because the Worker ships what the row says WHEN IT READS IT, an
 * owner-login holder can alter a row before it is shipped. Nothing in this chain blocks, delays or rolls back an action.
 */

/** Legacy `bull` prefix like every consumer queue (the API produces with no prefix configuration). A NEW queue name. */
export const AUDIT_EVENT_QUEUE_NAME = 'crewflow-audit-events';

/** The one job name. */
export const AUDIT_EVENT_JOB_NAME = 'audit-event-ship';

/** Every top-level payload key a job may carry: two identifiers, nothing else (never the action, metadata or a person). */
export const AUDIT_EVENT_PAYLOAD_KEYS = Object.freeze(['organisationId', 'auditLogId'] as const);

export interface AuditEventJobData {
  organisationId: string;
  /** `core.audit_log.id` of the committed row. */
  auditLogId: string;
}

/** Deterministic: a second publish for the same row (a retry of the producer) is a BullMQ no-op. */
export const auditEventJobId = (auditLogId: string): string => `audit-event.${auditLogId}`;

/**
 * X1.1 owner decision 2026-11-12 (b): the pre-authentication FAILED LOGIN (no audit row, no organisation) also rides this
 * queue, as a SYSTEM-scoped job (registry `systemScopedJobs`). Its payload is small scalars only: the already-masked
 * address (`a***@domain` / `[not-an-email]`), the reason and provider codes and the time — never a password, a raw
 * address, an IP or a user id. jobId `audit-preauth.<random uuid>` (every failure is its own event).
 */
export const AUDIT_PREAUTH_JOB_NAME = 'audit-preauth-login-failed';
export const AUDIT_PREAUTH_PAYLOAD_KEYS = Object.freeze(['v', 'reason', 'provider', 'providerReason', 'email', 'at'] as const);

export interface AuditPreAuthJobData {
  v: 1;
  reason: 'invalid_credentials' | 'ambiguous_accounts' | 'provider_sign_in_refused';
  provider: string;
  providerReason?: string;
  /** Masked by maskEmailForAudit before it is queued, at most 128 characters. */
  email: string;
  /** Epoch milliseconds of the failure. */
  at: number;
}

export const auditPreAuthJobId = (id: string): string => `audit-preauth.${id}`;

/**
 * The owner's guard: above this audit-queue backlog (waiting + delayed + prioritized jobs), NEW failed-login events are
 * dropped and counted (visible on the platform-admin Health tab). Every other audit event is unaffected.
 */
export const AUDIT_PREAUTH_BACKLOG_LIMIT = 10_000;
/** How long one backlog reading is reused (one Redis count per process per interval, never one per login). */
export const AUDIT_BACKLOG_CACHE_MS = 2_000;
/** Redis key of the durable drop total (INCRBY, batched per backlog refresh). A dedicated key; nothing else is touched. */
export const auditPreAuthDropsKey = (nodeEnv: string): string => `crewflow:${nodeEnv}:audit-events:preauth-login-dropped`;
