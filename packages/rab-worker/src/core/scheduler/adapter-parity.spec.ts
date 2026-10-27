import 'reflect-metadata';

jest.mock('../../queues/rab-email/email-dispatch.job', () => ({ runEmailDispatchCycle: jest.fn() }));
jest.mock('../../queues/rab-email/email-send.processor', () => ({ createEmailSendProcessor: jest.fn() }));
jest.mock('../../queues/rab-push/push-dispatch.job', () => ({ runPushDispatchCycle: jest.fn() }));
jest.mock('../../queues/rab-push/push-send.processor', () => ({ createPushSendProcessor: jest.fn() }));
jest.mock('../../queues/rab-shifts/shift-monitor.job', () => ({ runShiftMonitorCycle: jest.fn() }));
jest.mock('../../queues/rab-shifts/attendance-monitor.job', () => ({ runAttendanceMonitorCycle: jest.fn() }));
jest.mock('../../queues/rab-shifts/late-clock-in.job', () => ({ runLateClockInCycle: jest.fn() }));
jest.mock('../../queues/rab-shifts/shift-cancellation-followup.job', () => ({ runShiftCancellationFollowupCycle: jest.fn() }));
jest.mock('../../queues/rab-offers/offer-expiry.job', () => ({ runOfferExpiryCycle: jest.fn(), runManagerConfirmationTimeoutCycle: jest.fn() }));
jest.mock('../../queues/rab-offers/replacement-staff.job', () => ({ runReplacementStaffCycle: jest.fn() }));
jest.mock('../../queues/rab-reports/shift-report-scheduler.job', () => ({ runShiftReportSchedulerCycle: jest.fn() }));
jest.mock('../../queues/rab-reports/final-timesheet.job', () => ({ runFinalTimesheetCycle: jest.fn() }));
jest.mock('../../queues/rab-reports/shift-statement.job', () => ({ runShiftStatementDispatchCycle: jest.fn(), processShiftStatementJob: jest.fn() }));
jest.mock('../../queues/rab-reports/payroll-period-attention.job', () => ({ runPayrollPeriodAttentionCycle: jest.fn() }));
jest.mock('../../queues/rab-realtime/publish-outbox.job', () => ({ runRealtimeOutboxPublishCycle: jest.fn() }));
jest.mock('../../queues/rab-maintenance/account-invite-cleanup.job', () => ({ runAccountInviteCleanupCycle: jest.fn() }));
jest.mock('../../queues/rab-maintenance/token-cleanup.job', () => ({ runTokenCleanupCycle: jest.fn() }));
jest.mock('../../queues/rab-maintenance/login-handoff-cleanup.job', () => ({ runLoginHandoffCleanupCycle: jest.fn() }));
jest.mock('../../queues/rab-maintenance/storage-cleanup.job', () => ({ runStorageCleanupCycle: jest.fn() }));
jest.mock('../../queues/rab-maintenance/outbox-retention.job', () => ({ runOutboxRetentionCycle: jest.fn() }));

