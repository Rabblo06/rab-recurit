import { EntityManager } from 'typeorm';

/**
 * The one, uniform way every worker automation proves "have I already
 * processed this occurrence" — replacing "does a visible Notification row
 * already exist" (defeated whenever every recipient has disabled in-app
 * notifications for that type, since `NotificationService.notify()` only
 * inserts a `Notification` row `if (inAppEnabled)`). A user's notification
 * preference must never be able to make the worker re-process the same
 * event forever; whether a human SEES the result and whether the worker
 * CONSIDERS it done are now two separate concerns, backed by two separate
 * tables (`core.notification` / `core.worker_event`).
 *
 * `event_key` is the actual cross-replica deduplication authority — a real
 * `UNIQUE` constraint (`WorkerEventSchema1786673200000`), never a
 * SELECT-then-INSERT. Two replicas (or two overlapping ticks on the same
 * replica) racing to claim the same `event_key` both attempt the INSERT
 * below; the loser gets zero rows back from `ON CONFLICT ... DO NOTHING
 * RETURNING id`, which this module surfaces as `null` — a normal, expected
 * "someone else already has this," never an error. Same idiom this
 * codebase already established for `replacement_request.
 * declined_shift_assignment_id UNIQUE` + `ON CONFLICT DO NOTHING`.
 *
 * Deliberately NOT a `PROCESSING`/lease-based claim for the jobs this
 * module currently serves (late clock-in, manager-confirmation-timeout,
 * shift reminders, no-show, missing-clock-out): every one of them does its
 * entire unit of work — reload the row, revalidate the business condition,
 * notify, audit, mark complete/cancelled — inside the SAME `runScopedForOrg`
 * transaction as the claiming INSERT. If anything in that unit throws, the
 * whole transaction (the INSERT included) rolls back, so the event simply
 * ceases to exist and is naturally reclaimed on the job's next tick — a
 * transient-failure retry with no separate lease/attempt bookkeeping
 * needed. This is a deliberate choice, not a gap: none of these jobs holds
 * a claim across more than one DB transaction, so a `PROCESSING` state with
 * a reclaimable lease would be complexity with nothing to protect against.
 * The schema still carries `processing`/`retry`/`failed`/`attempt_count`/
 * `claim_token` for a future job that genuinely does span multiple
 * transactions (e.g. one involving a slow external call) — this module can
 * grow a `claimForProcessing`/`markRetry` pair against the same table
 * without another migration when that need arrives.
 */
export interface WorkerEventClaimParams {
  organisationId: string;
  /** Null for a genuinely org-wide event; the RLS policy treats NULL as "matches any workspace in the org," never as "exempt from tenant isolation." */
  workspaceId: string | null;
  /** Stable and deterministic per logical occurrence — include a version/timestamp component wherever the same entity can legitimately re-trigger the same event type (e.g. `manager-confirmation-timeout:{offerId}:{deadlineIso}`). */
  eventKey: string;
  eventType: string;
  entityType: string;
  entityId: string;
}

/** Attempts to claim `params.eventKey`. Returns the new event's id on a successful claim, or `null` if another replica/tick already holds it (already processing, already completed, or already cancelled — the caller does not need to distinguish which). */
export async function claimWorkerEvent(manager: EntityManager, params: WorkerEventClaimParams): Promise<string | null> {
  const rows = await manager.query<Array<{ id: string }>>(
    `INSERT INTO core.worker_event (organisation_id, workspace_id, event_key, event_type, entity_type, entity_id, status, claimed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [params.organisationId, params.workspaceId, params.eventKey, params.eventType, params.entityType, params.entityId],
  );
  return rows[0]?.id ?? null;
}

/** The business condition held; side effects (notify/audit) ran. Marks the event durably done so it is never reprocessed, independent of whether any Notification row or email was actually delivered. */
export async function completeWorkerEvent(manager: EntityManager, eventId: string): Promise<void> {
  await manager.query(`UPDATE core.worker_event SET status = 'completed', processed_at = now(), updated_at = now() WHERE id = $1`, [eventId]);
}

/** The business condition stopped holding between discovery and claim (e.g. the shift was cancelled, the assignment moved on) — a genuine, permanent, non-retryable exit. No side effects run; `reason` is a short machine-readable code, never free text (mirrors `AuditService`'s own metadata convention), for later diagnosis without re-deriving the original scan. */
export async function cancelWorkerEvent(manager: EntityManager, eventId: string, reason: string): Promise<void> {
  await manager.query(
    `UPDATE core.worker_event SET status = 'cancelled', processed_at = now(), updated_at = now(), last_error_code = $2 WHERE id = $1`,
    [eventId, reason],
  );
}
