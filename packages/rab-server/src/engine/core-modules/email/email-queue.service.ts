import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { EnvironmentService } from '../environment/environment.service';
import { EMAIL_QUEUE_JOB_NAME, EMAIL_QUEUE_NAME, EmailQueueJobData } from './email-queue.constants';

/**
 * API-process side of the queue — publish only, never consumes. Bounded,
 * backed-off retries live here (not re-derived per call site) so every
 * publisher gets the same policy for free; the worker's own processor
 * additionally classifies retryable-vs-not per attempt (see
 * `email-send.processor.ts`) and can stop early via `UnrecoverableError`
 * regardless of how many attempts remain configured here.
 *
 * `jobId: emailOutboxId` makes `.add()` idempotent by construction — BullMQ
 * silently no-ops (returns the existing job) on a duplicate id, so the
 * request-time fast-path publish and the dispatcher's independent poll-loop
 * publish can never create two distinct queue jobs for the same outbox row.
 */
@Injectable()
export class EmailQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<EmailQueueJobData>;

  constructor(env: EnvironmentService) {
    this.connection = new Redis(env.get('REDIS_URL'), { maxRetriesPerRequest: null });
    this.queue = new Queue<EmailQueueJobData>(EMAIL_QUEUE_NAME, { connection: this.connection });
  }

  async publish(emailOutboxId: string, organisationId: string): Promise<void> {
    await this.queue.add(
      EMAIL_QUEUE_JOB_NAME,
      { emailOutboxId, organisationId },
      {
        jobId: emailOutboxId,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60 },
        removeOnFail: { age: 30 * 24 * 60 * 60 },
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
