import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { RateLimitModule } from '../../engine/core-modules/rate-limit/rate-limit.module';
import { WorkspaceHostModule } from '../../engine/core-modules/workspace-host/workspace-host.module';
import { IdentityModule } from '../identity/identity.module';
import { ManagerModule } from '../manager/manager.module';
import { InvitationAcceptanceController } from './controllers/invitation-acceptance.controller';
import { MemberInvitationController } from './controllers/member-invitation.controller';
import { MembersController } from './controllers/members.controller';
import { MemberInvitationService } from './services/member-invitation.service';
import { MembersService } from './services/members.service';

/**
 * Settings → Members: the Team list (real workspace memberships) and email-first invitations of custom
 * workspace-member roles. Role rules come from IdentityModule's `MemberRolePolicyService`, so the Roles tab, Invite
 * and acceptance all apply one policy. Recruitment Staff / Venue Manager creation is NOT part of this module.
 */
@Module({
  imports: [AuthModule, IdentityModule, RateLimitModule, WorkspaceHostModule, ManagerModule],
  controllers: [MemberInvitationController, InvitationAcceptanceController, MembersController],
  providers: [MemberInvitationService, MembersService],
})
export class MembershipModule {}
