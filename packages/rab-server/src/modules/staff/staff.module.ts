import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { SchedulingModule } from '../scheduling/scheduling.module';
import { StaffController } from './controllers/staff.controller';
import { StaffService } from './services/staff.service';

@Module({
  imports: [AuthModule, IdentityModule, SchedulingModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
