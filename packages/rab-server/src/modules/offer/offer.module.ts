import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { NotificationModule } from '../notification/notification.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { OfferController } from './controllers/offer.controller';
import { OfferService } from './services/offer.service';

@Module({
  imports: [AuthModule, NotificationModule, SchedulingModule],
  controllers: [OfferController],
  providers: [OfferService],
})
export class OfferModule {}
