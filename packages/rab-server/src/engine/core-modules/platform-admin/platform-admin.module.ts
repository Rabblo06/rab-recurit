import { Global, Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { AdminInspectService } from './admin-inspect.service';
import { OrganisationSuspensionService } from './organisation-suspension.service';
import { PlatformAdminService } from './platform-admin.service';

/**
 * `AuthModule` IS imported here now (P2.8 — `PlatformAdminService.grant`/`revoke` and the new
 * `OrganisationSuspensionService` both need `StepUpReauthService`/`SecurityVersionService`,
 * exported from `AuthModule`). This is NOT the circular dependency the previous version of this
 * comment worried about: `AuthModule` itself never imports `PlatformAdminModule` back — its own
 * guards (`MaintenanceModeGuard`, `OrganisationSuspendedGuard`) inject `PlatformAdminService`
 * directly via constructor, which resolves because THIS module is `@Global()` (global providers
 * are visible to every injector without an explicit `imports` entry — the asymmetry that makes
 * this a one-way edge, `PlatformAdminModule → AuthModule`, not a cycle). `AdminInspectService`
 * and `PlatformAdminService` both also inject `AuditService` — still fine without an explicit
 * import, since `AuditModule` is also `@Global()`.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [PlatformAdminService, AdminInspectService, OrganisationSuspensionService],
  exports: [PlatformAdminService, AdminInspectService, OrganisationSuspensionService],
})
export class PlatformAdminModule {}
