import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { ManagerController } from './controllers/manager.controller';
import { ManagerService } from './services/manager.service';

@Module({
  imports: [AuthModule],
  controllers: [ManagerController],
  providers: [ManagerService],
})
export class ManagerModule {}
