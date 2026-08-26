import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '../auth/auth.module';
import { ThrottlerRedisClientModule } from '../throttler/throttler-redis-client.module';
import { AdminInspectController } from './admin-inspect.controller';
import { AdminPanelController } from './admin-panel.controller';
import { AdminPanelService } from './admin-panel.service';

@Module({
  imports: [AuthModule, TerminusModule, ThrottlerRedisClientModule],
  controllers: [AdminPanelController, AdminInspectController],
  providers: [AdminPanelService],
})
export class AdminPanelModule {}
