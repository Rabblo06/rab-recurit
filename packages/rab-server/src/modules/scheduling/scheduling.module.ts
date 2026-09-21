import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { VenueModule } from '../venue/venue.module';
import { SchedulingController } from './controllers/scheduling.controller';
import { AvailabilityService } from './services/availability.service';
import { SchedulingService } from './services/scheduling.service';

@Module({
  imports: [AuthModule, NotificationModule, VenueModule],
  controllers: [SchedulingController],
  providers: [SchedulingService, AvailabilityService],
  exports: [SchedulingService, AvailabilityService],
})
export class SchedulingModule {}
