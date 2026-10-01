import { DataSource } from 'typeorm';
import { organisationIds } from '@rab/server/engine/worker-shared/maintenance-catalogue';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';

const BATCH_SIZE = 50;

// A `PROCESSING` row's own `processing_at` acts as a lease: normal delivery
// (an SMTP/Resend call) completes in low single-digit seconds, so anything
// still `PROCESSING` this long after being claimed means the worker that
// claimed it died mid-send (OOM, SIGKILL, a bad deploy) before it could
// reach either the `SENT` or the `RETRY`/`FAILED` write — see
// `email-send.processor.ts:101-131`. Generous on purpose: long enough that a
// genuinely slow-but-alive attempt (a provider having a bad moment) is never
// wrongly reclaimed out from under itself.
const PROCESSING_LEASE_MINUTES = 10;
// BullMQ's own exponential backoff (5s base, 5 max attempts — see
// `email-queue.service.ts`) redelivers a `RETRY` row well within 2 minutes
// in the worst case. Anything still sitting `RETRY` this long past its last
// update means BullMQ's own redelivery never happened (a lost job — Redis
// data loss, a job manually removed, a `jobId` collision) — the row itself
// is the only thing still alive to notice that.
const RETRY_STALE_MINUTES = 5;

interface ClaimedRow {
  id: string;
  organisation_id: string;
  status: string;
  infrastructure_attempt_count: number;
  max_infrastructure_attempts: number;
  provider_call_started_at: Date | null;
}

export interface EmailDispatchResult {
  claimed: number;
  published: number;
  /** Rows recovered from a stuck PROCESSING/RETRY state and re-published — a subset of `published`, tracked separately for observability. */
  recovered: number;
  /** Rows that had already exhausted their attempt budget while stuck — moved straight to FAILED, never re-published. */
  failedExhausted: number;
  /**
   * Rows whose provider call durably started, then the outcome was lost
   * (crash / DB failure recording the result), on a driver that cannot
   * safely re-attempt an ambiguous delivery (SMTP — see
   * `EmailDriverInterface.ambiguousDeliverySafeToRetry`'s doc comment).
   * Marked FAILED with `last_error_code = 'DELIVERY_UNCERTAIN'`, never
   * blindly resent.
   */
  deliveryUncertain: number;
}

/**
 * The dispatcher half of the transactional outbox — see
 * `email-outbox.entity.ts`'s doc comment for the durability property this
 * provides. Runs on a short interval (see `main.ts`), independent of the
 * request-time "fast path" publish attempt in `EmailOutboxService.
 * tryFastPublish` — that attempt is allowed to fail silently (a crash, a
 * momentary Redis blip) precisely BECAUSE this sweep exists as the real
 * backstop. A row can only ever be lost if BOTH the fast-path publish and
 * every subsequent dispatch cycle fail, which durability-wise is
 * indistinguishable from Redis itself being down — not a gap this design
 * claims to cover (queue delivery to Redis itself is out of scope; the
 * durable row surviving an API-process crash is what's actually promised).
 *
 * Only fixed read-only organisation catalogue queries use the owner connection.
 * Claims/recovery/audits run under rab_app in one organisation at a time.
 * Row locks serialize eligible claims. Commit precedes queue publication, so
 * a fast consumer cannot see a pre-claim row; failed publication is recovered
 * by the existing QUEUED staleness rule. Batch limit is per organisation.
 *
 * STUCK-ROW RECOVERY, Phase 9 revision: the claim query re-claims a
 * `PROCESSING` row past its lease and a `RETRY` row BullMQ never got back to
 * (see the two constants above), exactly as before. What changed is HOW a
 * recovered row is republished:
 *
 *   - A row that was PENDING (never had any attempt) is republished via
 *     `publish()`, unchanged, same jobId (`attempt:0`) as always.
 *   - A row that already had an attempt (QUEUED/PROCESSING/RETRY) is only
 *     ever republished after DURABLY bumping `dispatch_generation` (CAS'd
 *     by the row's own UPDATE) and using `republish()`'s generation-suffixed
 *     jobId — this is what actually fixes the confirmed bug: the OLD
 *     BullMQ job's terminal state (completed, retained for up to 7 days; or
 *     failed-and-removed) can no longer block the new attempt from ever
 *     running, because the new attempt gets a genuinely new job identity.
 *   - Republishing itself is only done when it's SAFE: if `provider_call_
 *     started_at` is set (the provider was actually contacted, the outcome
 *     is ambiguous) AND the configured driver cannot safely retry an
 *     ambiguous delivery (SMTP), the row is marked FAILED with
 *     `last_error_code = 'DELIVERY_UNCERTAIN'` instead — surfaced for a
 *     human/operator, never silently resent, never silently dropped.
 *
 * The one thing recovery must never do is let a recreated BullMQ job reset
 * the attempt count that governs `max_infrastructure_attempts`: a row that
 * already exhausted its budget while stuck is moved straight to FAILED here
 * instead of being re-published (a fresh BullMQ `Job` would start
 * `attemptsMade` back at 0, which would otherwise let a systematically-stuck
 * row retry forever) — unchanged from before Phase 9.
 */
