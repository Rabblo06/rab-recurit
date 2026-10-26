import { Module } from '@nestjs/common';

import { SchedulingModule } from '../scheduling/scheduling.module';
import { StaffAssistantService } from './services/staff-assistant.service';

/**
 * AI Phase 3: the staff read model of `get_staff_availability`, in its own lean module so the AI core (imported by BOTH
 * the API and the Worker) does not pull in `StaffModule` — whose `StaffService` needs API-only providers (e.g.
 * `UserDeletionService`) that the Worker graph does not have. Depends only on global providers (tenant context,
 * permissions, resource scope, member access) and `AvailabilityService` (the ONE busy rule, SchedulingModule).
 */
@Module({
  imports: [SchedulingModule],
  providers: [StaffAssistantService],
  exports: [StaffAssistantService],
})
export class StaffAssistantModule {}
