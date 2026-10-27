import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { coreDataSourceOptions } from '../database/typeorm/core/core.datasource';
import { AuditModule } from '../engine/core-modules/audit/audit.module';
import { AuthModule } from '../engine/core-modules/auth/auth.module';
import { EmailModule } from '../engine/core-modules/email/email.module';
import { EnvironmentModule } from '../engine/core-modules/environment/environment.module';
import { PermissionsModule } from '../engine/core-modules/permissions/permissions.module';
import { PlatformAdminModule } from '../engine/core-modules/platform-admin/platform-admin.module';
import { SecretEncryptionModule } from '../engine/core-modules/secret-encryption/secret-encryption.module';
import { StorageModule } from '../engine/core-modules/storage/storage.module';
import { TenantModule } from '../engine/core-modules/tenant/tenant.module';
import { HwsBackfillService } from '../database/typeorm/workspace-schema/backfill/hws-backfill.service';
import { UserSessionBackfillService } from '../engine/core-modules/auth/token/backfill/user-session-backfill.service';
import { BootstrapAdminCommand } from './bootstrap-admin.command';
import { ContainmentSuspendCommand } from './containment.command';
import { GrantPlatformAdminCommand } from './grant-platform-admin.command';
import { HwsBackfillCommand } from './hws-backfill.command';
import { PingCommand } from './ping.command';
import { SecretRotationCommand } from './secret-rotation.command';
import { OutboxReplayCommand } from './outbox-replay.command';
import { OutboxOperationsService } from '../engine/core-modules/platform-admin/outbox-operations.service';
import { ThrottlerRedisClientModule } from '../engine/core-modules/throttler/throttler-redis-client.module';
import { SeedCommand } from './seed.command';
import { SeedQaCommand } from './seed-qa.command';
import { SeedAiDemoCommand } from './seed-ai-demo.command';
import { StorageMigrateLocalCommand } from './storage-migrate-local.command';
import { StorageReconcileCommand } from './storage-reconcile.command';
import { UserSessionBackfillCommand } from './user-session-backfill.command';
import { PayrollImportCalendarCommand } from './payroll-import-calendar.command';
import { PayrollCalendarService } from '../modules/payroll/services/payroll-calendar.service';
import { ResourceScopeModule } from '../engine/core-modules/resource-scope/resource-scope.module';

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
    StorageModule,
    SecretEncryptionModule,
    ResourceScopeModule,
    ThrottlerRedisClientModule,
  ],
  providers: [
    PingCommand,
    PayrollImportCalendarCommand,
    PayrollCalendarService,
    SeedCommand,
    SeedQaCommand,
    // AI Part A (development only): the synthetic organisation for the real-model dev run.
    SeedAiDemoCommand,
    GrantPlatformAdminCommand,
    BootstrapAdminCommand,
    StorageReconcileCommand,
    StorageMigrateLocalCommand,
    ContainmentSuspendCommand,
    HwsBackfillService,
    HwsBackfillCommand,
    UserSessionBackfillService,
    UserSessionBackfillCommand,
    SecretRotationCommand,
    // Wave 5 lane OPS: audited FAILED-email replay (same service as the platform-admin endpoint).
    OutboxOperationsService,
    OutboxReplayCommand,
  ],
})
export class CommandModule {}
