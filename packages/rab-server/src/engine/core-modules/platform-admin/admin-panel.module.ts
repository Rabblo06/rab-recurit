import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AuthModule } from '../auth/auth.module';
import { ThrottlerRedisClientModule } from '../throttler/throttler-redis-client.module';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuditService } from './admin-audit.service';
import { AdminConfigService } from './admin-config.service';
import { AdminHealthService } from './admin-health.service';
import { AdminInspectController } from './admin-inspect.controller';
import { AdminQueuesController } from './admin-queues.controller';
import { AdminQueuesService } from './admin-queues.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminWorkspacesController } from './admin-workspaces.controller';
import { AdminWorkspacesService } from './admin-workspaces.service';
import { AdminOutboxController } from './admin-outbox.controller';
import { AdminPanelController } from './admin-panel.controller';
import { AdminPanelService } from './admin-panel.service';
import { OutboxOperationsService } from './outbox-operations.service';

@Module({
  imports: [AuthModule, TerminusModule, ThrottlerRedisClientModule],
  // Wave 5 lane OPS: AdminOutboxController / OutboxOperationsService (failed-outbox listing, audited email replay,
  // queue observability) — exported for the `outbox:replay` CLI.
  // Crewflow Platform Admin Panel (docs/admin-panel/PHASE_A_PLAN.md §3): users/lookup, queues, workspaces, audit,
  // health probes and config/security reads — each controller JwtAuthGuard + PlatformAdminGuard, each service layer 2.
  controllers: [
    AdminPanelController,
    AdminInspectController,
    AdminOutboxController,
    AdminUsersController,
    AdminQueuesController,
    AdminWorkspacesController,
    AdminAuditController,
  ],
  providers: [
    AdminPanelService,
    OutboxOperationsService,
    AdminUsersService,
    AdminQueuesService,
    AdminWorkspacesService,
    AdminAuditService,
    AdminHealthService,
    AdminConfigService,
  ],
  exports: [OutboxOperationsService],
})
export class AdminPanelModule {}
