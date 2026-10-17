import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import { EnvironmentService } from '../environment/environment.service';

/**
 * A raw `ioredis` client created outside Nest's own provider graph (as the
 * old inline `new Redis(...)` in the throttler factory was) never gets its
 * connection closed on shutdown — Nest only runs lifecycle hooks
 * (`onModuleDestroy`) on registered providers. Wrapping it in one lets
 * `app.close()` actually quit the connection instead of leaking it (visible
 * in the integration suite as "a worker process has failed to exit
 * gracefully" — the same leak would exist in production on every deploy/restart).
 */
@Injectable()
export class ThrottlerRedisClientProvider implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(env: EnvironmentService) {
    // CF-17: bounded. Without an offline queue a command fails at once while disconnected; `commandTimeout` bounds a
    // hung server; reconnection continues in the background with a capped backoff. (Previously
    // `maxRetriesPerRequest: null` + the default offline queue made every request wait indefinitely during an outage.)
    this.client = new Redis(env.get('REDIS_URL'), {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });
    // A connection error is surfaced per request by RabThrottlerGuard; without a listener ioredis would log every retry.
    this.client.on('error', () => undefined);
  }

  /** Waits (bounded) for the first connection so the first requests after boot are not refused; never blocks boot on an outage. */
  async onModuleInit(): Promise<void> {
    if (this.client.status === 'ready') return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      this.client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
