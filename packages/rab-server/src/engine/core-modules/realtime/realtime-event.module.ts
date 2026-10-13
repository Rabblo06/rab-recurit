import { Module } from '@nestjs/common';

import { RealtimeEventService } from './realtime-event.service';

@Module({
  providers: [RealtimeEventService],
  exports: [RealtimeEventService],
})
export class RealtimeEventModule {}
