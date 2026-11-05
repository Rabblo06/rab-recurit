import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { organisationIds } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { noteLegacyBatchLimitReached } from '../../core/wake/legacy-batch-limit';

const BATCH_SIZE = 50;
const logger = new Logger('PushDispatch');
// A push send (one HTTP call to FCM) completes in low single-digit seconds — same reasoning as
// email's own PROCESSING_LEASE_MINUTES: generous enough that a genuinely slow-but-alive attempt
// is never wrongly reclaimed, short enough that a dead worker's claim doesn't stall a delivery long.
const PROCESSING_LEASE_MINUTES = 10;
const RETRY_STALE_MINUTES = 5;
/**
 * Lead follow-up (C-report §6.2, mirrors email's QUEUED rule): a PENDING row whose first publish (`queued_at`) is older
 * than this has evidently not been consumed — its `.attempt.<gen>` job is lost, or retained in a terminal state (e.g. an
 * E8 not-visible job that exhausted its attempts), and BullMQ silently drops a re-add of a retained jobId. Such a row is
 * recovered with a generation bump so its re-publish gets a fresh jobId. Same 2 minutes as email.
 */
const PENDING_STALE_MINUTES = 2;

interface ClaimedRow {
  id: string;
  organisation_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  provider_call_started_at: Date | null;
  dispatch_generation: number;
  queued_at: Date | null;
  /** Computed by the database clock in the claim: PENDING and first published more than PENDING_STALE_MINUTES ago. */
  stale_pending: boolean;
}

export interface PushDispatchResult {
  claimed: number;
  published: number;
  recovered: number;
  failedExhausted: number;
  deliveryUncertain: number;
  /**
   * Phase D-Q3 (audit §13 #5): publishes that threw (Redis down/slow). Caught PER ROW — the rest of the cycle carries on.
   * The row's `queued_at` stamp is withdrawn (fenced) so the next tick publishes it again, as before the fix. per_scope
   * only: in global claim mode a publish error propagates exactly as before (release with the 15 s retry).
   */
  publishFailed?: number;
  /** The first publish error's name this cycle (for the one summary warning). */
  lastPublishError?: string;
}

/**
 * The dispatcher half of the push transactional outbox — mirrors `email-dispatch.job.ts` exactly
 * (same claim SQL shape, same stuck-PROCESSING/stuck-RETRY recovery, same generation-bump-before-
 * republish fix for the "old BullMQ job's terminal state blocks a new attempt" bug, same
 * ambiguous-delivery-safety gate before ever republishing a row whose provider call already
 * durably started). See that file's own doc comment for the full reasoning — not re-derived here.
 *
 * Deliberately independent of Redis Pub/Sub / the real-time outbox in every respect: this reads
 * straight from `core.push_delivery`, created durably by `PushDeliveryService` inside the SAME
 * transaction as the `Notification` row. A Redis outage can stall the FOREGROUND SSE experience
 * but can never erase or block a `push_delivery` row (Stage 6 §9).
 */
export async function runPushDispatchCycle(
  dataSource: DataSource,
  tenant: TenantContextService,
  publish: (pushDeliveryId: string, organisationId: string) => Promise<void>,
  republish: (pushDeliveryId: string, organisationId: string, generation: number) => Promise<void>,
  ambiguousDeliverySafeToRetry: boolean,
): Promise<PushDispatchResult> {
  const total: PushDispatchResult = { claimed: 0, published: 0, recovered: 0, failedExhausted: 0, deliveryUncertain: 0 };

  for await (const organisationId of organisationIds(dataSource)) {
    const scope = await dispatchPushScope(tenant, organisationId, undefined, publish, republish, ambiguousDeliverySafeToRetry);
    total.claimed += scope.claimed;
    total.published += scope.published;
    total.recovered += scope.recovered;
    total.failedExhausted += scope.failedExhausted;
    total.deliveryUncertain += scope.deliveryUncertain;
    if (scope.publishFailed) total.publishFailed = (total.publishFailed ?? 0) + scope.publishFailed;
    if (scope.lastPublishError && !total.lastPublishError) total.lastPublishError = scope.lastPublishError;
  }
  // One summary per cycle (not one line per row during an outage).
  if (total.publishFailed) logger.warn(`push dispatch: ${total.publishFailed} publish(es) failed this cycle (${total.lastPublishError}); each is retried on the next tick`);

  return total;
}

/**
 * Phase D (D1): `WORKER_CLAIM_MODE=global` claim — the per_scope eligibility predicate, unchanged (asserted by
 * push-dispatch.job.spec.ts), restricted to the ids the global pointer claim returned for this organisation.
 */
