import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';

import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushQueueService } from '@rab/server/engine/core-modules/push/push-queue.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import { ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';

/**
 * Everything the job adapters pass to the existing `run*Cycle` functions — the same objects main.ts always passed
 * (resolved from the same Nest application context, plus the two connections main.ts builds itself). Both restricted
 * `crewflow_app` connections; never the provisioner's privileged one.
 */
export interface WorkerJobDependencies {
  logger: Logger;
  /** Pooled crewflow_app (DATABASE_URL), the shared TypeORM module's DataSource. */
  runtimeDataSource: DataSource;
  /** Direct crewflow_app (DATABASE_DIRECT_URL ?? DATABASE_URL) — session advisory locks inside the report/cleanup cycles. */
  directDataSource: DataSource;
  tenantContext: TenantContextService;
  auditService: AuditService;
  notificationService: NotificationService;
  environmentService: EnvironmentService;
  realtimeEventService: RealtimeEventService;
  emailService: EmailService;
  emailQueue: EmailQueueService;
  emailOutboxService: EmailOutboxService;
  pushService: PushService;
  pushQueue: PushQueueService;
  pushDeviceService: PushDeviceService;
  secretEncryptionService: SecretEncryptionService;
  fileService: FileService;
  attendanceQrService: AttendanceQrService;
  qrImageService: QrImageService;
  storageReconcileCommand: StorageReconcileCommand;
  /** PUBLISH on the realtime publisher's own Redis connection. */
  realtimePublish: (channel: string, message: string) => Promise<number>;
  /** Producer for the legacy `rab-shift-statements` queue (default `bull` prefix). */
  shiftStatementQueue: Queue<ShiftStatementJobData>;
}

/**
 * Holder provider: main.ts builds the dependencies after the Nest context exists (the direct DataSource and Redis
 * connections are not Nest providers) and hands them over exactly once. A processor running before that — impossible in
 * main.ts's order, but fail closed anyway — throws instead of running a cycle with missing collaborators.
 */
@Injectable()
export class WorkerDependencies {
  private deps: WorkerJobDependencies | null = null;

  provide(deps: WorkerJobDependencies): void {
    if (this.deps) throw new Error('worker dependencies were already provided');
    this.deps = deps;
  }

  get(): WorkerJobDependencies {
    if (!this.deps) throw new Error('worker dependencies used before main.ts provided them');
    return this.deps;
  }
}
