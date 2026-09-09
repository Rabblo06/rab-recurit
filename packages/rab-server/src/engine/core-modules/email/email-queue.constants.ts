/** Shared between the API process (publisher) and the worker process (consumer) — must match exactly. */
export const EMAIL_QUEUE_NAME = 'rab-email';

export const EMAIL_QUEUE_JOB_NAME = 'send-email';

/**
 * Deliberately minimal payload (A5) — no secrets, no rendered content, no
 * tokens. The worker loads all canonical state fresh from PostgreSQL by
 * `emailOutboxId`; `organisationId` rides along only so the worker can bind
 * proper tenant context (`TenantContextService.runInTenantContext`) without
 * needing any owner/bypass-RLS access of its own for that lookup — see
 * `email-dispatch.job.ts`'s doc comment for why the dispatcher (not the
 * worker) is the one place that's allowed to know about organisationId
 * before binding context.
 */
export interface EmailQueueJobData {
  emailOutboxId: string;
  organisationId: string;
}