import * as emailDispatch from '../../queues/rab-email/email-dispatch.job';
import * as emailSend from '../../queues/rab-email/email-send.processor';
import * as pushDispatch from '../../queues/rab-push/push-dispatch.job';
import * as shiftMonitor from '../../queues/rab-shifts/shift-monitor.job';
import * as attendance from '../../queues/rab-shifts/attendance-monitor.job';
import * as late from '../../queues/rab-shifts/late-clock-in.job';
import * as cancel from '../../queues/rab-shifts/shift-cancellation-followup.job';
import * as offers from '../../queues/rab-offers/offer-expiry.job';
import * as replacement from '../../queues/rab-offers/replacement-staff.job';
import * as report from '../../queues/rab-reports/shift-report-scheduler.job';
import * as finalTs from '../../queues/rab-reports/final-timesheet.job';
import * as statement from '../../queues/rab-reports/shift-statement.job';
import * as payroll from '../../queues/rab-reports/payroll-period-attention.job';
import * as realtime from '../../queues/rab-realtime/publish-outbox.job';
import * as invite from '../../queues/rab-maintenance/account-invite-cleanup.job';
import * as token from '../../queues/rab-maintenance/token-cleanup.job';
import * as handoff from '../../queues/rab-maintenance/login-handoff-cleanup.job';
import * as storage from '../../queues/rab-maintenance/storage-cleanup.job';
import * as retention from '../../queues/rab-maintenance/outbox-retention.job';
import { EmailScanProcessor, EmailSendConsumer } from '../../queues/rab-email/email.processors';
import { PushScanProcessor } from '../../queues/rab-push/push.processors';
import { ShiftScanProcessor } from '../../queues/rab-shifts/shift.processors';
import { OfferScanProcessor } from '../../queues/rab-offers/offer.processors';
import { ReportScanProcessor, ShiftStatementConsumer } from '../../queues/rab-reports/report.processors';
import { MaintenanceScanProcessor } from '../../queues/rab-maintenance/maintenance.processors';
import { RealtimeScanProcessor } from '../../queues/rab-realtime/realtime.processors';
import { WorkerDependencies, WorkerJobDependencies } from './worker-dependencies';

/**
 * Adapter parity (M3/M7): every adapter calls the SAME `run*Cycle` with the SAME arguments main.ts passed (identity of
 * every collaborator object, the same env-derived values) and honours the same return contract (`false` = no stamp).
 */
const tag = (name: string) => ({ __dep: name });
const ENV: Record<string, unknown> = {
  CLOCK_IN_EARLY_MINUTES: 31, LATE_CLOCK_IN_GRACE_MINUTES: 7, MANAGER_CONFIRMATION_TIMEOUT_MINUTES: 45, REPORT_AVAILABLE_BEFORE_MINUTES: 60,
  LOGIN_HANDOFF_CLEANUP_ENABLED: false, STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS: 9, NODE_ENV: 'test',
  OUTBOX_RETENTION_ENABLED: true, OUTBOX_RETENTION_MODE: 'report', OUTBOX_RETENTION_EMAIL_DAYS: 90, OUTBOX_RETENTION_PUSH_DAYS: 30,
  OUTBOX_RETENTION_REALTIME_DAYS: 7, OUTBOX_RETENTION_WORKER_EVENT_DAYS: 30, OUTBOX_RETENTION_BATCH_SIZE: 1000, OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE: 20,
  // Phase A gating: the push/realtime adapters run their cycle only when their feature is on (see the gating test below).
  PUSH_ENABLED: true, REALTIME_ENABLED: true,
};
const emailQueue = { publish: jest.fn(), republish: jest.fn() };
const pushQueue = { publish: jest.fn(), republish: jest.fn() };
const shiftStatementQueue = { add: jest.fn() };
const deps = {
  logger: { log: jest.fn() },
  runtimeDataSource: tag('runtime'), directDataSource: tag('direct'), tenantContext: tag('tenant'), auditService: tag('audit'),
  notificationService: tag('notifications'), realtimeEventService: tag('realtime-events'), environmentService: { get: (k: string) => ENV[k] },
  emailService: { ambiguousDeliverySafeToRetry: tag('email-ambiguous') }, emailQueue, emailOutboxService: tag('email-outbox'),
  pushService: { ambiguousDeliverySafeToRetry: tag('push-ambiguous') }, pushQueue, pushDeviceService: tag('push-device'),
  secretEncryptionService: tag('secrets'), fileService: tag('files'), attendanceQrService: tag('qr'), qrImageService: tag('qr-image'),
  storageReconcileCommand: tag('storage-reconcile'), realtimePublish: jest.fn(), shiftStatementQueue,
} as unknown as WorkerJobDependencies;
const holder = new WorkerDependencies();
holder.provide(deps);
const d = deps as unknown as Record<string, unknown>;
const ctx = { setStat: jest.fn() };

