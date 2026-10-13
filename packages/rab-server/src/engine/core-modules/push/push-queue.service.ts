import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { EnvironmentService } from '../environment/environment.service';
import { PUSH_QUEUE_JOB_NAME, PUSH_QUEUE_NAME, PushQueueJobData } from './push-queue.constants';

const QUEUE_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};

/**
 * API-process side of the queue — publish only, never consumes. Mirrors `EmailQueueService`
 * exactly, including the two-identity split: the BullMQ jobId changes across a recovery
 * republish (decoupling a new attempt from an old job's terminal state), while this delivery's
 * own stable identity (`push-delivery:<id>`) — used as the idempotency reference in logs/
 * diagnostics, FCM itself has no server-side dedup — never changes.
 */
@Injectable()
export class PushQueueService implements OnModuleDestroy {
  private readonly connection: Redis;
  private readonly queue: Queue<PushQueueJobData>;

  constructor(env: EnvironmentService) {
    this.connection = new Redis(env.get('REDIS_URL'), { maxRetriesPerRequest: null });
    this.queue = new Queue<PushQueueJobData>(PUSH_QUEUE_NAME, { connection: this.connection });
  }

  async publish(pushDeliveryId: string, organisationId: string): Promise<void> {
    await this.queue.add(PUSH_QUEUE_JOB_NAME, { pushDeliveryId, organisationId }, { jobId: `push-delivery.${pushDeliveryId}.attempt.0`, ...QUEUE_OPTIONS });
  }

  async republish(pushDeliveryId: string, organisationId: string, generation: number): Promise<void> {
    await this.queue.add(PUSH_QUEUE_JOB_NAME, { pushDeliveryId, organisationId }, { jobId: `push-delivery.${pushDeliveryId}.attempt.${generation}`, ...QUEUE_OPTIONS });
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
