import { Global, Module } from '@nestjs/common';

import { TimerTriggerQueueService } from './timer-trigger-queue.service';

/**
 * Phase D-Q4b: the timer-trigger producer, global like EmailModule/PushModule so the offer service (API) and the Worker's
 * shift-monitor arming resolve the same single instance. With WORKER_TIMER_TRIGGERS=off it opens no Redis connection.
 */
@Global()
@Module({
  providers: [TimerTriggerQueueService],
  exports: [TimerTriggerQueueService],
})
export class TimerTriggerModule {}
