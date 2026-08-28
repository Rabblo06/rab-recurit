import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { ManagerWorkspaceController } from './controllers/manager-workspace.controller';
import { ManagerWorkspaceService } from './services/manager-workspace.service';
import { SubdomainService } from './services/subdomain.service';

@Module({
  imports: [AuthModule],
  controllers: [ManagerWorkspaceController],
  providers: [ManagerWorkspaceService, SubdomainService],
})
export class ManagerWorkspaceModule {}
