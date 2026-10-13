import { EntityManager } from 'typeorm';

/**
 * Worker-side claim/complete/retry/cancel for `core.realtime_event` — see
 * the migration (`RealtimeEventOutbox1786698000000`, `rab-server`) for the
 * table and why it's a separate table from `core.worker_event`, and
 * `realtime-event.service.ts` (`rab-server`) for the business-transaction
 * insertion side. This file is the OTHER half: what a worker does with a
 * row once it exists. Mirrors `worker-event.ts`'s doc-comment discipline
 * and its "a losing attempt returns null/affected=0, never throws" idiom.
 *
 * No real consumer calls `claimRealtimeEvent` yet — Stage 1 is the outbox
 * foundation only (no Redis Pub/Sub distribution, no gateway). These
 * functions exist so Stage 1's required tests (concurrent claims, crash
 * recovery, bounded retry) can prove the mechanism against the real table
 * before any later stage builds a consumer on top of it.
 *
 * CLAIM: a batch `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
 * LOCKED)`, not a single-row claim — unlike `email_outbox` (claimed one row
 * at a time, by id, because BullMQ already assigned exactly one job per
 * row) this table is claimed by a SCANNING consumer (no per-event job), the
 * same discovery shape as `worker_event`'s jobs, just batched. `SKIP
 * LOCKED` is what makes concurrent claimers never block on, or double-claim,
 * each other's rows — the standard safe Postgres batch-claim idiom.
 *
 * LEASE: a `processing` row whose `lease_expires_at` has passed is
 * self-healing — the claim query's own WHERE clause treats it as claimable
 * again, exactly like `pending`/`retry`. No separate reaper/sweep process is
 * needed for "a crashed worker's claim must expire so another worker can
 * reclaim": the next claim call IS the reclaim.
 *
 * FENCING: every write after a claim (`completeRealtimeEvent`,
 * `markRealtimeEventRetry`, `failRealtimeEvent`) presents the SAME
 * `claimToken` the claim minted, in the `WHERE` clause, the same idiom as
 * `email-send.processor.ts`'s `processing_token` checks. A write whose token
 * no longer matches (the lease was reclaimed by someone else while this
 * caller was still, unknown to it, mid-flight) silently affects zero rows —
 * expected, not an error — never overwrites a newer attempt's outcome.
 */

const DEFAULT_LEASE_SECONDS = 60;

export interface ClaimedRealtimeEvent {
  id: string;
  organisationId: string;
  workspaceId: string | null;
  targetUserId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
  attemptCount: number;
  maxAttempts: number;
  claimToken: string;
  createdAt: Date;
}

interface ClaimRow {
  id: string;
  organisation_id: string;
  workspace_id: string | null;
  target_user_id: string | null;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  schema_version: number;
  attempt_count: number;
  max_attempts: number;
  claim_token: string;
  created_at: Date;
}

/**
 * Claims up to `limit` due events (`pending`/`retry` due now, or a
 * `processing` row whose lease expired) and marks them `processing` with a
 * fresh, shared `claimToken` and a lease of `leaseSeconds`. Oldest first.
 * Rows returned here are durably marked claimed by THIS call before it
 * returns — a caller that crashes immediately after still leaves them
 * recoverable once the lease expires.
 */
