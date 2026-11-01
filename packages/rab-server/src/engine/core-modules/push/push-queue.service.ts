import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { boundedPublish, closeQueueProducer, createQueueProducerConnection } from '../../worker-shared/queue-producer-connection';

import { EnvironmentService } from '../environment/environment.service';
import { PUSH_QUEUE_JOB_NAME, PUSH_QUEUE_NAME, PushQueueJobData } from './push-queue.constants';

/**
 * D5: the same 5 attempts and 5 s exponential base, now with JITTER — each retry waits a random 50–100 % of its
 * exponential step (BullMQ 5.81 `backoff.jitter`), so the retries of many jobs that failed together (a provider or network
 * outage) do not all hit the provider again in the same second.
 */
export const PUSH_QUEUE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000, jitter: 0.5 },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 30 * 24 * 60 * 60 },
};
const QUEUE_OPTIONS = PUSH_QUEUE_JOB_OPTIONS;

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
    // D5: fail fast (no offline queue, bounded commands) — a lost publish is safe, the outbox row is durable.
    this.connection = createQueueProducerConnection(env.get('REDIS_URL'));
    this.queue = new Queue<PushQueueJobData>(PUSH_QUEUE_NAME, { connection: this.connection });
    this.queue.on('error', () => undefined);
  }

  async publish(pushDeliveryId: string, organisationId: string): Promise<void> {
    await boundedPublish(this.connection, 'push-delivery publish', () => this.queue.add(PUSH_QUEUE_JOB_NAME, { pushDeliveryId, organisationId }, { jobId: `push-delivery.${pushDeliveryId}.attempt.0`, ...QUEUE_OPTIONS }));
  }

  async republish(pushDeliveryId: string, organisationId: string, generation: number): Promise<void> {
    await boundedPublish(this.connection, 'push-delivery publish', () => this.queue.add(PUSH_QUEUE_JOB_NAME, { pushDeliveryId, organisationId }, { jobId: `push-delivery.${pushDeliveryId}.attempt.${generation}`, ...QUEUE_OPTIONS }));
  }

  async onModuleDestroy(): Promise<void> {
    await closeQueueProducer(this.queue, this.connection);
  }
}
