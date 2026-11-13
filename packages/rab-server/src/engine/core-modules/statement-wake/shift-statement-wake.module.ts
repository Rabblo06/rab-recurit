import { Global, Module } from '@nestjs/common';

import { ShiftStatementWakeService } from './shift-statement-wake.service';

/**
 * Phase X J1b: the pay-statement dispatcher wake (API only; the Worker never imports it). Global like TimerTriggerModule so
 * the payroll service resolves the one instance. With WORKER_SCHEDULER=interval it opens no Redis connection.
 */
@Global()
@Module({
  providers: [ShiftStatementWakeService],
  exports: [ShiftStatementWakeService],
})
export class ShiftStatementWakeModule {}
