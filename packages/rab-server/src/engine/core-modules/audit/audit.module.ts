import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AuditEventQueueService } from '../audit-events/audit-event-queue.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * `@Global()` for `AuditService` (every domain service can inject it
 * without importing this module — the original reason it's global).
 * `AuditController` needs `AuthModule` for its own guard chain
 * (`JwtAuthGuard` → `AccessTokenService`) to resolve — no circular import:
 * `AuthModule` never imports `AuditModule` back, it just injects
 * `AuditService` the way every global-module export works.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  // X1.1: the security audit event producer (disabled — no Redis, no Queue — unless CREWFLOW_AUDIT_SINK is set).
  providers: [AuditService, AuditEventQueueService],
  exports: [AuditService, AuditEventQueueService],
})
export class AuditModule {}
