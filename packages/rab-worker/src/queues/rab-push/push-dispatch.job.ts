import { DataSource } from 'typeorm';
import { organisationIds } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { noteLegacyBatchLimitReached } from '../../core/wake/legacy-batch-limit';

const BATCH_SIZE = 50;
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
  }

  return total;
}

/**
 * Phase D (D1): `WORKER_CLAIM_MODE=global` claim — the per_scope eligibility predicate, unchanged (asserted by
 * push-dispatch.job.spec.ts), restricted to the ids the global pointer claim returned for this organisation.
 */
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
      // #24: a full per_scope batch means more due rows may remain in this organisation (global-mode follow-up sweep).
      if (ids === undefined && claimed.length >= BATCH_SIZE) noteLegacyBatchLimitReached();
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
            if (row.queued_at === null || row.queued_at === undefined) firstPublish.push(row.id);
            // A PENDING row that already has a generation (> 0) is always published under it, never `.attempt.0`.
            const generation = Number(row.dispatch_generation ?? 0);
            if (generation > 0) recoveredGenerations.set(row.id, generation);
          }
          toPublish.push(row);
          continue;
        }
        if (hadPriorAttempt && row.attempt_count >= row.max_attempts) {
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
      return { toPublish, recoveredGenerations, recovered, exhaustedCount, uncertainCount };
    });

    total.claimed += claim.toPublish.length + claim.exhaustedCount + claim.uncertainCount;
    total.failedExhausted += claim.exhaustedCount;
    total.deliveryUncertain += claim.uncertainCount;

    for (const row of claim.toPublish) {
      const generation = claim.recoveredGenerations.get(row.id);
      if (generation !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await republish(row.id, organisationId, generation);
        if (claim.recovered.has(row.id)) total.recovered++;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await publish(row.id, organisationId);
      }
      total.published++;
    }
  }

  return total;
}
