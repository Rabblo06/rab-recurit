import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { RateLimitModule } from '../../engine/core-modules/rate-limit/rate-limit.module';
import { IdentityModule } from '../identity/identity.module';
import { ManagerWorkspaceModule } from '../manager-workspace/manager-workspace.module';
import { LeadershipCapabilitiesController } from './controllers/leadership-capabilities.controller';
import { ManagerController } from './controllers/manager.controller';
import { OrgAdminVenueManagerController } from './controllers/org-admin-venue-manager.controller';
import { OrganisationInvitationController, OrganisationOnboardingController } from './controllers/organisation-onboarding.controller';
import { VenueManagerController } from './controllers/venue-manager.controller';
import { ManagerService } from './services/manager.service';
import { OrganisationOnboardingService } from './services/organisation-onboarding.service';
import { VenueManagerService } from './services/venue-manager.service';

@Module({
  imports: [AuthModule, IdentityModule, ManagerWorkspaceModule, RateLimitModule],
  controllers: [ManagerController, VenueManagerController, OrgAdminVenueManagerController, OrganisationOnboardingController, OrganisationInvitationController, LeadershipCapabilitiesController],
  providers: [ManagerService, VenueManagerService, OrganisationOnboardingService],
  // Reused by MembershipModule (email-first invitations) so identity creation stays in one place.
  // OrganisationOnboardingService: the public CEO-invitation acceptance (MembershipModule's /invitations/* endpoints).
  exports: [ManagerService, OrganisationOnboardingService],
})
export class ManagerModule {}
