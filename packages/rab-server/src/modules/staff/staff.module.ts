import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { StaffController } from './controllers/staff.controller';
import { StaffAssistantService } from './services/staff-assistant.service';
import { StaffService } from './services/staff.service';

@Module({
  imports: [AuthModule, IdentityModule, SchedulingModule],
  controllers: [StaffController],
  providers: [StaffService, StaffAssistantService],
  // Reused by MembershipModule (email-first invitations) so identity creation stays in one place.
  // StaffAssistantService: AI Phase 3 `get_staff_availability` (counts only).
  exports: [StaffService, StaffAssistantService],
})
export class StaffModule {}
