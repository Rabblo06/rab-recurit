import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { ProfileController } from './controllers/profile.controller';
import { RoleController } from './controllers/role.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import { ProfileService } from './services/profile.service';
import { RoleService } from './services/role.service';
import { WorkspaceService } from './services/workspace.service';

@Module({
  imports: [AuthModule],
  controllers: [ProfileController, WorkspaceController, RoleController],
  providers: [ProfileService, WorkspaceService, RoleService],
})
export class IdentityModule {}