export async function runEmailDispatchCycle(
  dataSource: DataSource,
  tenant: TenantContextService,
  publish: (emailOutboxId: string, organisationId: string) => Promise<void>,
  republish: (
    emailOutboxId: string,
    organisationId: string,
    generation: number,
  ) => Promise<void>,
  ambiguousDeliverySafeToRetry: boolean,
): Promise<EmailDispatchResult> {
  const total: EmailDispatchResult = {
    claimed: 0,
    published: 0,
    recovered: 0,
    failedExhausted: 0,
    deliveryUncertain: 0,
  };
  for await (const organisationId of organisationIds(dataSource)) {
    const claim = await tenant.runInTenantContext(
      { organisationId, workspaceId: null, userId: '', role: '' },
      async (manager) => {
        let exhaustedCount = 0;
        let uncertainCount = 0;
        // SELECT-then-UPDATE (no RETURNING), same documented reason as the
        // cleanup job: `manager.query()` returns a `[rows, rowCount]` TUPLE
        // for UPDATE, not the bare rows array a SELECT returns.
        const claimed = await manager.query<ClaimedRow[]>(
          `SELECT id, organisation_id, status, infrastructure_attempt_count, max_infrastructure_attempts, provider_call_started_at
           FROM core.email_outbox
          WHERE status = 'PENDING'
             OR (status = 'QUEUED' AND queued_at < now() - interval '2 minutes')
             OR (status = 'PROCESSING' AND processing_at < now() - interval '${PROCESSING_LEASE_MINUTES} minutes')
             OR (status = 'RETRY' AND updated_at < now() - interval '${RETRY_STALE_MINUTES} minutes')
          ORDER BY created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
          [BATCH_SIZE],
        );
        if (claimed.length === 0)
          return {
            toPublish: [] as ClaimedRow[],
            recoveredGenerations: new Map<string, number>(),
            exhaustedCount: 0,
            uncertainCount: 0,
          };

        // Exhausted rows (already at/over their attempt budget while stuck)
        // go straight to FAILED — never re-published, never handed a fresh
        // attempt count via a recreated BullMQ job.
        const exhausted = claimed.filter(
          (row) =>
            row.infrastructure_attempt_count >= row.max_infrastructure_attempts,
        );
        const notExhausted = claimed.filter(
          (row) =>
            row.infrastructure_attempt_count < row.max_infrastructure_attempts,
        );
        exhaustedCount = exhausted.length;

        if (exhausted.length > 0) {
          await manager.query(
            `UPDATE core.email_outbox
              SET status = 'FAILED', failed_at = now(), last_error_code = 'STUCK_LEASE_ATTEMPTS_EXHAUSTED',
                  last_error_message_sanitized = 'Recovered from a stuck PROCESSING/RETRY state with no attempts remaining.'
            WHERE id = ANY($1::uuid[])`,
            [exhausted.map((row) => row.id)],
          );
          for (const row of exhausted) {
            await writeAuditRow(
              manager,
              row.organisation_id,
              row.id,
              'email.delivery_failed',
              { errorCode: 'STUCK_LEASE_ATTEMPTS_EXHAUSTED' },
            );
          }
        }

        // Of the rows still eligible: split by whether a real attempt already
        // existed (needs a fresh generation to escape the old BullMQ job's
        // terminal state) versus a genuinely first-ever attempt (PENDING —
        // keeps today's stable attempt:0 jobId, unchanged).
        const firstAttempt = notExhausted.filter(
          (row) => row.status === 'PENDING',
        );
        const hadPriorAttempt = notExhausted.filter(
          (row) => row.status !== 'PENDING',
        );

        // Of those with a prior attempt: an ambiguous one (the provider was
        // actually contacted) is only safe to retry if the CONFIGURED driver
        // can dedupe it server-side. One never contacted at all is always
        // safe — nothing could have been sent.
        const safeToRecover = hadPriorAttempt.filter(
          (row) =>
            !row.provider_call_started_at || ambiguousDeliverySafeToRetry,
        );
        const uncertain = hadPriorAttempt.filter(
          (row) =>
            row.provider_call_started_at && !ambiguousDeliverySafeToRetry,
        );
        uncertainCount = uncertain.length;

        if (uncertain.length > 0) {
          await manager.query(
            `UPDATE core.email_outbox
              SET status = 'FAILED', failed_at = now(), last_error_code = 'DELIVERY_UNCERTAIN',
                  last_error_message_sanitized = 'The provider may have already sent this email before the outcome was lost; the configured driver cannot safely confirm or retry. Requires manual review.'
            WHERE id = ANY($1::uuid[])`,
            [uncertain.map((row) => row.id)],
          );
          for (const row of uncertain) {
            await writeAuditRow(
              manager,
              row.organisation_id,
              row.id,
              'email.delivery_uncertain',
              { errorCode: 'DELIVERY_UNCERTAIN' },
            );
          }
        }

        if (firstAttempt.length > 0) {
          await manager.query(
            `UPDATE core.email_outbox SET status = 'QUEUED', queued_at = now() WHERE id = ANY($1::uuid[])`,
            [firstAttempt.map((row) => row.id)],
          );
        }

        let recoveredGenerations = new Map<string, number>();
        if (safeToRecover.length > 0) {
          // Bump dispatch_generation atomically — Postgres serializes concurrent
          // UPDATEs on the same row via its own row lock, so two racing
          // dispatcher instances can never both "win" the same new generation
          // for the same row (and FOR UPDATE SKIP LOCKED above already means
          // only one dispatcher instance ever claims a given row per cycle).
          const [rows] = (await manager.query(
            `UPDATE core.email_outbox
              SET status = 'QUEUED', queued_at = now(), dispatch_generation = dispatch_generation + 1
            WHERE id = ANY($1::uuid[])
          RETURNING id, dispatch_generation`,
            [safeToRecover.map((row) => row.id)],
          )) as [Array<{ id: string; dispatch_generation: number }>, number];
          recoveredGenerations = new Map(
            rows.map((r) => [r.id, r.dispatch_generation]),
          );
        }

        return {
          toPublish: [...firstAttempt, ...safeToRecover],
          recoveredGenerations,
          exhaustedCount,
          uncertainCount,
        };
      },
    );
    const { toPublish, recoveredGenerations, exhaustedCount, uncertainCount } =
      claim;

    let published = 0;
    let recovered = 0;
    for (const row of toPublish) {
      try {
        const generation = recoveredGenerations.get(row.id);
        if (generation !== undefined) {
          await republish(row.id, row.organisation_id, generation);
          recovered += 1;
        } else {
          await publish(row.id, row.organisation_id);
        }
        published += 1;
      } catch (error) {
        // Left QUEUED — the staleness re-claim above picks this back up in
        // ~2 minutes if it's still stuck then. Logged, not thrown — one
        // queue outage must not stop the rest of this batch from publishing.
        // eslint-disable-next-line no-console
        console.error(
          `email dispatch: failed to publish outbox row ${row.id}:`,
          error,
        );
      }
    }

    total.claimed += toPublish.length + exhaustedCount + uncertainCount;
    total.published += published;
    total.recovered += recovered;
    total.failedExhausted += exhaustedCount;
    total.deliveryUncertain += uncertainCount;
  }
  return total;
}

/** Append-only audit uses the same scoped transaction as its state change. */
async function writeAuditRow(
  manager: import('typeorm').EntityManager,
  organisationId: string,
  emailOutboxId: string,
  action: string,
  extraMetadata: Record<string, unknown>,
): Promise<void> {
  await manager.query(
    `INSERT INTO core.audit_log (organisation_id, actor_user_id, action, metadata)
     VALUES ($1, NULL, $2, $3::jsonb)`,
    [
      organisationId,
      action,
      JSON.stringify({ emailOutboxId, ...extraMetadata }),
    ],
  );
}
