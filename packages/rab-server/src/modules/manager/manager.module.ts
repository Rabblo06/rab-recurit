import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { ManagerController } from './controllers/manager.controller';
import { ManagerService } from './services/manager.service';

@Module({
  imports: [AuthModule, IdentityModule],
  controllers: [ManagerController],
  providers: [ManagerService],
})
export class ManagerModule {}
