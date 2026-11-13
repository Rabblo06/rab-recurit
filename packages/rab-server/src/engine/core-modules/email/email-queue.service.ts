import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { enqueueRegisteredJob, registeredJob } from '../../worker-shared/queue-enqueue';
import { boundedPublish, closeQueueProducer, createQueueProducerConnection, ProducerRedisConnection } from '../../worker-shared/queue-producer-connection';
import { bullmqJobOptionsOf, OutboxJobOptions } from '../../worker-shared/queue-registry';

import { EnvironmentService } from '../environment/environment.service';
import { EMAIL_QUEUE_JOB_NAME, EMAIL_QUEUE_NAME, EmailQueueJobData } from './email-queue.constants';

/**
 * D5: the same 5 attempts and 5 s exponential base, now with JITTER — each retry waits a random 50–100 % of its
 * exponential step (BullMQ 5.81 `backoff.jitter`), so the retries of many jobs that failed together (a provider or network
 * outage) do not all hit the provider again in the same second. D-Q1: read from the queue registry (values unchanged:
 * 5 attempts, exponential 5 s, jitter 0.5 — pinned by queue-registry.spec.ts; retention since X3.4: 4 h / 1000 completed,
 * 7 d / 1000 failed, the registry's QUEUE_RETENTION).
 */
const LIVE_JOB_STATES: ReadonlySet<string> = new Set(['waiting', 'delayed', 'active', 'prioritized', 'waiting-children']);

export const EMAIL_QUEUE_JOB_OPTIONS = Object.freeze(bullmqJobOptionsOf(EMAIL_QUEUE_NAME) as OutboxJobOptions);

/**
 * API-process side of the queue — publish only, never consumes. Bounded,
 * backed-off retries live here (not re-derived per call site) so every
 * publisher gets the same policy for free; the worker's own processor
 * additionally classifies retryable-vs-not per attempt (see
 * `email-send.processor.ts`) and can stop early via `UnrecoverableError`
 * regardless of how many attempts remain configured here.
 *
 * TWO DISTINCT IDENTITIES, on purpose (Phase 9):
 *  - The PROVIDER idempotency key (`EmailSendOptions.idempotencyKey`,
 *    `email-outbox:<id>`) never changes — it is what lets Resend safely
 *    deduplicate a genuinely-ambiguous retry server-side.
 *  - The BullMQ jobId DOES change, but only across a genuine RECOVERY
 *    republish (`republish()`), never a first attempt (`publish()`, always
 *    `attempt:0`). This is what actually fixes the confirmed bug: a row
 *    stuck because its OLD BullMQ job already reached a terminal state
 *    (completed, retained up to 4 hours; or failed-and-removed) can no
 *    longer have that old job silently swallow the new attempt — a fresh
 *    generation gets a fresh jobId, decoupled from the old job's fate.
 */
@Injectable()
export class EmailQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<EmailQueueJobData>;

  constructor(env: EnvironmentService) {
    // D5: fail fast (no offline queue, bounded commands) — a lost publish is safe, the outbox row is durable.
    this.connection = createQueueProducerConnection(env.get('REDIS_URL'));
    this.queue = new Queue<EmailQueueJobData>(EMAIL_QUEUE_NAME, { connection: this.connection }, ProducerRedisConnection);
    this.queue.on('error', () => undefined);
  }

  /**
   * First-ever publish attempt for a row — the fast path right after
   * `enqueue()` commits, and the dispatcher's first pickup of a still-PENDING
   * row. Always jobId `.attempt.0`: BullMQ's own `.add()` dedupe on a
   * duplicate id is exactly what should happen here if both callers race
   * for the same fresh row (today's behavior, unchanged).
   *
   * NOTE: jobId uses `.` as its separator, never `:` — BullMQ reserves `:`
   * for its own internal repeatable-job id format and throws ("Custom Id
   * cannot contain :") for any custom id containing one that doesn't split
   * into exactly 3 parts (confirmed by reading
   * `node_modules/bullmq/dist/cjs/classes/job.js`'s own `validateOptions`,
   * not assumed — this was caught by this phase's own new test suite
   * against a real Queue, not discovered in production). The PROVIDER
   * idempotency key (`deliveryKeyFor`, `email-outbox:<id>`) is a completely
   * separate string with no such constraint and is unaffected.
   */
  async publish(emailOutboxId: string, organisationId: string): Promise<void> {
    await this.add(emailOutboxId, organisationId, 0);
  }

  /**
   * A RECOVERY publish — the dispatcher reclaiming a row that already had a
   * prior attempt it now believes may be dead (a stale PROCESSING/RETRY
   * lease). `generation` must come from a value THIS caller just durably
   * bumped via the row's own `dispatch_generation` column (CAS'd by
   * Postgres's row lock on that UPDATE) — never derived from an in-memory
   * counter, so two racing dispatcher instances can't both mint the same
   * "new" generation for the same row.
   */
  async republish(emailOutboxId: string, organisationId: string, generation: number): Promise<void> {
    await this.add(emailOutboxId, organisationId, generation);
  }

  /**
   * D-Q1: every publish names its tenant scope — the outbox row's own organisation (the caller just wrote or claimed the
   * row; never a client value). The job (name, ids-only payload, registry options, jobId format) is validated BEFORE the
   * bounded publish, so a refusal is never mistaken for a Redis outage.
   */
  private async add(emailOutboxId: string, organisationId: string, generation: number): Promise<void> {
    const data: EmailQueueJobData = { emailOutboxId, organisationId };
    const job = registeredJob(EMAIL_QUEUE_NAME, EMAIL_QUEUE_JOB_NAME, { kind: 'organisation', organisationId }, data, {
      jobId: `email-outbox.${emailOutboxId}.attempt.${generation}`,
    });
    await boundedPublish(this.connection, 'email-outbox publish', () => enqueueRegisteredJob(this.queue, job));
  }

  /**
   * email-twenty Decision 2: whether the job of a row's CURRENT generation is still live in BullMQ (waiting, delayed, active,
   * prioritized, waiting-children). The dispatcher asks before failing a row at its re-queue cap, so a row that is only waiting
   * in a backlog is never failed. Bounded like a publish: throws QueuePublishUnavailableError when Redis cannot answer.
   */
  async isLive(emailOutboxId: string, generation: number): Promise<boolean> {
    return boundedPublish(this.connection, 'email-outbox liveness probe', async () => {
      const job = await this.queue.getJob(`email-outbox.${emailOutboxId}.attempt.${generation}`);
      if (!job) return false;
      return LIVE_JOB_STATES.has(await job.getState());
    });
  }

  async onModuleDestroy(): Promise<void> {
    await closeQueueProducer(this.queue, this.connection);
  }
}
