import { Queue } from 'bullmq';
import type Redis from 'ioredis';

import { boundedPublish, closeQueueProducer } from '@rab/server/engine/worker-shared/queue-producer-connection';

/**
 * Lead follow-up (C-report §6.1): a BullMQ PRODUCER queue for the Worker whose every `add` is bounded by Agent C's
 * `boundedPublish` and runs on its OWN fail-fast connection (`createQueueProducerConnection`: no offline queue, bounded
 * commandTimeout) — never the Worker's blocking main connection (`maxRetriesPerRequest: null` + offline queue, where an
 * `add` during a Redis outage pended forever and wedged the dispatcher that awaited it).
 *
 * A rejected `add` (QueuePublishUnavailableError) is safe to drop: the publish happens only AFTER the row's claim
 * committed, so the row stays claimed under its lease and is re-dispatched (statements: the 10-minute queued/processing
 * lease re-queues it with a new generation; global mode: the trigger re-timed its pointer). The jobId / options the
 * caller passes are unchanged.
 */
export class BoundedProducerQueue<D> extends Queue<D> {
  constructor(
    name: string,
    private readonly producerConnection: Redis,
    private readonly label: string,
  ) {
    super(name, { connection: producerConnection });
    // Reconnect noise during an outage: the failed publish itself is reported by its caller.
    this.on('error', () => undefined);
  }

  override add(...args: Parameters<Queue<D>['add']>): ReturnType<Queue<D>['add']> {
    return boundedPublish(this.producerConnection, this.label, () => super.add(...args)) as ReturnType<Queue<D>['add']>;
  }

  /** Bounded shutdown of the queue and its own connection (never hangs on a dead Redis). */
  closeBounded(timeoutMs?: number): Promise<void> {
    return closeQueueProducer(this, this.producerConnection, timeoutMs);
  }
}
