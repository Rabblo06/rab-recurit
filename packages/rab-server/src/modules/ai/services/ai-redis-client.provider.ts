import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';

/**
 * The AI module's own bounded Redis client (quota scripts, turn streams, cancel flags, the BullMQ producer). Same shape
 * as ThrottlerRedisClientProvider (CF-17): no offline queue, one retry, short connect/command timeouts — so an outage
 * fails the AI request at once (503, fail closed) instead of hanging it. Never logs connection errors (they would repeat
 * every reconnect); each caller maps a failure to AiQuotaUnavailableError.
 */
@Injectable()
export class AiRedisClientProvider implements OnModuleInit, OnModuleDestroy {
  readonly client: Redis;

  constructor(env: EnvironmentService) {
    this.client = new Redis(env.get('REDIS_URL'), {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
    });
    this.client.on('error', () => undefined);
  }

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
