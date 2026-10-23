import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '../auth/auth.module';
import { ThrottlerRedisClientModule } from '../throttler/throttler-redis-client.module';
import { AdminInspectController } from './admin-inspect.controller';
import { AdminOutboxController } from './admin-outbox.controller';
import { AdminPanelController } from './admin-panel.controller';
import { AdminPanelService } from './admin-panel.service';
import { OutboxOperationsService } from './outbox-operations.service';

@Module({
  imports: [AuthModule, TerminusModule, ThrottlerRedisClientModule],
  // Wave 5 lane OPS: AdminOutboxController / OutboxOperationsService (failed-outbox listing, audited email replay,
  // queue observability) — exported for the `outbox:replay` CLI.
  controllers: [AdminPanelController, AdminInspectController, AdminOutboxController],
  providers: [AdminPanelService, OutboxOperationsService],
  exports: [OutboxOperationsService],
})
export class AdminPanelModule {}
