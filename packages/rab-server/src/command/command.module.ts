import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { coreDataSourceOptions } from '../database/typeorm/core/core.datasource';
import { AuditModule } from '../engine/core-modules/audit/audit.module';
import { AuthModule } from '../engine/core-modules/auth/auth.module';
import { EmailModule } from '../engine/core-modules/email/email.module';
import { EnvironmentModule } from '../engine/core-modules/environment/environment.module';
import { PermissionsModule } from '../engine/core-modules/permissions/permissions.module';
import { PlatformAdminModule } from '../engine/core-modules/platform-admin/platform-admin.module';
import { TenantModule } from '../engine/core-modules/tenant/tenant.module';
import { PingCommand } from './ping.command';
import { SeedCommand } from './seed.command';

/**
 * A hand-assembled module graph for CLI commands — deliberately smaller than
 * AppModule (no HTTP controllers/guards), but AuthModule now transitively
 * needs EmailModule/AuditModule (both @Global() in AppModule, so easy to
 * forget here): AccountLifecycleService sends invites/resets and writes
 * audit entries, and AuthService's own set-password/forgot-password/
 * reset-password flows do the same. PermissionsModule is needed too —
 * AuditController's own PermissionGuard(AUDIT_VIEW) needs PermissionsService,
 * and @Global() only reaches providers that were imported *somewhere* in
 * this smaller graph, not into AppModule's.
 */
@Module({
  imports: [
    EnvironmentModule,
    TypeOrmModule.forRoot(coreDataSourceOptions),
    TenantModule,
    PermissionsModule,
    PlatformAdminModule,
    AuditModule,
    EmailModule,
    AuthModule,
  ],
  providers: [PingCommand, SeedCommand],
})
export class CommandModule {}
