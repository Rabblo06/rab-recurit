import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { coreDataSourceOptions } from '@rab/server/database/typeorm/core/core.datasource';
import { AuditModule } from '@rab/server/engine/core-modules/audit/audit.module';
import { EmailModule } from '@rab/server/engine/core-modules/email/email.module';
import { EnvironmentModule } from '@rab/server/engine/core-modules/environment/environment.module';
import { PermissionsModule } from '@rab/server/engine/core-modules/permissions/permissions.module';
import { PlatformAdminModule } from '@rab/server/engine/core-modules/platform-admin/platform-admin.module';
import { ResourceScopeModule } from '@rab/server/engine/core-modules/resource-scope/resource-scope.module';
import { SecretEncryptionModule } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.module';
import { StorageModule } from '@rab/server/engine/core-modules/storage/storage.module';
import { TenantModule } from '@rab/server/engine/core-modules/tenant/tenant.module';
import { AttendanceModule } from '@rab/server/modules/attendance/attendance.module';
import { NotificationModule } from '@rab/server/modules/notification/notification.module';
// `@Command()`-decorated classes are plain NestJS providers underneath —
// `nest-commander`'s own CLI bootstrap is a separate, unrelated entrypoint
// (`command/main.ts`, never invoked here). Registering the class directly
// as a provider and resolving it via `appContext.get(...)` reuses the exact
// same reconciliation logic the manual `storage:reconcile` CLI command
// already runs — see `queues/rab-maintenance/storage-cleanup.job.ts`.
import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';

/**
 * The Worker's Nest graph — moved here from `rab-server/src/queue-worker/`
 * as part of splitting the worker into its own deployable package
 * (`packages/rab-worker`). Same shared engine + domain modules as the API,
 * imported from `@rab/server`'s compiled output (see that package's
 * `package.json` `exports` map) rather than duplicated — there is exactly
 * ONE `TenantContextService`, ONE set of TypeORM entity classes, ONE
 * `NotificationService`, shared by both processes exactly as they were
 * shared within one process before this split.
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
 *  - `NotificationModule` — shift reminders / no-show / late-clock-in /
 *    cancellation / timeout / replacement notifications.
 *  - `AttendanceModule` — the shared Shift-QR signing and QR-image services
 *    used by the pre-shift report (imported, never re-implemented here).
 *  - `StorageReconcileCommand` — the existing, already-safe storage
 *    reconciliation logic, reused on a schedule (see storage-cleanup.job.ts).
 *
 * Business rules are NOT duplicated: the worker calls the same shared
 * services the API does. Replacement-staff approval and its resulting
 * `OfferService.send()` call live in the API (`rab-server`'s
 * `ReplacementRequestController`), never here — see PHASE 17/18 of this
 * migration's own brief: the worker prepares candidates and notifies; only
 * an authenticated manager request, handled by the API, ever sends an offer.
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
  providers: [StorageReconcileCommand],
})
export class WorkerModule {}
