import { Injectable, OnModuleDestroy } from '@nestjs/common';

import { AuthCacheRedisClientProvider } from '../auth/services/auth-cache-redis-client.provider';
import { RealtimeSubscriber } from './realtime-subscriber';

/**
 * ONE shared `RealtimeSubscriber` per API process instance — never one per connected client, per
 * the explicit "no Redis connection per connected user" requirement. Every SSE connection this
 * process holds calls `.subscribe(channel, handler)`/`.unsubscribe(channel, handler)` on this SAME
 * instance; `RealtimeSubscriber` itself already only issues a real Redis `SUBSCRIBE`/`UNSUBSCRIBE`
 * when the first handler for a channel arrives / the last one leaves (see that class's own doc
 * comment) — this provider adds no new logic, it just gives the gateway module one injectable,
 * singleton place to reach it from.
 *
 * Built from `AuthCacheRedisClientProvider`'s existing client (`.duplicate()`, inside
 * `RealtimeSubscriber`'s own constructor) — reusing the already-configured `REDIS_URL` connection
 * rather than opening a second one from scratch.
 */
@Injectable()
export class RealtimeGatewaySubscriberProvider implements OnModuleDestroy {
  readonly subscriber: RealtimeSubscriber;

  constructor(authCacheRedis: AuthCacheRedisClientProvider) {
    this.subscriber = new RealtimeSubscriber(authCacheRedis.client);
  }

  async onModuleDestroy(): Promise<void> {
    await this.subscriber.close();
  }
}
