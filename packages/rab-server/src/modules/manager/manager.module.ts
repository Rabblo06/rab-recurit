import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ManagerWorkspaceModule } from '../manager-workspace/manager-workspace.module';
import { ManagerController } from './controllers/manager.controller';
import { OrgAdminVenueManagerController } from './controllers/org-admin-venue-manager.controller';
import { OrganisationOnboardingController } from './controllers/organisation-onboarding.controller';
import { VenueManagerController } from './controllers/venue-manager.controller';
import { ManagerService } from './services/manager.service';
import { OrganisationOnboardingService } from './services/organisation-onboarding.service';
import { VenueManagerService } from './services/venue-manager.service';

@Module({
  imports: [AuthModule, IdentityModule, ManagerWorkspaceModule],
  controllers: [ManagerController, VenueManagerController, OrgAdminVenueManagerController, OrganisationOnboardingController],
  providers: [ManagerService, VenueManagerService, OrganisationOnboardingService],
  // Reused by MembershipModule (email-first invitations) so identity creation stays in one place.
  exports: [ManagerService],
})
export class ManagerModule {}
