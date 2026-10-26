import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AI_PUBSUB_MAX_PAYLOAD_BYTES } from '../constants/ai.constants';

export type AiPubSubHandler = (payload: string) => void;

/**
 * The AI module's dedicated Redis SUBSCRIBER connection (docs/ai/PHASE2_TWENTY_PLAN.md §2.3). A connection in subscribe
 * mode cannot run ordinary commands, so it cannot share `AiRedisClientProvider`; one per process (API: one channel per
 * open SSE conversation; Worker: one per in-flight turn's conversation), reference-counted per channel.
 *
 * Bounded and quiet like `AiRedisClientProvider`: short connect timeout, bounded reconnect back-off, no offline queue (a
 * SUBSCRIBE while the connection is down fails at once instead of waiting), connection errors never logged. Connected
 * lazily on the first subscription.
 *
 * Messages are HINTS ONLY (`{t,id}` wake-ups, `{t}` cancels — never text, P2-C4). Every consumer re-reads the durable
 * source (the Redis STREAM with its own cursor; the cancel flag / `cancel_requested_at`) before acting, and works
 * correctly with no message at all: when `ready` is false the SSE polls at 250 ms and the Worker relies on the flag (500 ms)
 * and the database (lease renewal). A payload larger than AI_PUBSUB_MAX_PAYLOAD_BYTES is dropped unread.
 */
@Injectable()
export class AiRedisSubscriberProvider implements OnModuleDestroy {
  private client: Redis | null = null;
  private readonly handlers = new Map<string, Set<AiPubSubHandler>>();
  private closed = false;

  constructor(private readonly env: EnvironmentService) {}

  /** True while the subscriber connection is up (consumers then use their slower fallback poll). */
  get ready(): boolean {
    return this.client?.status === 'ready';
  }

  /** Channels with at least one handler (metrics / tests). */
  channelCount(): number {
    return this.handlers.size;
  }

  /** The underlying connection, created on demand (tests disconnect it to prove the fallback). */
  connection(): Redis {
    if (this.client) return this.client;
    const client = new Redis(this.env.get('REDIS_URL'), {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      retryStrategy: (attempt) => (this.closed ? null : Math.min(attempt * 200, 2_000)),
      // ioredis re-subscribes every channel after a reconnect by itself.
      autoResubscribe: true,
    });
    client.on('error', () => undefined);
    client.on('message', (channel: string, message: string) => this.dispatch(channel, message));
    this.client = client;
    return client;
  }

  /**
   * Adds `handler` to `channel` and returns its unsubscribe function. Never throws: a subscription that cannot be made
   * now (Redis down) is retried by ioredis when the connection comes back; the caller's fallback poll covers the gap.
   */
  async subscribe(channel: string, handler: AiPubSubHandler): Promise<() => void> {
    let set = this.handlers.get(channel);
    const first = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    if (first) await this.ensureSubscribed(channel);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const current = this.handlers.get(channel);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(channel);
        if (this.client && !this.closed) void this.client.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
    if (this.client) await this.client.quit().catch(() => this.client?.disconnect());
  }

  private async ensureSubscribed(channel: string): Promise<void> {
    if (this.closed) return;
    const client = this.connection();
    if (client.status === 'wait' || client.status === 'end') await client.connect().catch(() => undefined);
    // Without the offline queue a SUBSCRIBE issued while down fails at once; ioredis's autoResubscribe only replays
    // channels it already had, so a failed first SUBSCRIBE is re-issued when the connection becomes ready.
    await client.subscribe(channel).catch(() => {
      client.once('ready', () => {
        if (this.handlers.has(channel)) void client.subscribe(channel).catch(() => undefined);
      });
    });
  }

  private dispatch(channel: string, message: string): void {
    if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > AI_PUBSUB_MAX_PAYLOAD_BYTES) return;
    const set = this.handlers.get(channel);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(message);
      } catch {
        // A hint handler never breaks the connection or another subscriber.
      }
    }
  }
}
