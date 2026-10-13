import { DataSource } from 'typeorm';
import { organisationIds } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

const BATCH_SIZE = 50;
// A push send (one HTTP call to FCM) completes in low single-digit seconds — same reasoning as
// email's own PROCESSING_LEASE_MINUTES: generous enough that a genuinely slow-but-alive attempt
// is never wrongly reclaimed, short enough that a dead worker's claim doesn't stall a delivery long.
const PROCESSING_LEASE_MINUTES = 10;
const RETRY_STALE_MINUTES = 5;

interface ClaimedRow {
  id: string;
  organisation_id: string;
  status: string;
  attempt_count: number;
  max_attempts: number;
  provider_call_started_at: Date | null;
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
    const claim = await tenant.runInTenantContext({ organisationId, workspaceId: null, userId: '', role: '' }, async (manager) => {
      const claimed = await manager.query<ClaimedRow[]>(
        `SELECT id, organisation_id, status, attempt_count, max_attempts, provider_call_started_at
           FROM core.push_delivery
          WHERE status = 'PENDING'
             OR (status = 'PROCESSING' AND processing_at < now() - interval '${PROCESSING_LEASE_MINUTES} minutes')
             OR (status = 'RETRY' AND updated_at < now() - interval '${RETRY_STALE_MINUTES} minutes')
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );
      if (claimed.length === 0) return { toPublish: [] as ClaimedRow[], recoveredGenerations: new Map<string, number>(), exhaustedCount: 0, uncertainCount: 0 };

      const toPublish: ClaimedRow[] = [];
      const recoveredGenerations = new Map<string, number>();
      let exhaustedCount = 0;
      let uncertainCount = 0;

      for (const row of claimed) {
        const hadPriorAttempt = row.status !== 'PENDING';
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
            `UPDATE core.push_delivery SET dispatch_generation = dispatch_generation + 1, status = 'PENDING' WHERE id = $1 RETURNING dispatch_generation`,
            [row.id],
          )) as [Array<{ dispatch_generation: number }>, number];
          recoveredGenerations.set(row.id, generation);
        }
        toPublish.push(row);
      }
      return { toPublish, recoveredGenerations, exhaustedCount, uncertainCount };
    });

    total.claimed += claim.toPublish.length + claim.exhaustedCount + claim.uncertainCount;
    total.failedExhausted += claim.exhaustedCount;
    total.deliveryUncertain += claim.uncertainCount;

    for (const row of claim.toPublish) {
      const generation = claim.recoveredGenerations.get(row.id);
      if (generation !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        await republish(row.id, organisationId, generation);
        total.recovered++;
      } else {
        // eslint-disable-next-line no-await-in-loop
        await publish(row.id, organisationId);
      }
      total.published++;
    }
  }

  return total;
}
