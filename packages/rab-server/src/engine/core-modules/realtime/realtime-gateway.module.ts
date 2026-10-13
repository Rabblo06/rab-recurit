import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RealtimeConnectionRegistryService } from './realtime-connection-registry.service';
import { RealtimeGatewayController } from './realtime-gateway.controller';
import { RealtimeGatewaySubscriberProvider } from './realtime-gateway-subscriber.provider';

/**
 * Stage 3 — wires the authenticated real-time gateway. Imports `AuthModule` for `JwtAuthGuard`,
 * `SecurityVersionService` and `AuthCacheRedisClientProvider` (all already exported by it for
 * exactly this kind of reuse — see that module's own doc comments); `TenantContextService` needs
 * no import since `TenantModule` is `@Global()`.
 */
@Module({
  imports: [AuthModule],
  controllers: [RealtimeGatewayController],
  providers: [RealtimeConnectionRegistryService, RealtimeGatewaySubscriberProvider],
})
export class RealtimeGatewayModule {}
