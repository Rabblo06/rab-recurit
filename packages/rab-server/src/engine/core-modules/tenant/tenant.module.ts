import { Global, Module } from '@nestjs/common';

import { TenantContextService } from './tenant-context.service';
import { WorkspaceResolverService } from './workspace-resolver.service';

@Global()
@Module({
  providers: [TenantContextService, WorkspaceResolverService],
  exports: [TenantContextService, WorkspaceResolverService],
})
export class TenantModule {}
