import Redis, { RedisOptions } from 'ioredis';

/**
 * D5 (D0-C §1.4, §4.12): the Redis client of a BullMQ queue PRODUCER whose publish is safe to lose — the outbox row it
 * points at is durable and a dispatcher republishes it — must FAIL FAST during an outage instead of hanging:
 *  - `enableOfflineQueue: false`: a command issued while disconnected rejects at once (ioredis' default queues it, and with
 *    `maxRetriesPerRequest: null` that queue was never flushed with an error — every publish pended until Redis returned);
 *  - `maxRetriesPerRequest: 1` + `commandTimeout`: an in-flight command is bounded;
 *  - `connectTimeout`: a dead endpoint is noticed quickly.
 * Same settings as the AI turn producer (ai-turn-queue.service.ts), the codebase's existing fail-fast precedent. BullMQ
 * needs `maxRetriesPerRequest: null` only for BLOCKING (Worker/consumer) connections, never for a Queue producer.
 *
 * Used by EmailQueueService (API fast publish, admin email replay, Worker email dispatcher) and PushQueueService (Worker
 * push dispatcher). NOT for consumers, subscribers or the Worker's main BullMQ connection (blocking: they keep their own).
 */
export const QUEUE_PRODUCER_REDIS_OPTIONS: Readonly<RedisOptions> = Object.freeze({
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  commandTimeout: 3_000,
});

/**
 * Upper bound on one whole publish, including the wait for a client that is still making its FIRST connection (BullMQ's
 * Queue awaits readiness before its first command, and that wait has no timeout of its own: with Redis down at boot it
 * never settles).
 */
export const QUEUE_PUBLISH_TIMEOUT_MS = 3_000;

/** A publish that did not reach Redis. Safe to log and drop: the outbox row is durable and will be dispatched again. */
export class QueuePublishUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueuePublishUnavailableError';
  }
}

export function createQueueProducerConnection(url: string): Redis {
  const connection = new Redis(url, { ...QUEUE_PRODUCER_REDIS_OPTIONS });
  // Without a listener a connection error is an unhandled 'error' event. Publish failures are reported by the caller.
  connection.on('error', () => undefined);
  return connection;
}

/** ioredis states in which a command can only fail (a first connection in progress is waited for, bounded). */
const DOWN_STATES = new Set(['reconnecting', 'close', 'end']);

/**
 * Runs `add` (a BullMQ `queue.add`) with a hard upper bound. Rejects at once with QueuePublishUnavailableError when the
 * client is known to be disconnected, so nothing accumulates in memory during an outage.
 */
export async function boundedPublish<T>(connection: Redis, label: string, add: () => Promise<T>, timeoutMs: number = QUEUE_PUBLISH_TIMEOUT_MS): Promise<T> {
  if (DOWN_STATES.has(connection.status)) {
    throw new QueuePublishUnavailableError(`${label}: Redis is unavailable (${connection.status}); not published — the outbox row is durable and will be dispatched later.`);
  }
  let timer: NodeJS.Timeout | undefined;
  const pending = add();
  // A publish abandoned by the timeout may still settle later: never an unhandled rejection.
  pending.catch(() => undefined);
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new QueuePublishUnavailableError(`${label}: Redis did not accept the publish within ${timeoutMs} ms; the outbox row is durable and will be dispatched later.`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (error instanceof QueuePublishUnavailableError) throw error;
    throw Object.assign(
      new QueuePublishUnavailableError(`${label}: Redis publish failed (${(error as Error)?.message ?? String(error)}); the outbox row is durable and will be dispatched later.`),
      { cause: error },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Bounded shutdown of a producer queue + its own connection (never hangs on a dead Redis). */
export async function closeQueueProducer(queue: { close(): Promise<void> }, connection: Redis, timeoutMs = 2_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([queue.close().catch(() => undefined), new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  if (timer) clearTimeout(timer);
  if (connection.status === 'ready') {
    await connection.quit().catch(() => connection.disconnect());
  } else {
    connection.disconnect();
  }
}
