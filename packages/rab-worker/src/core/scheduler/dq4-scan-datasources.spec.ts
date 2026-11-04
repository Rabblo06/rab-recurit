import type { WorkerDependencies } from './worker-dependencies';

/**
 * D-Q4a test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q4a). CHARACTERISATION: which DataSource each
 * shift-family scan is given today. A combined scan must keep this split: the two report scans discover and take their
 * per-shift SESSION advisory locks (`withAdvisoryLock`) on the DIRECT pool (connection affinity), the three shift scans
 * use the pooled runtime DataSource. Passing the wrong one would either break the session lock (pooled) or move
 * routine scans onto the small direct pool.
 */

jest.mock('../../queues/rab-shifts/shift-monitor.job', () => ({ runShiftMonitorCycle: jest.fn(async () => ({ remindersSent: 0, noShowsFlagged: 0, postShiftTransitions: 0 })) }));
jest.mock('../../queues/rab-shifts/attendance-monitor.job', () => ({ runAttendanceMonitorCycle: jest.fn(async () => ({ flagged: 0 })) }));
jest.mock('../../queues/rab-shifts/late-clock-in.job', () => ({ runLateClockInCycle: jest.fn(async () => ({ flagged: 0 })) }));
jest.mock('../../queues/rab-shifts/shift-cancellation-followup.job', () => ({ runShiftCancellationFollowupCycle: jest.fn(async () => ({})) }));
jest.mock('../../queues/rab-reports/shift-report-scheduler.job', () => ({ runShiftReportSchedulerCycle: jest.fn(async () => ({ generated: 0, skippedLocked: 0, failed: 0 })) }));
jest.mock('../../queues/rab-reports/final-timesheet.job', () => ({ runFinalTimesheetCycle: jest.fn(async () => ({ sent: 0, skippedLocked: 0, failed: 0 })) }));
jest.mock('../../queues/rab-reports/payroll-period-attention.job', () => ({ runPayrollPeriodAttentionCycle: jest.fn(async () => ({ notified: 0 })) }));
jest.mock('../../queues/rab-reports/shift-statement.job', () => ({ runShiftStatementDispatchCycle: jest.fn(async () => ({ claimed: 0 })), processShiftStatementJob: jest.fn() }));
jest.mock('../../queues/rab-reports/shift-statement-enqueue', () => ({ enqueueShiftStatement: jest.fn() }));

// eslint-disable-next-line import/first
import { runAttendanceMonitorCycle } from '../../queues/rab-shifts/attendance-monitor.job';
// eslint-disable-next-line import/first
import { runLateClockInCycle } from '../../queues/rab-shifts/late-clock-in.job';
// eslint-disable-next-line import/first
import { runShiftMonitorCycle } from '../../queues/rab-shifts/shift-monitor.job';
// eslint-disable-next-line import/first
import { ShiftScanProcessor } from '../../queues/rab-shifts/shift.processors';
// eslint-disable-next-line import/first
import { runFinalTimesheetCycle } from '../../queues/rab-reports/final-timesheet.job';
// eslint-disable-next-line import/first
import { ReportScanProcessor } from '../../queues/rab-reports/report.processors';
// eslint-disable-next-line import/first
import { runShiftReportSchedulerCycle } from '../../queues/rab-reports/shift-report-scheduler.job';

const runtimeDataSource = { name: 'runtime' };
const directDataSource = { name: 'direct' };
const env: Record<string, number> = { CLOCK_IN_EARLY_MINUTES: 15, LATE_CLOCK_IN_GRACE_MINUTES: 10, REPORT_AVAILABLE_BEFORE_MINUTES: 180 };
const deps = {
  get: () => ({
    runtimeDataSource,
    directDataSource,
    tenantContext: {},
    notificationService: {},
    auditService: {},
    attendanceQrService: {},
    qrImageService: {},
    emailOutboxService: {},
    fileService: {},
    environmentService: { get: (k: string) => env[k] },
    logger: { log: jest.fn() },
  }),
} as unknown as WorkerDependencies;

describe('D-Q4a characterisation: DataSource per shift-family scan', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shift-monitor, attendance-monitor and late-clock-in run on the pooled runtime DataSource', async () => {
    const p = new ShiftScanProcessor(deps);
    await p.shiftMonitor();
    await p.attendanceMonitor();
    await p.lateClockIn();
    expect((runShiftMonitorCycle as jest.Mock).mock.calls[0][0]).toBe(runtimeDataSource);
    expect((runShiftMonitorCycle as jest.Mock).mock.calls[0][4]).toBe(15); // CLOCK_IN_EARLY_MINUTES
    expect((runAttendanceMonitorCycle as jest.Mock).mock.calls[0][0]).toBe(runtimeDataSource);
    expect((runLateClockInCycle as jest.Mock).mock.calls[0][0]).toBe(runtimeDataSource);
    expect((runLateClockInCycle as jest.Mock).mock.calls[0][4]).toBe(10); // LATE_CLOCK_IN_GRACE_MINUTES
  });

  it('shift-report-scheduler and final-timesheet run on the DIRECT DataSource (session advisory locks)', async () => {
    const p = new ReportScanProcessor(deps);
    await p.shiftReportScheduler();
    await p.finalTimesheet();
    expect((runShiftReportSchedulerCycle as jest.Mock).mock.calls[0][0]).toBe(directDataSource);
    expect((runShiftReportSchedulerCycle as jest.Mock).mock.calls[0][6]).toBe(180); // REPORT_AVAILABLE_BEFORE_MINUTES
    expect((runFinalTimesheetCycle as jest.Mock).mock.calls[0][0]).toBe(directDataSource);
  });
});
