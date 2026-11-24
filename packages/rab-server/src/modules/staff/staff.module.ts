import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { EntityCacheModule } from '../../engine/core-modules/entity-cache/entity-cache.module';
import { IdentityModule } from '../identity/identity.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { StaffRoleRateController } from './controllers/staff-role-rate.controller';
import { StaffController } from './controllers/staff.controller';
import { StaffRoleRateService } from './services/staff-role-rate.service';
import { StaffService } from './services/staff.service';

@Module({
  imports: [AuthModule, EntityCacheModule, IdentityModule, SchedulingModule],
  controllers: [StaffController, StaffRoleRateController],
  providers: [StaffService, StaffRoleRateService],
  // Reused by MembershipModule (email-first invitations) so identity creation stays in one place.
  exports: [StaffService],
})
export class StaffModule {}
