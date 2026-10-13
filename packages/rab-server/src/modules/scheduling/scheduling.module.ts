import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { EntityCacheModule } from '../../engine/core-modules/entity-cache/entity-cache.module';
import { NotificationModule } from '../notification/notification.module';
import { VenueModule } from '../venue/venue.module';
import { SchedulingController } from './controllers/scheduling.controller';
import { AvailabilityService } from './services/availability.service';
import { SchedulingService } from './services/scheduling.service';

@Module({
  imports: [AuthModule, NotificationModule, VenueModule, EntityCacheModule],
  controllers: [SchedulingController],
  providers: [SchedulingService, AvailabilityService],
  exports: [SchedulingService, AvailabilityService],
})
export class SchedulingModule {}
