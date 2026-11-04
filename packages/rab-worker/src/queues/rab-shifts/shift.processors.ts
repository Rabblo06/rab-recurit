import { Process, Processor } from '../../core/scheduler/decorators';
import { SCAN_QUEUES } from '../../core/scheduler/queue-registry';
import { WorkerDependencies } from '../../core/scheduler/worker-dependencies';
import { runAttendanceMonitorCycle } from './attendance-monitor.job';
import { runLateClockInCycle } from './late-clock-in.job';
import { runShiftCancellationFollowupCycle } from './shift-cancellation-followup.job';
import { runShiftMonitorCycle } from './shift-monitor.job';

/** Thin adapters — the pre-migration main.ts loop bodies, verbatim (see rab-email/email.processors.ts). */
@Processor(SCAN_QUEUES.shifts)
export class ShiftScanProcessor {
  constructor(private readonly deps: WorkerDependencies) {}

  @Process('shift-monitor')
  async shiftMonitor(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, environmentService, logger } = this.deps.get();
    const result = await runShiftMonitorCycle(runtimeDataSource, tenantContext, notificationService, auditService, environmentService.get('CLOCK_IN_EARLY_MINUTES'));
    if (result.remindersSent || result.noShowsFlagged) {
      logger.log(`shift monitor: reminders=${result.remindersSent} noShows=${result.noShowsFlagged}`);
    }
  }

  @Process('attendance-monitor')
  async attendanceMonitor(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, logger } = this.deps.get();
    const result = await runAttendanceMonitorCycle(runtimeDataSource, tenantContext, notificationService, auditService);
    if (result.flagged) logger.log(`attendance monitor: flagged=${result.flagged}`);
  }

  @Process('late-clock-in')
  async lateClockIn(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, environmentService, logger } = this.deps.get();
    const result = await runLateClockInCycle(runtimeDataSource, tenantContext, notificationService, auditService, environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'));
    if (result.flagged) logger.log(`late clock-in: flagged=${result.flagged}`);
  }

  /**
   * Phase D-Q4a: the combined shift scan. Scheduled only with WORKER_SHIFT_SCAN_MODE=combined, where main.ts replaces this
   * handler with the wired CombinedShiftScan (shift-scan-combined.job.ts: withCombinedShiftScan). Reaching THIS body means
   * it was invoked without that wiring: fail closed, never a silent no-op stamped as a successful scan.
   */
  @Process('shift-scan-combined')
  async shiftScanCombined(): Promise<void> {
    throw new Error('shift-scan-combined runs only when main.ts wires it (WORKER_SHIFT_SCAN_MODE=combined)');
  }

  @Process('shift-cancellation-followup')
  async shiftCancellationFollowup(): Promise<void> {
    const { runtimeDataSource, tenantContext, notificationService, auditService, logger } = this.deps.get();
    const result = await runShiftCancellationFollowupCycle(runtimeDataSource, tenantContext, notificationService, auditService);
    if (result.assignmentsClosed || result.replacementRequestsCancelled) {
      logger.log(`shift cancellation follow-up: assignments=${result.assignmentsClosed} offers=${result.offersClosed} replacementRequests=${result.replacementRequestsCancelled}`);
    }
  }
}
