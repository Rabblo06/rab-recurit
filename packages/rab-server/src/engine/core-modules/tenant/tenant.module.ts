import { Global, Module } from '@nestjs/common';

import { SchemaResolverService } from './schema-resolver.service';
import { TenantContextService } from './tenant-context.service';
import { WorkspaceExecutionContext } from './workspace-execution-context';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WorkspaceResolverService } from './workspace-resolver.service';

@Global()
@Module({
  // SchemaResolverService and WorkspaceExecutionContext registered (HWS runtime cutover, Part 2/3): TenantContextService
  // now depends on SchemaResolverService for every call, and WorkspaceExecutionContext — the explicit canonical boundary
  // for new/worker code that wants its own transaction rather than going through runInTenantContext — needs both a real
  // DataSource (Nest-injected automatically; no provider entry required) and this resolver.
  providers: [TenantContextService, WorkspaceResolverService, WorkspaceMembershipService, SchemaResolverService, WorkspaceExecutionContext],
  exports: [TenantContextService, WorkspaceResolverService, WorkspaceMembershipService, SchemaResolverService, WorkspaceExecutionContext],
})
export class TenantModule {}
