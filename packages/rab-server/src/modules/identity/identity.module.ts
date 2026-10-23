import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { EntityCacheModule } from '../../engine/core-modules/entity-cache/entity-cache.module';
import { AdminOrganisationSettingsController } from './controllers/admin-organisation-settings.controller';
import { ProfileController } from './controllers/profile.controller';
import { RoleController } from './controllers/role.controller';
import { WorkspaceController } from './controllers/workspace.controller';
import { EmailChangeController } from './controllers/email-change.controller';
import { EmailChangeService } from './services/email-change.service';
import { MemberRolePolicyService } from './services/member-role-policy.service';
import { OrganisationSettingsAdminService } from './services/organisation-settings-admin.service';
import { ProfileService } from './services/profile.service';
import { RoleService } from './services/role.service';
import { UserNoteService } from './services/user-note.service';
import { WorkspaceService } from './services/workspace.service';

@Module({
  imports: [AuthModule, EntityCacheModule],
  controllers: [ProfileController, WorkspaceController, RoleController, EmailChangeController, AdminOrganisationSettingsController],
  providers: [ProfileService, WorkspaceService, RoleService, UserNoteService, MemberRolePolicyService, EmailChangeService, OrganisationSettingsAdminService],
  exports: [UserNoteService, MemberRolePolicyService, EmailChangeService],
})
export class IdentityModule {}
