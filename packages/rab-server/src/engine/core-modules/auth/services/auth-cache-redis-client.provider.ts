import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { EnvironmentService } from '../../environment/environment.service';

/**
 * P1E — a SEPARATE `ioredis` client from `ThrottlerRedisClientProvider`/`EmailQueueService`'s own
 * (same Redis deployment, same `REDIS_URL` — no second Redis is introduced), because this one's
 * job is fundamentally different: BullMQ and the distributed throttler need `maxRetriesPerRequest:
 * null` (retry forever — a queue op or a rate-limit check that silently stops retrying is a
 * correctness bug for THEM). An AuthContext cache read sits on the hot path of every authenticated
 * request; it must never make a request wait on Redis. `connectTimeout`/`commandTimeout` bound how
 * long any single operation can take, and `maxRetriesPerRequest: 1` + `enableOfflineQueue: false`
 * mean a disconnected/slow Redis fails FAST, not eventually — `AuthContextCacheService` treats any
 * failure here as a plain cache miss and falls through to PostgreSQL (see its own doc comment for
 * why that is "fail closed on authorization, fail open on speed," never the other way round).
 */
@Injectable()
export class AuthCacheRedisClientProvider implements OnModuleDestroy {
  readonly client: Redis;

  constructor(env: EnvironmentService) {
    this.client = new Redis(env.get('REDIS_URL'), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 500,
      commandTimeout: 150,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    // Never let an ioredis connection-error event become an unhandled 'error' crash — every call
    // site already treats a failed operation as a cache miss; this just stops Node logging it as
    // an uncaught exception on top of that.
    this.client.on('error', () => undefined);
  }

  /**
   * `quit()` is refused while Redis is unreachable (no offline queue → "Stream isn't writeable"), and a client that is
   * never closed keeps its reconnect timer running, so the process cannot exit. Graceful first, then a hard disconnect.
   */
  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => this.client.disconnect());
  }
}
