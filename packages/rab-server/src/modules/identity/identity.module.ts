import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { EntityCacheModule } from '../../engine/core-modules/entity-cache/entity-cache.module';
import { ProfileController } from './controllers/profile.controller';
import { RoleController } from './controllers/role.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import { ProfileService } from './services/profile.service';
import { RoleService } from './services/role.service';
import { UserNoteService } from './services/user-note.service';
import { WorkspaceService } from './services/workspace.service';

@Module({
  imports: [AuthModule, EntityCacheModule],
  controllers: [ProfileController, WorkspaceController, RoleController],
  providers: [ProfileService, WorkspaceService, RoleService, UserNoteService],
  exports: [UserNoteService],
})
export class IdentityModule {}