describe('scan adapters call the existing cycles exactly as main.ts did', () => {
  beforeEach(() => jest.clearAllMocks());

  it('email + push dispatch: same collaborators, publish/republish delegate to the queue services, return Boolean(claimed)', async () => {
    (emailDispatch.runEmailDispatchCycle as jest.Mock).mockResolvedValue({ claimed: 0 });
    await expect(new EmailScanProcessor(holder).emailDispatch()).resolves.toBe(false);
    const [ds, tc, pub, repub, ambiguous] = (emailDispatch.runEmailDispatchCycle as jest.Mock).mock.calls[0];
    expect([ds, tc, ambiguous]).toEqual([d.runtimeDataSource, d.tenantContext, (d.emailService as { ambiguousDeliverySafeToRetry: unknown }).ambiguousDeliverySafeToRetry]);
    expect(ds).toBe(d.runtimeDataSource);
    pub('e1', 'o1');
    repub('e1', 'o1', 3);
    expect(emailQueue.publish).toHaveBeenCalledWith('e1', 'o1');
    expect(emailQueue.republish).toHaveBeenCalledWith('e1', 'o1', 3);
    (emailDispatch.runEmailDispatchCycle as jest.Mock).mockResolvedValue({ claimed: 2, published: 2, recovered: 0, deliveryUncertain: 0 });
    await expect(new EmailScanProcessor(holder).emailDispatch()).resolves.toBe(true);

    (pushDispatch.runPushDispatchCycle as jest.Mock).mockResolvedValue({ claimed: 1 });
    await expect(new PushScanProcessor(holder).pushDispatch()).resolves.toBe(true);
    const p = (pushDispatch.runPushDispatchCycle as jest.Mock).mock.calls[0];
    expect(p[0]).toBe(d.runtimeDataSource);
    expect(p[1]).toBe(d.tenantContext);
    expect(p[4]).toBe((d.pushService as { ambiguousDeliverySafeToRetry: unknown }).ambiguousDeliverySafeToRetry);
  });

  it('shift scans', async () => {
    (shiftMonitor.runShiftMonitorCycle as jest.Mock).mockResolvedValue({});
    (attendance.runAttendanceMonitorCycle as jest.Mock).mockResolvedValue({});
    (late.runLateClockInCycle as jest.Mock).mockResolvedValue({});
    (cancel.runShiftCancellationFollowupCycle as jest.Mock).mockResolvedValue({});
    const p = new ShiftScanProcessor(holder);
    await expect(p.shiftMonitor()).resolves.toBeUndefined();
    await p.attendanceMonitor();
    await p.lateClockIn();
    await p.shiftCancellationFollowup();
    const base = [d.runtimeDataSource, d.tenantContext, d.notificationService, d.auditService];
    expect((shiftMonitor.runShiftMonitorCycle as jest.Mock).mock.calls[0]).toEqual([...base, 31]);
    expect((attendance.runAttendanceMonitorCycle as jest.Mock).mock.calls[0]).toEqual(base);
    expect((late.runLateClockInCycle as jest.Mock).mock.calls[0]).toEqual([...base, 7]);
    expect((cancel.runShiftCancellationFollowupCycle as jest.Mock).mock.calls[0]).toEqual(base);
  });

  it('offer scans', async () => {
    (offers.runOfferExpiryCycle as jest.Mock).mockResolvedValue({});
    (offers.runManagerConfirmationTimeoutCycle as jest.Mock).mockResolvedValue({});
    (replacement.runReplacementStaffCycle as jest.Mock).mockResolvedValue({});
    const p = new OfferScanProcessor(holder);
    await p.offerExpiry();
    await p.managerConfirmationTimeout();
    await p.replacementStaff();
    const base = [d.runtimeDataSource, d.tenantContext, d.notificationService, d.auditService];
    expect((offers.runOfferExpiryCycle as jest.Mock).mock.calls[0]).toEqual(base);
    expect((offers.runManagerConfirmationTimeoutCycle as jest.Mock).mock.calls[0]).toEqual([...base, d.realtimeEventService, 45]);
    expect((replacement.runReplacementStaffCycle as jest.Mock).mock.calls[0]).toEqual(base);
  });

  it('report scans use the DIRECT connection exactly where main.ts did; statement dispatch keeps its jobId/attempts/removeOn*', async () => {
    (report.runShiftReportSchedulerCycle as jest.Mock).mockResolvedValue({});
    (finalTs.runFinalTimesheetCycle as jest.Mock).mockResolvedValue({});
    (payroll.runPayrollPeriodAttentionCycle as jest.Mock).mockResolvedValue({});
    (statement.runShiftStatementDispatchCycle as jest.Mock).mockResolvedValue({ claimed: 0 });
    const p = new ReportScanProcessor(holder);
    await p.shiftReportScheduler();
    await p.finalTimesheet();
    await p.payrollPeriodAttention();
    await expect(p.shiftStatementDispatch()).resolves.toBe(false);
    expect((report.runShiftReportSchedulerCycle as jest.Mock).mock.calls[0]).toEqual([
      d.directDataSource, d.tenantContext, d.attendanceQrService, d.qrImageService, d.emailOutboxService, d.fileService, 60, { audit: d.auditService },
    ]);
    expect((report.runShiftReportSchedulerCycle as jest.Mock).mock.calls[0][0]).toBe(d.directDataSource);
    expect((finalTs.runFinalTimesheetCycle as jest.Mock).mock.calls[0]).toEqual([d.directDataSource, d.tenantContext, d.emailOutboxService, d.fileService, { audit: d.auditService }]);
    expect((payroll.runPayrollPeriodAttentionCycle as jest.Mock).mock.calls[0]).toEqual([d.runtimeDataSource, d.tenantContext, d.notificationService]);
    const publish = (statement.runShiftStatementDispatchCycle as jest.Mock).mock.calls[0][2];
    await publish({ payrollRecordId: 'r1', generation: 4, organisationId: 'o', workspaceId: 'w' });
    expect(shiftStatementQueue.add).toHaveBeenCalledWith('generate-shift-statement', { payrollRecordId: 'r1', generation: 4, organisationId: 'o', workspaceId: 'w' }, {
      jobId: 'shift-statement.r1.gen.4', attempts: 1, removeOnComplete: { age: 604800 }, removeOnFail: { age: 2592000 },
    });
  });

  it('maintenance scans: enable switches stay inside the cycle; disabled → false (never stamped); retention stats via ctx', async () => {
    (invite.runAccountInviteCleanupCycle as jest.Mock).mockResolvedValue({});
    (token.runTokenCleanupCycle as jest.Mock).mockResolvedValue({});
    (handoff.runLoginHandoffCleanupCycle as jest.Mock).mockResolvedValue({ ran: false });
    (storage.runStorageCleanupCycle as jest.Mock).mockResolvedValue({});
    (retention.runOutboxRetentionCycle as jest.Mock).mockResolvedValue({ ran: true, mode: 'report', rows: { email_outbox: 1, push_delivery: 2, realtime_event: 3, worker_event: 4 }, scopes: 1, truncated: false });
    const p = new MaintenanceScanProcessor(holder);
    await p.accountInviteCleanup();
    await p.tokenCleanup();
    await expect(p.loginHandoffCleanup()).resolves.toBe(false);
    await p.storageCleanup();
    await expect(p.outboxRetention(ctx)).resolves.toBe(true);
    expect((invite.runAccountInviteCleanupCycle as jest.Mock).mock.calls[0]).toEqual([d.runtimeDataSource]);
    expect((token.runTokenCleanupCycle as jest.Mock).mock.calls[0]).toEqual([d.runtimeDataSource]);
    expect((handoff.runLoginHandoffCleanupCycle as jest.Mock).mock.calls[0]).toEqual([d.runtimeDataSource, d.directDataSource, { enabled: false }]);
    expect((storage.runStorageCleanupCycle as jest.Mock).mock.calls[0]).toEqual([d.storageReconcileCommand, 9]);
    expect((retention.runOutboxRetentionCycle as jest.Mock).mock.calls[0]).toEqual([
      d.runtimeDataSource, d.directDataSource, d.tenantContext,
      { enabled: true, mode: 'report', days: { email_outbox: 90, push_delivery: 30, realtime_event: 7, worker_event: 30 }, batchSize: 1000, maxBatchesPerScope: 20 },
    ]);
    expect(ctx.setStat).toHaveBeenCalledWith('lastOutboxRetentionMode', 'report');
    expect(ctx.setStat).toHaveBeenCalledWith('lastOutboxRetentionRows', 10);
    (retention.runOutboxRetentionCycle as jest.Mock).mockResolvedValue({ ran: false });
    await expect(p.outboxRetention(ctx)).resolves.toBe(false);
  });

  it('realtime publish: runtime connection, the dedicated publisher, NODE_ENV; consumers reuse the existing processor functions', async () => {
    (realtime.runRealtimeOutboxPublishCycle as jest.Mock).mockResolvedValue({ claimed: 0 });
    await expect(new RealtimeScanProcessor(holder).realtimeOutboxPublish()).resolves.toBe(false);
    expect((realtime.runRealtimeOutboxPublishCycle as jest.Mock).mock.calls[0]).toEqual([d.runtimeDataSource, d.tenantContext, d.realtimePublish, 'test']);

    const send = jest.fn().mockResolvedValue(undefined);
    (emailSend.createEmailSendProcessor as jest.Mock).mockReturnValue(send);
    const consumer = new EmailSendConsumer(holder);
    await consumer.send({ id: 'j1' } as never);
    await consumer.send({ id: 'j2' } as never);
    expect(emailSend.createEmailSendProcessor).toHaveBeenCalledTimes(1); // built once, like main.ts
    expect((emailSend.createEmailSendProcessor as jest.Mock).mock.calls[0][0]).toEqual({ tenantContext: d.tenantContext, emailService: d.emailService, auditService: d.auditService, fileService: d.fileService });
    expect(send).toHaveBeenCalledTimes(2);

    (statement.processShiftStatementJob as jest.Mock).mockResolvedValue('generated');
    await expect(new ShiftStatementConsumer(holder).generate({ data: { payrollRecordId: 'r' } } as never)).resolves.toBe('generated');
    expect((statement.processShiftStatementJob as jest.Mock).mock.calls[0]).toEqual([
      { payrollRecordId: 'r' }, { tenantContext: d.tenantContext, files: d.fileService, notifications: d.notificationService, audit: d.auditService },
    ]);
  });

  // Phase A gating (defence in depth behind the scheduler's per-job enabled predicate): a disabled feature's scan adapter
  // returns idle (`false` = no stamp) without calling its cycle, so no SQL, no queue publish and no Redis PUBLISH happen.
  it.each([
    ['PUSH_ENABLED', () => new PushScanProcessor(holder).pushDispatch(), () => pushDispatch.runPushDispatchCycle],
    ['REALTIME_ENABLED', () => new RealtimeScanProcessor(holder).realtimeOutboxPublish(), () => realtime.runRealtimeOutboxPublishCycle],
  ] as const)('%s=false: the adapter returns idle and never calls its cycle', async (flag, run, cycle) => {
    const before = ENV[flag];
    ENV[flag] = false;
    try {
      (cycle() as jest.Mock).mockResolvedValue({ claimed: 5 });
      await expect(run()).resolves.toBe(false);
      expect(cycle()).not.toHaveBeenCalled();
      expect(pushQueue.publish).not.toHaveBeenCalled();
      expect(pushQueue.republish).not.toHaveBeenCalled();
      expect(d.realtimePublish).not.toHaveBeenCalled();
      expect(deps.logger.log).not.toHaveBeenCalled();
    } finally {
      ENV[flag] = before;
    }
    // ...and with the flag back on the very same adapter runs its cycle again (no sticky state).
    await expect(run()).resolves.toBe(true);
    expect(cycle()).toHaveBeenCalledTimes(1);
  });

  it('dependencies are provided exactly once; using them before main.ts provides them fails closed', () => {
    const empty = new WorkerDependencies();
    expect(() => empty.get()).toThrow(/before main.ts provided them/);
    expect(() => holder.provide(deps)).toThrow(/already provided/);
  });
});
