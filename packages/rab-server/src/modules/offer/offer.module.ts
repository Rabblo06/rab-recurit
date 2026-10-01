import { IdentityModule } from '../identity/identity.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { VenueOfferPipelineService } from './services/venue-offer-pipeline.service';
import { VenueOfferPipelineController } from './controllers/venue-offer-pipeline.controller';
import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { VenueModule } from '../venue/venue.module';
import { OfferController } from './controllers/offer.controller';
import { ReplacementRequestController } from './controllers/replacement-request.controller';
import { OfferService } from './services/offer.service';
import { ReplacementRequestService } from './services/replacement-request.service';

@Module({
  imports: [IdentityModule, AttendanceModule, AuthModule, NotificationModule, SchedulingModule, VenueModule],
  controllers: [VenueOfferPipelineController, OfferController, ReplacementRequestController],
  providers: [VenueOfferPipelineService, OfferService, ReplacementRequestService],
})
export class OfferModule {}
