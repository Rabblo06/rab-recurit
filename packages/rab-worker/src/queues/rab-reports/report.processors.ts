import { Job } from 'bullmq';

import { SHIFT_STATEMENT_JOB_NAME, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { Process, Processor } from '../../core/scheduler/decorators';
import { CONSUMER_QUEUES, SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runFinalTimesheetCycle } from './final-timesheet.job';
import { runPayrollPeriodAttentionCycle } from './payroll-period-attention.job';
import { runShiftReportSchedulerCycle } from './shift-report-scheduler.job';
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
      await shiftStatementQueue.add(SHIFT_STATEMENT_JOB_NAME, data, {
        jobId: `shift-statement.${data.payrollRecordId}.gen.${data.generation}`, attempts: 1,
        removeOnComplete: { age: 7 * 24 * 60 * 60 }, removeOnFail: { age: 30 * 24 * 60 * 60 },
      });
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
