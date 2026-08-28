import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { VenueController } from './controllers/venue.controller';
import { VenueService } from './services/venue.service';

@Module({
  imports: [AuthModule],
  controllers: [VenueController],
  providers: [VenueService],
  exports: [VenueService],
})
export class VenueModule {}
