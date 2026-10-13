/** Shared between the API process (publisher) and the worker process (consumer) — must match exactly. */
export const PUSH_QUEUE_NAME = 'rab-push';

export const PUSH_QUEUE_JOB_NAME = 'send-push';

/**
 * Deliberately minimal payload (same reasoning as `EmailQueueJobData`) — no device token, no
 * notification content. The worker loads all canonical state fresh from PostgreSQL by
 * `pushDeliveryId`; `organisationId` rides along only so the worker can bind tenant context
 * without owner/bypass-RLS access.
 */
export interface PushQueueJobData {
  pushDeliveryId: string;
  organisationId: string;
}
