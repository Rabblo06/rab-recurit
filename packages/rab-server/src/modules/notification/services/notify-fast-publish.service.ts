import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { EmailQueueService } from '../../../engine/core-modules/email/email-queue.service';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { PushQueueService } from '../../../engine/core-modules/push/push-queue.service';

type PublishTask = () => Promise<void>;

/** Bound on deferred publishes held for ONE transaction (a notify() fan-out never comes near it; beyond it the dispatcher publishes). */
export const NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION = 200;

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
  private readonly pending = new WeakMap<QueryRunner, PublishTask[]>();
  private readonly subscriber = {
    afterTransactionCommit: (event: { queryRunner: QueryRunner }): void =>
      this.onCommit(event.queryRunner),
    afterTransactionRollback: (event: { queryRunner: QueryRunner }): void =>
      this.onRollback(event.queryRunner),
  };

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
    return runner ? (this.pending.get(runner)?.length ?? 0) : 0;
  }

  private defer(manager: EntityManager, task: PublishTask): boolean {
    if (!this.enabled) return false;
    const runner = manager.queryRunner;
    // Only inside an open transaction: there must be a commit to wait for. Otherwise the dispatcher publishes.
    if (!runner || runner.isReleased || !runner.isTransactionActive)
      return false;
    this.subscribe(manager.connection);
    const tasks = this.pending.get(runner) ?? [];
    if (tasks.length >= NOTIFY_FAST_PUBLISH_MAX_PER_TRANSACTION) return false;
    tasks.push(task);
    this.pending.set(runner, tasks);
    return true;
  }

  /** Registers the commit/rollback listener on the transaction's own DataSource, once. */
  private subscribe(connection: DataSource): void {
    if (!connection.subscribers.includes(this.subscriber as never))
      connection.subscribers.push(this.subscriber as never);
  }

  private onCommit(runner: QueryRunner): void {
    // A savepoint release (nested transaction) is not a commit: the outer transaction may still roll back.
    if (runner.isTransactionActive) return;
    const tasks = this.pending.get(runner);
    if (!tasks) return;
    this.pending.delete(runner);
    // Detached on purpose: the broadcast (and so the caller's transaction() promise) never waits for Redis.
    void this.flush(tasks);
  }

  private onRollback(runner: QueryRunner): void {
    this.pending.delete(runner);
  }

  /** Concurrently: one slow or hanging publish (each is bounded by the producer) never holds back the others. */
  private async flush(tasks: readonly PublishTask[]): Promise<void> {
    await Promise.all(
      tasks.map((task) =>
        task().catch((error: unknown) => {
          // Best effort only: the row is durably PENDING; the dispatcher publishes it on its next pass.
          this.logger.warn(`fast publish failed (${(error as Error)?.name ?? 'Error'}); the dispatcher will publish the row`);
        }),
      ),
    );
  }
}
