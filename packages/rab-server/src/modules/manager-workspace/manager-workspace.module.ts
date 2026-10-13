import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { EntityCacheModule } from '../../engine/core-modules/entity-cache/entity-cache.module';
import { ManagerWorkspaceController } from './controllers/manager-workspace.controller';
import { ManagerWorkspaceService } from './services/manager-workspace.service';
import { SubdomainService } from './services/subdomain.service';

@Module({
  imports: [AuthModule, EntityCacheModule],
  controllers: [ManagerWorkspaceController],
  providers: [ManagerWorkspaceService, SubdomainService],
  // P2.9C — ManagerModule needs ManagerWorkspaceService.createFor() for Initial Manager invitations.
  // Never imported back from ManagerModule's own direction, so no cycle.
  exports: [ManagerWorkspaceService, SubdomainService],
})
export class ManagerWorkspaceModule {}
