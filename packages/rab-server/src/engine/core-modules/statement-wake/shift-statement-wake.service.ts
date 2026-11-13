import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EntityManager } from 'typeorm';

import { AfterCommitPublisher } from '../after-commit/after-commit-publisher';
import { EnvironmentService } from '../environment/environment.service';
import { scanJobTemplate } from '../../worker-shared/queue-enqueue';
import { boundedPublish, closeQueueProducer, createQueueProducerConnection } from '../../worker-shared/queue-producer-connection';
import { resolveScanPrefix, SCAN_JOB_DATA, SCAN_QUEUES } from '../../worker-shared/queue-registry';

/** The scan queue and job the wake adds: the Worker's own, unchanged statement dispatcher (scan-jobs.ts). */
export const STATEMENT_WAKE_QUEUE = SCAN_QUEUES.reports;
export const STATEMENT_WAKE_JOB_NAME = 'shift-statement-dispatch';
/** One wake per transaction is enough: the dispatcher sweeps every due record, whatever the transaction approved. */
export const STATEMENT_WAKE_MAX_PER_TRANSACTION = 1;
/** Process-wide bound on wakes in flight (each also bounded by `boundedPublish`, 3 s). Beyond it the sweep delivers. */
export const STATEMENT_WAKE_MAX_IN_FLIGHT = 16;

/**
 * Phase X J1b (owner decision 2026-11-11; reopens D-Q3a in its no-write form): after a payroll approval (or a statement
 * retry) COMMITS, wake the Worker's pay-statement dispatcher instead of waiting for its next sweep (30 s in production, J1a).
 *
 * The wake is a HINT, never a record, and writes NOTHING to the database:
 *  - The durable event stays `payroll_record.statement_status = 'pending'`, committed by the approving transaction itself.
 *  - The wake adds one job named `shift-statement-dispatch` to the scan queue `crewflow-scan-reports` (scan prefix): the
 *    exact job the API's job scheduler adds every interval. The Worker runs its unchanged dispatcher for it, under the same
 *    runtime overlap guard and cross-replica scan lock, so the only writers of the statement dispatch state stay the
 *    dispatcher's compare-and-set (`queued`, generation + 1, in the Worker's session, as `core.payroll_record_guard`
 *    requires) and the consumer's generation / `statement_file_id IS NULL` / still-approved checks and its UNIQUE
 *    `worker_event`. The approving session never touches a dispatch column (the guard would refuse it with 42501).
 *  - NO jobId: BullMQ mints one. The scan queues keep completed jobs for 1 h, so any fixed id would make BullMQ silently
 *    drop every later wake for that hour. The payload is the scheduler's metadata-only `{ v: 1 }` (system scope): no
 *    organisation, record or user id ever reaches Redis.
 *  - Published only after the OUTERMOST commit; any rollback discards it (`AfterCommitPublisher`). Detached and bounded:
 *    the approval never waits for Redis, and a failed or lost wake (Redis down, Worker busy, a scan already running) is
 *    logged by error name and changes nothing — the 30 s sweep delivers the statement.
 *
 * Only with `WORKER_SCHEDULER=bullmq` (production's default): in interval mode no Worker consumes the scan queues, so a wake
 * would only pile up in Redis. Then this service opens no Redis connection and every call returns false.
 */
@Injectable()
export class ShiftStatementWakeService implements OnModuleDestroy {
  private readonly logger = new Logger('ShiftStatementWake');
  private readonly connection: Redis | null = null;
  private readonly queue: Queue | null = null;
  private readonly publisher = new AfterCommitPublisher({
    maxPerTransaction: STATEMENT_WAKE_MAX_PER_TRANSACTION,
    maxInFlight: STATEMENT_WAKE_MAX_IN_FLIGHT,
    failureMessage: (name) => `statement dispatcher wake not published (${name}); the statement sweep delivers it`,
    logger: this.logger,
  });

  constructor(env: EnvironmentService) {
    if (env.get('WORKER_SCHEDULER') !== 'bullmq') return;
    const prefix = resolveScanPrefix(String(env.get('NODE_ENV') ?? 'development'), env.get('BULLMQ_PREFIX'));
    this.connection = createQueueProducerConnection(env.get('REDIS_URL'));
    this.queue = new Queue(STATEMENT_WAKE_QUEUE, { connection: this.connection, prefix });
    this.queue.on('error', () => undefined);
  }

  /** True when this process may publish wakes (bullmq scheduler mode). */
  get enabled(): boolean {
    return this.queue !== null;
  }

  /**
   * Wakes the statement dispatcher after `manager`'s outermost commit. True when registered. Never throws into the caller's
   * transaction (a refusal of the job template is a programming error and is logged, not raised).
   */
  afterCommit(manager: EntityManager): boolean {
    if (!this.queue) return false;
    return this.publisher.defer(manager, () => this.publish());
  }

  private async publish(): Promise<void> {
    const queue = this.queue!;
    // Validated against the queue registry before Redis: system scope, a registered scan job name, metadata-only payload.
    const job = scanJobTemplate(STATEMENT_WAKE_QUEUE, STATEMENT_WAKE_JOB_NAME, { kind: 'system' }, { ...SCAN_JOB_DATA });
    // Deliberately no jobId (see the class comment).
    await boundedPublish(this.connection!, 'statement dispatcher wake', () => queue.add(job.name, job.data, job.opts));
  }

  /** Wakes currently in flight (tests / diagnostics). */
  get inFlightCount(): number {
    return this.publisher.inFlightCount;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue && this.connection) await closeQueueProducer(this.queue, this.connection);
  }
}