// sql-injection-reviewed: interpolates a module-level SQL constant / constant fragment; every request value is a bound $n parameter.
const GLOBAL_CLAIM_SQL = `SELECT id, organisation_id, status, attempt_count, max_attempts, provider_call_started_at,
                  dispatch_generation, queued_at, (status = 'PENDING' AND queued_at < now() - interval '${PENDING_STALE_MINUTES} minutes') AS stale_pending
           FROM core.push_delivery
          WHERE (status = 'PENDING'
             OR (status = 'PROCESSING' AND processing_at < now() - interval '${PROCESSING_LEASE_MINUTES} minutes')
             OR (status = 'RETRY' AND updated_at < now() - interval '${RETRY_STALE_MINUTES} minutes')
          ) AND id = ANY($2::uuid[])
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`;

/**
 * ONE organisation's push dispatch (claim transaction, then publication after its commit). `ids === undefined` → the
 * per_scope claim, byte-for-byte; `ids` → the global-mode claim restricted to them. Everything after the claim is shared.
 */
export async function dispatchPushScope(
  tenant: TenantContextService,
  organisationId: string,
  ids: readonly string[] | undefined,
  publish: (pushDeliveryId: string, organisationId: string) => Promise<void>,
  republish: (pushDeliveryId: string, organisationId: string, generation: number) => Promise<void>,
  ambiguousDeliverySafeToRetry: boolean,
): Promise<PushDispatchResult> {
  const total: PushDispatchResult = { claimed: 0, published: 0, recovered: 0, failedExhausted: 0, deliveryUncertain: 0 };
  if (ids !== undefined && ids.length === 0) return total;
  {
    // The former per-organisation loop body of runPushDispatchCycle, unchanged apart from the claim statement choice.
    const claim = await tenant.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, async (manager) => {
      const claimed = ids !== undefined
        ? await manager.query<ClaimedRow[]>(GLOBAL_CLAIM_SQL, [ids.length, [...ids]])
        : await manager.query<ClaimedRow[]>(
        // sql-injection-reviewed: interpolates a module-level SQL constant / constant fragment; every request value is a bound $n parameter.
        `SELECT id, organisation_id, status, attempt_count, max_attempts, provider_call_started_at,
                  dispatch_generation, queued_at, (status = 'PENDING' AND queued_at < now() - interval '${PENDING_STALE_MINUTES} minutes') AS stale_pending
           FROM core.push_delivery
          WHERE status = 'PENDING'
             OR (status = 'PROCESSING' AND processing_at < now() - interval '${PROCESSING_LEASE_MINUTES} minutes')
             OR (status = 'RETRY' AND updated_at < now() - interval '${RETRY_STALE_MINUTES} minutes')
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );
      if (claimed.length === 0) return { toPublish: [] as ClaimedRow[], recoveredGenerations: new Map<string, number>(), recovered: new Set<string>(), exhaustedCount: 0, uncertainCount: 0 };

      const toPublish: ClaimedRow[] = [];
      const recoveredGenerations = new Map<string, number>();
      const recovered = new Set<string>();
      let exhaustedCount = 0;
      let uncertainCount = 0;

      const firstPublish: string[] = [];
      for (const row of claimed) {
        const hadPriorAttempt = row.status !== 'PENDING';
        if (!hadPriorAttempt) {
          if (row.stale_pending) {
            // Stale PENDING: never consumed since its first publish — fresh generation ⇒ fresh jobId (stays PENDING).
            const [[{ dispatch_generation: generation }]] = (await manager.query(
              `UPDATE core.push_delivery SET dispatch_generation = dispatch_generation + 1, queued_at = now(), status = 'PENDING' WHERE id = $1 RETURNING dispatch_generation`,
              [row.id],
            )) as [Array<{ dispatch_generation: number }>, number];
            recoveredGenerations.set(row.id, generation);
            recovered.add(row.id);
          } else {
            // Phase D-Q3 (audit §13 #5): a PENDING row already published (queued_at stamped) whose 2-minute window has not
            // run out is NOT re-added. Before, every tick re-added the same deduplicated jobId while the consumer lagged:
            // no effect on delivery, only Redis traffic. Its recovery is unchanged — the stale-PENDING branch above.
            if (row.queued_at !== null && row.queued_at !== undefined) continue;
            firstPublish.push(row.id);
            // A PENDING row that already has a generation (> 0) is always published under it, never `.attempt.0`.
            const generation = Number(row.dispatch_generation ?? 0);
            if (generation > 0) recoveredGenerations.set(row.id, generation);
          }
          toPublish.push(row);
          continue;
        }
        if (hadPriorAttempt && row.attempt_count >= row.max_attempts) {
          // D-Q5b: the claim now counts the in-flight attempt, so PROCESSING at the cap is "the last allowed attempt died".
          // If it had already called the provider (marker set) the push may have been delivered: DELIVERY_UNCERTAIN, as it
          // was before the counter change (with the job-relative count that row sat one below the cap) — never relabelled
          // as a plain exhausted failure. Without the marker nothing was sent: exhausted, unchanged.
          if (row.status === 'PROCESSING' && row.provider_call_started_at) {
            await manager.query(`UPDATE core.push_delivery SET status = 'FAILED', failed_at = now(), last_error_code = 'DELIVERY_UNCERTAIN' WHERE id = $1`, [row.id]);
            uncertainCount++;
            continue;
          }
          await manager.query(`UPDATE core.push_delivery SET status = 'FAILED', failed_at = now(), last_error_code = 'STUCK_LEASE_ATTEMPTS_EXHAUSTED' WHERE id = $1`, [row.id]);
          exhaustedCount++;
          continue;
        }
        if (hadPriorAttempt && row.provider_call_started_at && !ambiguousDeliverySafeToRetry) {
          await manager.query(`UPDATE core.push_delivery SET status = 'FAILED', failed_at = now(), last_error_code = 'DELIVERY_UNCERTAIN' WHERE id = $1`, [row.id]);
          uncertainCount++;
          continue;
        }
        if (hadPriorAttempt) {
          // manager.query() returns a [rows, rowCount] TUPLE for UPDATE, not the bare rows
          // array a SELECT returns (same gotcha documented in account-invite-cleanup.job.ts).
          const [[{ dispatch_generation: generation }]] = (await manager.query(
            `UPDATE core.push_delivery SET dispatch_generation = dispatch_generation + 1, queued_at = now(), status = 'PENDING' WHERE id = $1 RETURNING dispatch_generation`,
            [row.id],
          )) as [Array<{ dispatch_generation: number }>, number];
          recoveredGenerations.set(row.id, generation);
          recovered.add(row.id);
        }
        toPublish.push(row);
      }
      // First publish: stamp queued_at (the start of the 2-minute PENDING staleness clock). Only rows never stamped, so a
      // re-visit inside the window writes nothing.
      if (firstPublish.length > 0) {
        await manager.query(`UPDATE core.push_delivery SET queued_at = now() WHERE id = ANY($1::uuid[]) AND queued_at IS NULL`, [firstPublish]);
      }
      // #24: a full per_scope batch means more due rows may remain in this organisation (global-mode follow-up sweep) — but
      // only when this pass MOVED something. Unlike email, a published push row stays PENDING until the consumer takes it,
      // so while the consumer is behind every pass re-selects the same oldest 50 already-queued rows; signalling then would
      // only re-walk every organisation to re-publish deduplicated jobIds. Push backlog drain is therefore consumer-paced.
      if (ids === undefined && claimed.length >= BATCH_SIZE && firstPublish.length + recovered.size + exhaustedCount + uncertainCount > 0) {
        noteLegacyBatchLimitReached();
      }
      return { toPublish, recoveredGenerations, recovered, exhaustedCount, uncertainCount };
    });

    total.claimed += claim.toPublish.length + claim.exhaustedCount + claim.uncertainCount;
    total.failedExhausted += claim.exhaustedCount;
    total.deliveryUncertain += claim.uncertainCount;

    for (const row of claim.toPublish) {
      const generation = claim.recoveredGenerations.get(row.id);
      // Phase D-Q3 (audit §13 #5): caught per row, like email — one failed publish no longer aborts the rest of the cycle.
      try {
        if (generation !== undefined) {
          // eslint-disable-next-line no-await-in-loop
          await republish(row.id, organisationId, generation);
          if (claim.recovered.has(row.id)) total.recovered++;
        } else {
          // eslint-disable-next-line no-await-in-loop
          await publish(row.id, organisationId);
        }
        total.published++;
      } catch (error) {
        // Global claim mode (ids given): unchanged behaviour — the error propagates, so runGlobalDispatch releases this and
        // every remaining scope with its 15 s retry and ends the run. Withdrawing queued_at here would make the pointer
        // trigger re-time the pointer to "due now" and the SAME run would re-claim it every batch (independent review R1).
        if (ids !== undefined) throw error;
        total.publishFailed = (total.publishFailed ?? 0) + 1;
        // per_scope only. Keep today's prompt retry: the claim already stamped queued_at, and a stamped row inside its 2-minute window is
        // no longer re-added. Un-stamp it (fenced on status + generation, so a consumer claim or another replica's
        // recovery is never undone) and the NEXT tick publishes it again under the same jobId — as the old every-tick
        // re-add did. If this write fails too (database trouble), the 2-minute stale-PENDING rule still recovers the row.
        const fence = generation ?? Number(row.dispatch_generation ?? 0);
        await tenant
          .runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, (manager) =>
            manager.query(
              `UPDATE core.push_delivery SET queued_at = NULL WHERE id = $1 AND status = 'PENDING' AND dispatch_generation = $2 AND queued_at IS NOT NULL`,
              [row.id, fence],
            ),
          )
          .catch(() => undefined);
        if (!total.lastPublishError) total.lastPublishError = (error as Error)?.name ?? 'Error';
      }
    }
  }

  return total;
}
