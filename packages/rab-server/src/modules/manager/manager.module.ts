import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ManagerController } from './controllers/manager.controller';
import { OrgAdminVenueManagerController } from './controllers/org-admin-venue-manager.controller';
import { VenueManagerController } from './controllers/venue-manager.controller';
import { ManagerService } from './services/manager.service';
import { VenueManagerService } from './services/venue-manager.service';

@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [ManagerController, VenueManagerController, OrgAdminVenueManagerController],
  providers: [ManagerService, VenueManagerService],
})
export class ManagerModule {}
