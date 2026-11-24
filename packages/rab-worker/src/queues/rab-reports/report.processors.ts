import { Job } from 'bullmq';

import { ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES, SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runFinalTimesheetCycle } from './final-timesheet.job';
import { runPayrollPeriodAttentionCycle } from './payroll-period-attention.job';
import { runReportExportCycle } from './report-export.job';

/** The expired-file sweep (a write transaction per workspace) runs at most this often per Worker process. */
const REPORT_FILE_SWEEP_EVERY_MS = 60 * 60 * 1000;
let lastReportFileSweepAt = 0;
import { runShiftReportSchedulerCycle } from './shift-report-scheduler.job';
import { enqueueShiftStatement } from './shift-statement-enqueue';
import { processShiftStatementJob, runShiftStatementDispatchCycle } from './shift-statement.job';

/** Thin adapters — the pre-migration main.ts loop bodies, verbatim (see rab-email/email.processors.ts). */
@Processor(SCAN_QUEUES.reports)
export class ReportScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('shift-report-scheduler')
  async shiftReportScheduler(): Promise<void> {
    const { directDataSource, tenantContext, attendanceQrService, qrImageService, emailOutboxService, fileService, environmentService, auditService, logger } =
      this.deps.get();
    const result = await runShiftReportSchedulerCycle(
      directDataSource,
      tenantContext,
      attendanceQrService,
      qrImageService,
      emailOutboxService,
      fileService,
      environmentService.get('REPORT_AVAILABLE_BEFORE_MINUTES'),
      { audit: auditService },
    );
    if (result.generated || result.failed) {
      logger.log(`shift report scheduler: generated=${result.generated} failed=${result.failed} skippedLocked=${result.skippedLocked}`);
    }
  }

  @Process('final-timesheet')
  async finalTimesheet(): Promise<void> {
    const { directDataSource, tenantContext, emailOutboxService, fileService, auditService, logger } = this.deps.get();
    const result = await runFinalTimesheetCycle(directDataSource, tenantContext, emailOutboxService, fileService, { audit: auditService });
    if (result.sent || result.failed) {
      logger.log(`final timesheet: sent=${result.sent} failed=${result.failed} skippedLocked=${result.skippedLocked}`);
    }
  }

  // Approved Shift Statement: outbox (payroll_record.statement_status, committed with the approval) → dispatcher →
  // BullMQ → consumer. jobId carries the dispatch generation, so a re-queue after a lost job is a NEW job and an old one
  // is ignored by the consumer's generation check. BullMQ attempts = 1: retries are the dispatcher's, counted on the row.
  @Process('shift-statement-dispatch')
  async shiftStatementDispatch(): Promise<boolean> {
    const { runtimeDataSource, tenantContext, shiftStatementQueue, logger } = this.deps.get();
    const result = await runShiftStatementDispatchCycle(runtimeDataSource, tenantContext, async (data) => {
      // D-Q1: one registered builder for both claim modes (scope = the claimed row's organisation; options and jobId
      // format from / checked by the queue registry — values unchanged).
      await enqueueShiftStatement(shiftStatementQueue, data);
    });
    if (result.claimed) {
      logger.log(`shift statement dispatch: claimed=${result.claimed} published=${result.published} reconciledMissing=${result.reconciledMissing} requeued=${result.requeued} publishFailed=${result.publishFailed}`);
    }
    return Boolean(result.claimed);
  }

  @Process('payroll-period-attention')
  async payrollPeriodAttention(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, logger } = this.deps.get();
    const result = await runPayrollPeriodAttentionCycle(runtimeDataSource, tenantContext, notificationService);
    if (result.notified) logger.log(`payroll period attention: notified=${result.notified}`);
  }

  // Owner decision 29: build pending report exports and delete files 24 h after they were ready.
  @Process('report-export')
  async reportExport(): Promise<boolean> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, environmentService, logger } = this.deps.get();
    const now = Date.now();
    const sweep = now - lastReportFileSweepAt >= REPORT_FILE_SWEEP_EVERY_MS;
    if (sweep) lastReportFileSweepAt = now;
    const result = await runReportExportCycle(runtimeDataSource, tenantContext, notificationService, auditService, {
      lateGraceMinutes: environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'),
      log: (line) => logger.warn(line),
      sweepExpiredFiles: sweep,
    });
    const handled = result.built + result.failed + result.retried + result.deleted + result.errors + result.swept;
    if (handled) {
      logger.log(
        `report export: built=${result.built} failed=${result.failed} retried=${result.retried} deleted=${result.deleted} swept=${result.swept} errors=${result.errors}`,
      );
    }
    return handled > 0;
  }
}

/** The existing `rab-shift-statements` consumer (legacy `bull` prefix, concurrency 2): the same call as before. */
@Processor(CONSUMER_QUEUES.shiftStatements.name)
export class ShiftStatementConsumer {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process(CONSUMER_QUEUES.shiftStatements.jobName)
  async generate(job: Job<ShiftStatementJobData>): Promise<unknown> {
    const { tenantContext, fileService, notificationService, auditService } = this.deps.get();
    return processShiftStatementJob(job.data, { tenantContext, files: fileService, notifications: notificationService, audit: auditService });
  }
}
