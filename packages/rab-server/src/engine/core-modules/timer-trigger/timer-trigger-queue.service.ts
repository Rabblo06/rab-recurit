import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { EntityManager } from 'typeorm';

import { AfterCommitPublisher } from '../after-commit/after-commit-publisher';
import { EnvironmentService } from '../environment/environment.service';
import { enqueueRegisteredJob, registeredJob } from '../../worker-shared/queue-enqueue';
import { boundedPublish, closeQueueProducer, createQueueProducerConnection, ProducerRedisConnection } from '../../worker-shared/queue-producer-connection';
import {
  resolveTimerTriggerSettings,
  TIMER_TRIGGER_JOB_NAMES,
  TIMER_TRIGGER_QUEUE_NAME,
  TimerTriggerJobData,
  TimerTriggerKind,
  TimerTriggerSettings,
  timerTriggerJobId,
} from '../../worker-shared/timer-trigger.contract';

/** Bound on triggers held for ONE transaction (a 200-recipient bulk send stays inside it; beyond it the backstop scan). */
export const TIMER_TRIGGER_MAX_PER_TRANSACTION = 500;
/** Process-wide bound on trigger publishes in flight (each is also bounded by `boundedPublish`, 3 s). */
export const TIMER_TRIGGER_MAX_IN_FLIGHT = 500;

/** One trigger to arm: the committed row's own ids and the due time computed from the committed values. Never client input. */
export interface TimerTriggerArm {
  kind: TimerTriggerKind;
  organisationId: string;
  workspaceId: string;
  subjectId: string;
  dueAt: Date;
}

/**
 * Phase D-Q4b: the ONE producer of timer-trigger jobs (`crewflow-timer-triggers`, legacy `bull` prefix — OD-4), used by the
 * API (offer expiry at send, manager-confirmation timeout at staff acceptance) and by the Worker (no-show / late clock-in
 * arming from shift-monitor discovery).
 *
 * `WORKER_TIMER_TRIGGERS=off` (default) — today exactly: this service opens NO Redis connection, creates no Queue and every
 * call returns false without doing anything. A kind not in `WORKER_TIMER_TRIGGER_KINDS` is the same as off for that kind.
 *
 * Otherwise:
 *  - `afterCommit(manager, arm)`: registered on the business transaction through the engine `AfterCommitPublisher` (#35's
 *    mechanism, generalised): published only after the OUTERMOST commit, discarded by any rollback (whole transaction or a
 *    savepoint), detached from the request, bounded per transaction and in flight. A refusal (invalid id, no workspace)
 *    returns false and NEVER throws into the business transaction.
 *  - `publishNow(arm)`: for a caller with no business transaction to wait for (Worker arming after a read-only discovery).
 *  - Each publish: `registeredJob` validates the scope, job name, ids-only payload and jobId BEFORE Redis, then
 *    `boundedPublish` (fail-fast connection, 3 s); a failure is logged and swallowed — the backstop scan is unchanged.
 * Delay = dueAt − now (≥ 0). The deterministic jobId makes a re-arm a BullMQ no-op.
 */
@Injectable()
export class TimerTriggerQueueService implements OnModuleDestroy {
  private readonly logger = new Logger('TimerTriggers');
  readonly settings: TimerTriggerSettings & { enabled(kind: TimerTriggerKind): boolean };
  private readonly connection: Redis | null = null;
  private readonly queue: Queue<TimerTriggerJobData> | null = null;
  private readonly publisher = new AfterCommitPublisher({
    maxPerTransaction: TIMER_TRIGGER_MAX_PER_TRANSACTION,
    maxInFlight: TIMER_TRIGGER_MAX_IN_FLIGHT,
    failureMessage: (name) => `timer trigger publish failed (${name}); the backstop scan handles the subject`,
    logger: this.logger,
  });

  constructor(env: EnvironmentService) {
    this.settings = resolveTimerTriggerSettings({ get: (key) => env.get(key as never) });
    if (this.settings.mode !== 'off') {
      this.connection = createQueueProducerConnection(env.get('REDIS_URL'));
      this.queue = new Queue<TimerTriggerJobData>(TIMER_TRIGGER_QUEUE_NAME, { connection: this.connection }, ProducerRedisConnection);
      this.queue.on('error', () => undefined);
    }
  }

  /** True when `kind` may be armed in this process (mode shadow/on and the kind enabled). */
  enabled(kind: TimerTriggerKind): boolean {
    return this.queue !== null && this.settings.enabled(kind);
  }

  /** Arms `arm` after `manager`'s outermost commit. True when registered. Never throws. */
  afterCommit(manager: EntityManager, arm: TimerTriggerArm): boolean {
    if (!this.enabled(arm.kind)) return false;
    const job = this.build(arm);
    if (!job) return false;
    return this.publisher.defer(manager, () => this.publish(job));
  }

  /** Publishes `arm` now (bounded). Resolves true when BullMQ accepted the add (or deduplicated it); never rejects. */
  async publishNow(arm: TimerTriggerArm): Promise<boolean> {
    if (!this.enabled(arm.kind)) return false;
    const job = this.build(arm);
    if (!job) return false;
    try {
      await this.publish(job);
      return true;
    } catch (error) {
      this.logger.warn(`timer trigger publish failed (${(error as Error)?.name ?? 'Error'}); the backstop scan handles the subject`);
      return false;
    }
  }

  /** Validated job, or null (logged by rule name only) — a refusal never reaches Redis and never fails the caller. */
  private build(arm: TimerTriggerArm) {
    try {
      const dueAtEpochMs = arm.dueAt.getTime();
      const data: TimerTriggerJobData = { organisationId: arm.organisationId, workspaceId: arm.workspaceId, subjectId: arm.subjectId, dueAtEpochMs };
      return registeredJob(TIMER_TRIGGER_QUEUE_NAME, TIMER_TRIGGER_JOB_NAMES[arm.kind], { kind: 'organisation', organisationId: arm.organisationId }, data, {
        jobId: timerTriggerJobId(arm.kind, arm.subjectId, dueAtEpochMs),
        delayMs: Math.max(0, dueAtEpochMs - Date.now()),
      });
    } catch (error) {
      this.logger.warn(`timer trigger not armed (${(error as Error)?.message ?? 'refused'})`);
      return null;
    }
  }

  private async publish(job: NonNullable<ReturnType<TimerTriggerQueueService['build']>>): Promise<void> {
    const queue = this.queue!;
    await boundedPublish(this.connection!, 'timer trigger publish', () => enqueueRegisteredJob(queue, job));
  }

  /** Trigger publishes currently in flight (tests / diagnostics). */
  get inFlightCount(): number {
    return this.publisher.inFlightCount;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue && this.connection) await closeQueueProducer(this.queue, this.connection);
  }
}
