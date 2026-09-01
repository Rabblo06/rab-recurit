import { Global, Module } from '@nestjs/common';

import { AdminInspectService } from './admin-inspect.service';
import { PlatformAdminService } from './platform-admin.service';

/**
 * Deliberately lean — only `PlatformAdminService`/`AdminInspectService`, no
 * `AuthModule` import. `MaintenanceModeGuard` (in `AuthModule`) depends on
 * `PlatformAdminService`; if this module also imported `AuthModule` (which
 * `AdminPanelModule` needs, for `JwtAuthGuard`), that would be a circular
 * module dependency. Keeping this module import-free and `AdminPanelController`
 * in its own `AdminPanelModule` instead breaks that cycle. `AdminInspectService`
 * itself injects `AuditService`, and now `PlatformAdminService` does too
 * (for its `grant`/`revoke` audit trail) — safe because `AuditModule` is
 * also `@Global()`, so no explicit import is needed here either.
 */
@Global()
@Module({
  providers: [PlatformAdminService, AdminInspectService],
  exports: [PlatformAdminService, AdminInspectService],
})
export class PlatformAdminModule {}
