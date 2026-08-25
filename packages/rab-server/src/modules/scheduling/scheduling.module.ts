import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { SchedulingController } from './controllers/scheduling.controller';
import { SchedulingService } from './services/scheduling.service';

@Module({
  imports: [AuthModule],
  controllers: [SchedulingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
