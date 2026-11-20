import { Module } from '@nestjs/common';

import { AuthModule } from '../../../engine/core-modules/auth/auth.module';
import { PlatformAdminBootstrapOnBoot } from './services/platform-admin-bootstrap-on-boot.service';
import { PlatformAdminBootstrapService } from './services/platform-admin-bootstrap.service';

/**
 * First platform administrator at API boot (BOOTSTRAP_ADMIN_EMAIL). Imported by AppModule ONLY: the CLI's CommandModule
 * registers PlatformAdminBootstrapService on its own (through BootstrapAdminCommand) and never loads the boot hook, and
 * the Worker's WorkerModule loads neither. AuditService, TenantContextService and EnvironmentService come from their
 * global modules; AccountLifecycleService from AuthModule.
 */
@Module({
  imports: [AuthModule],
  providers: [PlatformAdminBootstrapService, PlatformAdminBootstrapOnBoot],
})
export class PlatformAdminBootstrapModule {}
