import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { FirstPeerLogMiddleware } from './first-peer-log.middleware';

/**
 * The trusted-proxy request machinery that lives in the Nest app (engine; never imports `modules/`). The trust decision
 * itself is engine/utils/trusted-proxy.util.ts (Express `trust proxy` and resolveClientIp share it). This module adds the
 * opt-in CREWFLOW_LOG_FIRST_PEER diagnostic, applied to every route; with the switch off it only checks one boolean.
 * EnvironmentModule is @Global.
 */
@Module({
  providers: [FirstPeerLogMiddleware],
})
export class TrustedProxyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(FirstPeerLogMiddleware).forRoutes('*');
  }
}
