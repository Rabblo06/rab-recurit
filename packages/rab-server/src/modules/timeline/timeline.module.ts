import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { PayrollModule } from '../payroll/payroll.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { StaffModule } from '../staff/staff.module';
import { TimelineController } from './controllers/timeline.controller';
import { TimelineService } from './services/timeline.service';

/** Wave 5 — read model over core.audit_log (no new write path). */
@Module({
  imports: [AuthModule, SchedulingModule, StaffModule, PayrollModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
