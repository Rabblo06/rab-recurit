import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

import { enqueueRegisteredJob, registeredJob } from '../../worker-shared/queue-enqueue';
import { boundedPublish, closeQueueProducer, createQueueProducerConnection } from '../../worker-shared/queue-producer-connection';
import { bullmqJobOptionsOf, OutboxJobOptions } from '../../worker-shared/queue-registry';

import { EnvironmentService } from '../environment/environment.service';
import { PUSH_QUEUE_JOB_NAME, PUSH_QUEUE_NAME, PushQueueJobData } from './push-queue.constants';

/**
 * D5: the same 5 attempts and 5 s exponential base, now with JITTER — each retry waits a random 50–100 % of its
 * exponential step (BullMQ 5.81 `backoff.jitter`), so the retries of many jobs that failed together (a provider or network
 * outage) do not all hit the provider again in the same second. D-Q1: read from the queue registry (values unchanged).
 */
export const PUSH_QUEUE_JOB_OPTIONS = Object.freeze(bullmqJobOptionsOf(PUSH_QUEUE_NAME) as OutboxJobOptions);

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
    await this.add(pushDeliveryId, organisationId, 0);
  }

  async republish(pushDeliveryId: string, organisationId: string, generation: number): Promise<void> {
    await this.add(pushDeliveryId, organisationId, generation);
  }

  /** D-Q1: the delivery row's own organisation as the declared tenant scope; validated before the bounded publish. */
  private async add(pushDeliveryId: string, organisationId: string, generation: number): Promise<void> {
    const data: PushQueueJobData = { pushDeliveryId, organisationId };
    const job = registeredJob(PUSH_QUEUE_NAME, PUSH_QUEUE_JOB_NAME, { kind: 'organisation', organisationId }, data, {
      jobId: `push-delivery.${pushDeliveryId}.attempt.${generation}`,
    });
    await boundedPublish(this.connection, 'push-delivery publish', () => enqueueRegisteredJob(this.queue, job));
  }

  async onModuleDestroy(): Promise<void> {
    await closeQueueProducer(this.queue, this.connection);
  }
}
