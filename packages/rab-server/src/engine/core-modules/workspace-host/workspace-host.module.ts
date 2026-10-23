import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { EntityCacheModule } from '../entity-cache/entity-cache.module';
import { PublicWorkspaceHostController } from './public-workspace-host.controller';
import { WorkspaceHostConsistencyInterceptor } from './workspace-host-consistency.interceptor';
import { WorkspaceHostLookupService } from './workspace-host-lookup.service';
import { WorkspaceHostMiddleware } from './workspace-host.middleware';
import { WorkspaceHostResolverService } from './workspace-host-resolver.service';
import { WorkspaceOriginTrustService } from './workspace-origin-trust.service';

/**
 * Wave 3 lane H — workspace host routing (engine machinery: never imports from `modules/`). The middleware applies to
 * every route; the interceptor is global (APP_INTERCEPTOR). EnvironmentModule and TenantModule are @Global.
 */
@Module({
  imports: [EntityCacheModule],
  controllers: [PublicWorkspaceHostController],
  providers: [
    WorkspaceHostLookupService,
    WorkspaceHostResolverService,
    WorkspaceOriginTrustService,
    WorkspaceHostMiddleware,
    { provide: APP_INTERCEPTOR, useClass: WorkspaceHostConsistencyInterceptor },
  ],
  exports: [WorkspaceHostResolverService, WorkspaceOriginTrustService],
})
export class WorkspaceHostModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(WorkspaceHostMiddleware).forRoutes('*');
  }
}
