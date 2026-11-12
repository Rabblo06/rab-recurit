import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntityManager, QueryRunner } from 'typeorm';

import { AfterCommitPublisher } from '../../../engine/core-modules/after-commit/after-commit-publisher';
import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PushQueueService } from '../../../engine/core-modules/push/push-queue.service';

/** Bound on deferred publishes held for ONE transaction (a notify() fan-out never comes near it; beyond it the dispatcher publishes). */
export const NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION = 200;
/**
 * Process-wide bound on fast publishes in flight at once. Beyond it a publish is simply not attempted (the dispatcher
 * publishes the row), so a Redis outage or a slow producer can never pile up pending publishes in memory however much
 * notification traffic commits meanwhile (CodeRabbit on #35; each publish is also bounded by the producer's own 3 s cap).
 */
export const NOTIFY_FAST_PUBLISH_MAX_IN_FLIGHT = 500;

/** The ids a fast publish needs — the row's own committed id and organisation, nothing from a client. */
export interface FastPublishRow {
  id: string;
  organisationId: string;
}

/**
 * Phase D-Q3 (WORKER_FAST_PUBLISH_NOTIFY, default false): best-effort AFTER-COMMIT publish of the `email_outbox` and
 * `push_delivery` rows that `NotificationService.notify()` just wrote in the caller's transaction, so they start within
 * moments instead of waiting for the dispatcher's next tick. A LATENCY change only — no database load reduction is
 * claimed (not measured), and the dispatcher keeps scanning exactly as before.
 *
 * Rules (owner, 2026-11-02):
 *  - NEVER before commit. A publish is registered against the transaction's own QueryRunner and fired only from TypeORM's
 *    `AfterTransactionCommit` broadcast for the OUTERMOST commit (`isTransactionActive === false`; a savepoint release
 *    is ignored). ANY rollback on that QueryRunner — of the whole transaction or of a savepoint inside it — discards
 *    every publish registered on it (conservative: whatever did commit is published by the dispatcher instead).
 *    Outside a transaction nothing is registered (the dispatcher publishes).
 *  - The outbox row stays the record; the dispatcher stays the safety net. This writes NOTHING to the database: no status,
 *    no `queued_at`, no generation. The job is the exact one the dispatcher's FIRST publish of a fresh row adds —
 *    `email-outbox.<id>.attempt.0` / `push-delivery.<id>.attempt.0` with the same options (the existing public
 *    `EmailQueueService.publish` / `PushQueueService.publish`), because a row created a moment ago always has
 *    `dispatch_generation = 0`. When the dispatcher later sees the row (email PENDING → QUEUED; push PENDING with no
 *    `queued_at` → stamped) it adds the same jobId again, which BullMQ deduplicates (completed jobs are kept 7 days,
 *    failed 30). The consumers' own database compare-and-set (PENDING/QUEUED/RETRY → PROCESSING with a fencing token)
 *    is the second guard: one delivery.
 *  - provider_call_started_at, DELIVERY_UNCERTAIN, the idempotency key, attempts, backoff and leases are untouched.
 *  - Redis down or slow: each publish is already bounded by the producers' fail-fast connection (`boundedPublish`, 3 s);
 *    a failure is logged and swallowed. The publishes run detached from the request (the commit broadcast does not wait
 *    for them), so the request's latency and outcome never depend on Redis. The row is published later by the
 *    dispatcher exactly as today.
 *  - Tenant scope: the job carries only the row id and the organisation id of the row this transaction just wrote
 *    (server-side values from the committed row, never client input); the consumer re-reads the row under that
 *    organisation's RLS context and revalidates it before sending.
 *
 * Payroll statement approval is deliberately NOT fast-published (see the PR / THREAT-MODEL D-Q3a): an identical fast
 * path would need the dispatcher's `pending → queued` + generation compare-and-set, and a publish that then fails during
 * a short Redis blip would leave the statement waiting for the 10-minute lease, where today the 5 s dispatcher would
 * claim it as soon as Redis is back — a lease-outcome change the owner ruled out.
 */
@Injectable()
export class NotifyFastPublishService {
  private readonly logger = new Logger('NotifyFastPublish');
  /**
   * Phase D-Q4b: the after-commit mechanism this service introduced now lives in the engine (`AfterCommitPublisher`) so
   * the timer-trigger producer reuses it; the rules above, the bounds and the warning line are unchanged.
   */
  private readonly publisher = new AfterCommitPublisher({
    maxPerTransaction: NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION,
    maxInFlight: NOTIFY_FAST_PUBLISH_MAX_IN_FLIGHT,
    // Best effort only: the row is durably PENDING; the dispatcher publishes it on its next pass.
    failureMessage: (name) => `fast publish failed (${name}); the dispatcher will publish the row`,
    logger: this.logger,
  });

  constructor(
    private readonly env: EnvironmentService,
    @Optional() private readonly emailQueue?: EmailQueueService,
    @Optional() private readonly pushQueue?: PushQueueService,
  ) {}

  /** Exactly `true` turns it on; anything else (false, missing, malformed) is off. */
  get enabled(): boolean {
    return this.env.get('WORKER_FAST_PUBLISH_NOTIFY') === true;
  }

  /** A notify()-generated email row, written in `manager`'s open transaction. True when a publish was registered. */
  afterCommitEmail(manager: EntityManager, row: FastPublishRow): boolean {
    const queue = this.emailQueue;
    if (!queue) return false;
    const { id, organisationId } = row;
    return this.defer(manager, () => queue.publish(id, organisationId));
  }

  /** The push_delivery rows notify() just fanned out, written in `manager`'s open transaction. */
  afterCommitPush(
    manager: EntityManager,
    rows: readonly FastPublishRow[],
  ): number {
    const queue = this.pushQueue;
    if (!queue) return 0;
    let registered = 0;
    for (const { id, organisationId } of rows)
      if (this.defer(manager, () => queue.publish(id, organisationId)))
        registered++;
    return registered;
  }

  /** Publishes still held for this QueryRunner (tests / diagnostics). */
  heldFor(runner: QueryRunner | undefined): number {
    return this.publisher.heldFor(runner);
  }

  private defer(manager: EntityManager, task: () => Promise<void>): boolean {
    if (!this.enabled) return false;
    // Only inside an open transaction (AfterCommitPublisher.defer): there must be a commit to wait for. Otherwise the
    // dispatcher publishes.
    return this.publisher.defer(manager, task);
  }

  /** Fast publishes currently in flight (tests / diagnostics). */
  get inFlightCount(): number {
    return this.publisher.inFlightCount;
  }
}
