import { Injectable, OnModuleDestroy } from '@nestjs/common';
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
export class ThrottlerRedisClientProvider implements OnModuleDestroy {
  readonly client: Redis;

  constructor(env: EnvironmentService) {
    this.client = new Redis(env.get('REDIS_URL'), { maxRetriesPerRequest: null });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
