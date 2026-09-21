import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { coreDataSourceOptions } from '../database/typeorm/core/core.datasource';
import { AuditModule } from '../engine/core-modules/audit/audit.module';
import { EmailModule } from '../engine/core-modules/email/email.module';
import { EnvironmentModule } from '../engine/core-modules/environment/environment.module';
import { PermissionsModule } from '../engine/core-modules/permissions/permissions.module';
import { PlatformAdminModule } from '../engine/core-modules/platform-admin/platform-admin.module';
import { ResourceScopeModule } from '../engine/core-modules/resource-scope/resource-scope.module';
import { SecretEncryptionModule } from '../engine/core-modules/secret-encryption/secret-encryption.module';
import { StorageModule } from '../engine/core-modules/storage/storage.module';
import { TenantModule } from '../engine/core-modules/tenant/tenant.module';
import { AttendanceModule } from '../modules/attendance/attendance.module';
import { NotificationModule } from '../modules/notification/notification.module';

/**
 * The Worker's Nest graph. Same codebase, same shared engine + domain modules
 * as the API — but ONLY the ones background work needs, and nothing that
 * exists for HTTP: no `RabThrottlerModule` (global per-IP `APP_GUARD` + its
 * own Redis client), no `HealthModule`, no request filters, no cookie
 * middleware, no console/mobile-facing modules (dashboard, search, admin
 * panel, staff/manager/venue/offer/scheduling controllers).
 *
 * The worker never listens on a port — it is created with
 * `NestFactory.createApplicationContext`, so no HTTP adapter exists at all.
 *
 * What it needs and why:
 *  - `EnvironmentModule`, `TypeOrmModule`, `TenantModule` — config, the
 *    restricted `rab_app` DataSource, and `TenantContextService`
 *    (`runInTenantContext`), the ONLY way per-row work reaches the database
 *    with RLS bound to the row's real organisation/workspace.
 *  - `AuditModule`, `EmailModule`, `StorageModule` — audit trail, the
 *    outbox + `rab-email` BullMQ queue + provider drivers, and file storage.
 *  - `NotificationModule` — shift reminders / no-show notifications.
 *  - `AttendanceModule` — the shared Shift-QR signing and QR-image services
 *    used by the pre-shift report (imported, never re-implemented here).
 *
 * Business rules are NOT duplicated: the worker calls the same shared
 * services the API does.
 */
@Module({
  imports: [
    EnvironmentModule,
    TypeOrmModule.forRoot(coreDataSourceOptions),
    TenantModule,
    SecretEncryptionModule,
    PermissionsModule,
    PlatformAdminModule,
    ResourceScopeModule,
    AuditModule,
    EmailModule,
    StorageModule,
    NotificationModule,
    AttendanceModule,
  ],
})
export class WorkerModule {}
