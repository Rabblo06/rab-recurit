import { Global, Module } from '@nestjs/common';

import { PlatformAdminService } from './platform-admin.service';

/**
 * Deliberately lean — only `PlatformAdminService`, no `AuthModule` import.
 * `MaintenanceModeGuard` (in `AuthModule`) depends on `PlatformAdminService`;
 * if this module also imported `AuthModule` (which `AdminPanelModule` needs,
 * for `JwtAuthGuard`), that would be a circular module dependency. Keeping
 * this module import-free and `AdminPanelController` in its own
 * `AdminPanelModule` instead breaks that cycle.
 */
@Global()
@Module({
  providers: [PlatformAdminService],
  exports: [PlatformAdminService],
})
export class PlatformAdminModule {}
