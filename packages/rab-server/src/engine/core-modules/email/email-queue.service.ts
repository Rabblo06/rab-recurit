import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { EnvironmentService } from '../environment/environment.service';
import { EMAIL_QUEUE_JOB_NAME, EMAIL_QUEUE_NAME, EmailQueueJobData } from './email-queue.constants';

const QUEUE_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};

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
 *    (completed, retained up to 7 days; or failed-and-removed) can no
 *    longer have that old job silently swallow the new attempt — a fresh
 *    generation gets a fresh jobId, decoupled from the old job's fate.
 */
@Injectable()
export class EmailQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<EmailQueueJobData>;

  constructor(env: EnvironmentService) {
    this.connection = new Redis(env.get('REDIS_URL'), { maxRetriesPerRequest: null });
    this.queue = new Queue<EmailQueueJobData>(EMAIL_QUEUE_NAME, { connection: this.connection });
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
    await this.queue.add(EMAIL_QUEUE_JOB_NAME, { emailOutboxId, organisationId }, { jobId: `email-outbox.${emailOutboxId}.attempt.0`, ...QUEUE_OPTIONS });
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
    await this.queue.add(EMAIL_QUEUE_JOB_NAME, { emailOutboxId, organisationId }, { jobId: `email-outbox.${emailOutboxId}.attempt.${generation}`, ...QUEUE_OPTIONS });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
