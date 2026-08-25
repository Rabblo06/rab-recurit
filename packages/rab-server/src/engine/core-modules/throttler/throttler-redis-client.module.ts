import { Module } from '@nestjs/common';

import { EnvironmentModule } from '../environment/environment.module';
import { ThrottlerRedisClientProvider } from './throttler-redis-client.provider';

/**
 * Split out from `RabThrottlerModule` so `ThrottlerModule.forRootAsync`'s own
 * `imports` can pull in the same `ThrottlerRedisClientProvider` singleton its
 * factory needs to inject — a dynamic module's async factory only resolves
 * providers reachable through its own `imports`, not a sibling provider
 * declared directly on the module that happens to import it.
 */
@Module({
  imports: [EnvironmentModule],
  providers: [ThrottlerRedisClientProvider],
  exports: [ThrottlerRedisClientProvider],
})
export class ThrottlerRedisClientModule {}