export async function claimRealtimeEvents(
  manager: EntityManager,
  params: { limit: number; claimToken: string; leaseSeconds?: number },
): Promise<ClaimedRealtimeEvent[]> {
  const leaseSeconds = params.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  // `manager.query()` on an UPDATE/DELETE returns `[rows, rowCount]`, NOT bare
  // `rows` (unlike SELECT/INSERT) — `PostgresQueryRunner.query()`'s own switch
  // on `raw.command`. Destructure explicitly; `rows.map(...)` directly on the
  // tuple silently iterates `[rowsArray, rowCount]` instead (found live: every
  // mapped field came back `undefined`, with exactly 2 "rows" no matter how
  // many actually matched — the rowCount number masquerading as a second row).
  //
  // `WITH ... AS MATERIALIZED (...)` is load-bearing, not stylistic: a plain
  // `UPDATE t SET ... WHERE id IN (SELECT id FROM t WHERE ... LIMIT $n FOR
  // UPDATE SKIP LOCKED)` — inlined directly, no CTE — claims EVERY row
  // matching the WHERE clause, silently ignoring LIMIT entirely, on this
  // table (RLS ENABLE+FORCE, non-leakproof USING clause calling
  // `core.current_org()`). Confirmed live and reproduced down to a two-line
  // repro with `rab`'s own `pg` driver, no TypeORM/NestJS involved: dropping
  // `FOR UPDATE` (or `SKIP LOCKED` alone) restores correct LIMIT behaviour;
  // adding `FOR UPDATE` back breaks it again, deterministically, every time.
  // The planner evidently flattens the `FOR UPDATE`-locked subquery into the
  // outer `UPDATE`'s own plan in a way that loses the LIMIT bound once RLS's
  // security barrier is also in play. `MATERIALIZED` forces the subquery to
  // execute and fully materialize as its own step BEFORE the outer UPDATE
  // ever runs, which is the standard, widely-used safe pattern for exactly
  // this "claim N rows" idiom precisely because of this class of risk —
  // never remove it as a "simplification." A test proving this exact
  // failure mode at a scale the original 5-row fixture could never have
  // caught (more pending rows than the claim limit) lives in
  // `realtime-event-outbox-claim.integration.spec.ts`.
  const [rows] = await manager.query<[ClaimRow[], number]>(
    `WITH claimable AS MATERIALIZED (
       SELECT id FROM core.realtime_event
       WHERE (status IN ('pending', 'retry') AND (next_retry_at IS NULL OR next_retry_at <= now()))
          OR (status = 'processing' AND lease_expires_at < now())
       ORDER BY created_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     UPDATE core.realtime_event
        SET status = 'processing', claimed_at = now(), claim_token = $1, lease_expires_at = now() + ($2 || ' seconds')::interval
      WHERE id IN (SELECT id FROM claimable)
     RETURNING id, organisation_id, workspace_id, target_user_id, event_type, entity_type, entity_id, payload, schema_version, attempt_count, max_attempts, claim_token, created_at`,
    [params.claimToken, String(leaseSeconds), params.limit],
  );
  return rows.map((r) => ({
    id: r.id,
    organisationId: r.organisation_id,
    workspaceId: r.workspace_id,
    targetUserId: r.target_user_id,
    eventType: r.event_type,
    entityType: r.entity_type,
    entityId: r.entity_id,
    payload: r.payload,
    schemaVersion: r.schema_version,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    claimToken: r.claim_token,
    createdAt: r.created_at,
  }));
}

/** Marks a claimed event durably delivered. Fenced on `claimToken` — a no-op (not an error) if the lease was reclaimed since. Returns whether this call's write actually took effect. */
export async function completeRealtimeEvent(manager: EntityManager, eventId: string, claimToken: string): Promise<boolean> {
  const [rows] = await manager.query<[Array<{ id: string }>, number]>(
    `UPDATE core.realtime_event SET status = 'completed', processed_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'processing' AND claim_token = $2
     RETURNING id`,
    [eventId, claimToken],
  );
  return rows.length > 0;
}

/**
 * The delivery attempt failed in a way that's worth retrying (e.g. Redis
 * was briefly unreachable). Bounded: once `attempt_count + 1` would reach
 * `max_attempts`, this transitions to `failed` instead of scheduling
 * another retry — never an infinite retry loop. Fenced on `claimToken`.
 */
export async function markRealtimeEventRetry(
  manager: EntityManager,
  eventId: string,
  claimToken: string,
  errorCode: string,
  backoffSeconds: number,
): Promise<'retry' | 'failed' | 'lost_lease'> {
  const [rows] = await manager.query<[Array<{ status: 'retry' | 'failed' }>, number]>(
    `UPDATE core.realtime_event
       SET attempt_count = attempt_count + 1,
           status = CASE WHEN attempt_count + 1 >= max_attempts THEN 'failed' ELSE 'retry' END,
           next_retry_at = CASE WHEN attempt_count + 1 >= max_attempts THEN NULL ELSE now() + ($4 || ' seconds')::interval END,
           claim_token = NULL,
           lease_expires_at = NULL,
           last_error_code = $3,
           last_error_at = now(),
           updated_at = now()
     WHERE id = $1 AND status = 'processing' AND claim_token = $2
     RETURNING status`,
    [eventId, claimToken, errorCode, String(backoffSeconds)],
  );
  return rows[0]?.status ?? 'lost_lease';
}

/** The business condition stopped holding (e.g. the shift this event referenced was cancelled) — a genuine, permanent, non-retryable exit. No fencing needed: cancellation is valid from any non-terminal status, not only `processing`. */
export async function cancelRealtimeEvent(manager: EntityManager, eventId: string, reason: string): Promise<void> {
  await manager.query(
    `UPDATE core.realtime_event SET status = 'cancelled', processed_at = now(), updated_at = now(), last_error_code = $2
     WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
    [eventId, reason],
  );
}

