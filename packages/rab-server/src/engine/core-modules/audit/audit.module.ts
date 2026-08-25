import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
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
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
