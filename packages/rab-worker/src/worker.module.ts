import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';

import { coreDataSourceOptions } from '@rab/server/database/typeorm/core/core.datasource';
import { AuditModule } from '@rab/server/engine/core-modules/audit/audit.module';
import { EmailModule } from '@rab/server/engine/core-modules/email/email.module';
import { EnvironmentModule } from '@rab/server/engine/core-modules/environment/environment.module';
import { PermissionsModule } from '@rab/server/engine/core-modules/permissions/permissions.module';
import { PlatformAdminModule } from '@rab/server/engine/core-modules/platform-admin/platform-admin.module';
import { PushModule } from '@rab/server/engine/core-modules/push/push.module';
import { RealtimeEventModule } from '@rab/server/engine/core-modules/realtime/realtime-event.module';
import { ResourceScopeModule } from '@rab/server/engine/core-modules/resource-scope/resource-scope.module';
import { SecretEncryptionModule } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.module';
import { StorageModule } from '@rab/server/engine/core-modules/storage/storage.module';
import { TenantModule } from '@rab/server/engine/core-modules/tenant/tenant.module';
import { AttendanceModule } from '@rab/server/modules/attendance/attendance.module';
import { MemberAccessModule } from '@rab/server/modules/identity/member-access/member-access.module';
import { NotificationModule } from '@rab/server/modules/notification/notification.module';
import { AiCoreModule } from '@rab/server/modules/ai/ai-core.module';
// `@Command()`-decorated classes are plain NestJS providers underneath —
// `nest-commander`'s own CLI bootstrap is a separate, unrelated entrypoint
// (`command/main.ts`, never invoked here). Registering the class directly
// as a provider and resolving it via `appContext.get(...)` reuses the exact
// same reconciliation logic the manual `storage:reconcile` CLI command
// already runs — see `queues/rab-maintenance/storage-cleanup.job.ts`.
import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import { ProcessorExplorer } from './core/scheduler/processor-explorer';
import { WorkerDependencies } from './core/scheduler/worker-dependencies';
import { EmailScanProcessor, EmailSendConsumer } from './queues/rab-email/email.processors';
import { MaintenanceScanProcessor } from './queues/rab-maintenance/maintenance.processors';
import { OfferScanProcessor } from './queues/rab-offers/offer.processors';
import { PushScanProcessor, PushSendConsumer } from './queues/rab-push/push.processors';
import { RealtimeScanProcessor } from './queues/rab-realtime/realtime.processors';
import { ReportScanProcessor, ShiftStatementConsumer } from './queues/rab-reports/report.processors';
import { ShiftScanProcessor } from './queues/rab-shifts/shift.processors';
import { AiMaintenanceProcessor, AiTurnConsumer } from './queues/rab-ai/ai.processors';

/**
 * BullMQ migration (Lane A M2/M3): the `@Processor` adapters for the 19 scans and the 3 existing consumers. Ordinary
 * providers, found at boot by `ProcessorExplorer` (Nest's own DiscoveryService). They are thin: each `@Process` method
 * is the pre-migration main.ts loop body, calling the unchanged `run*Cycle` function.
 */
export const WORKER_PROCESSORS = [
  EmailScanProcessor,
  EmailSendConsumer,
  PushScanProcessor,
  PushSendConsumer,
  ShiftScanProcessor,
  OfferScanProcessor,
  ReportScanProcessor,
  ShiftStatementConsumer,
  MaintenanceScanProcessor,
  RealtimeScanProcessor,
  // AI Phase 1: the rab-ai consumer and the AI retention scan (queues/rab-ai).
  AiTurnConsumer,
  AiMaintenanceProcessor,
];

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
 * `node_modules/@rab/server` is a workspace SYMLINK (`-> packages/rab-server`,
 * standard yarn workspaces). Found live, not assumed: Node's default module
 * resolution calls `fs.realpath` on a symlinked path before resolving ITS OWN
 * `require('typeorm')`/`require('@nestjs/...')` calls, which can make a
 * dependency required FROM a module reached through this symlink (e.g.
 * `SecretRotationService`, compiled inside `@rab/server`'s dist) resolve to a
 * technically-distinct module instance than the SAME dependency required
 * directly from `rab-worker`'s own source — even though there is only ONE
 * `typeorm`/`@nestjs/*` install on disk (confirmed: no nested `node_modules`
 * under any package). NestJS's DI matches providers by class REFERENCE, so
 * this silently broke dependency injection for anything living on the far
 * side of the `@rab/server` symlink (`UnknownDependenciesException` for
 * `SecretRotationService`'s `DataSource` param specifically — other services
 * happened not to trip it, reinforcing how easy this is to misdiagnose as a
 * one-off bug in a single module rather than the resolution boundary itself).
 * Fixed structurally, not by restructuring the encryption/DI architecture:
 * `NODE_OPTIONS=--preserve-symlinks` is set on the `start`/`provision` NX
 * targets (`project.json`) so Node treats the symlink's own location as
 * canonical instead of resolving through it — see `project.json`'s own
 * `env` block on those two targets. Any NEW `rab-worker` entrypoint that
 * imports from `@rab/server` needs the same flag on its own target.
 *
 * The worker never listens on a port — it is created with
 * `NestFactory.createApplicationContext`, so no HTTP adapter exists at all.
 *
 * What it needs and why:
 *  - `EnvironmentModule`, `TypeOrmModule`, `TenantModule` — config, the
 *    restricted `crewflow` DataSource, and `TenantContextService`
 *    (`runInTenantContext`), the ONLY way per-row work reaches the database
 *    with RLS bound to the row's real organisation/workspace.
 *  - `AuditModule`, `EmailModule`, `StorageModule` — audit trail, the
 *    outbox + `rab-email` BullMQ queue + provider drivers, and file storage.
 *  - `NotificationModule` — shift reminders / no-show / late-clock-in /
 *    cancellation / timeout / replacement notifications.
 *  - `AttendanceModule` — the shared Shift-QR signing and QR-image services
 *    used by the pre-shift report (imported, never re-implemented here).
 *  - `RealtimeEventModule` — `RealtimeEventService`, needed by
 *    `applyOfferConfirmation()` via `offer-expiry.job.ts`'s manager-
 *    confirmation-timeout cycle (Stage 5) so the SAME shared confirm path a
 *    real Manager's click uses also raises `offer.confirmed` when the
 *    worker auto-confirms on timeout — never a second notification path.
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
    RealtimeEventModule,
    PushModule,
    // Waves 4+5 integration: the API's global MemberAccessModule provides FieldPolicyService, which AttendanceService,
    // ShiftReportService, PayrollService and PayrollRunService now inject (wave 5 DATA, "money follows payroll.view").
    // The worker loads those services through AttendanceModule -> PayrollModule, so it needs the same global provider,
    // or the jobs child refuses to boot (UnknownDependenciesException on PayrollService.fieldPolicy).
    MemberAccessModule,
    // AI Phase 1: the shared AI services (turn runner, tools, gateway, quotas) — the SAME code the API uses.
    AiCoreModule,
    // BullMQ migration: processor discovery (built into @nestjs/core — no new dependency).
    DiscoveryModule,
  ],
  providers: [StorageReconcileCommand, WorkerDependencies, ProcessorExplorer, ...WORKER_PROCESSORS],
})
export class WorkerModule {}
