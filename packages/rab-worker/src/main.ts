import { releaseEarlyBootSignalGuard } from '@rab/server/engine/utils/early-boot-signal-guard'; // MUST stay the first import
import 'dotenv/config';
import '@rab/server/instrument';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EMAIL_QUEUE_NAME } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushQueueService } from '@rab/server/engine/core-modules/push/push-queue.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { PUSH_QUEUE_NAME } from '@rab/server/engine/core-modules/push/push-queue.constants';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '@rab/server/engine/utils/assert-runtime-db-role';
import { assertHwsStartupInvariants } from '@rab/server/database/typeorm/core/hws-startup-guard';
import { assertRuntimeDatabaseIdentity } from '@rab/server/database/typeorm/core/runtime-database-guard';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { runAccountInviteCleanupCycle } from './queues/rab-maintenance/account-invite-cleanup.job';
import { runTokenCleanupCycle } from './queues/rab-maintenance/token-cleanup.job';
import { runStorageCleanupCycle } from './queues/rab-maintenance/storage-cleanup.job';
import { runEmailDispatchCycle } from './queues/rab-email/email-dispatch.job';
import { createEmailSendProcessor } from './queues/rab-email/email-send.processor';
import { runPushDispatchCycle } from './queues/rab-push/push-dispatch.job';
import { createPushSendProcessor } from './queues/rab-push/push-send.processor';
import { runAttendanceMonitorCycle } from './queues/rab-shifts/attendance-monitor.job';
import { runLateClockInCycle } from './queues/rab-shifts/late-clock-in.job';
import { runShiftCancellationFollowupCycle } from './queues/rab-shifts/shift-cancellation-followup.job';
import { runShiftMonitorCycle } from './queues/rab-shifts/shift-monitor.job';
import { runManagerConfirmationTimeoutCycle, runOfferExpiryCycle } from './queues/rab-offers/offer-expiry.job';
import { runReplacementStaffCycle } from './queues/rab-offers/replacement-staff.job';
import { runFinalTimesheetCycle } from './queues/rab-reports/final-timesheet.job';
import { processShiftStatementJob, runShiftStatementDispatchCycle } from './queues/rab-reports/shift-statement.job';
import { runPayrollPeriodAttentionCycle } from './queues/rab-reports/payroll-period-attention.job';
import { SHIFT_STATEMENT_JOB_NAME, SHIFT_STATEMENT_QUEUE_NAME, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { runShiftReportSchedulerCycle } from './queues/rab-reports/shift-report-scheduler.job';
import { runRealtimeOutboxPublishCycle } from './queues/rab-realtime/publish-outbox.job';
import { WorkerRuntime } from './core/runtime/worker-runtime';
import { WorkerModule } from './worker.module';

/**
 * ONE `rab-worker` process, multiple job categories — its own deployable
 * package (`packages/rab-worker`), separate from `rab-server` (this file
 * used to be `rab-server/src/queue-worker/main.ts`; that directory no
 * longer exists — see docs/HANDOFF.md for the migration). Shared engine +
 * domain code is imported from `@rab/server`'s compiled output (see that
 * package's own `package.json` `exports` map), never duplicated: there is
 * exactly ONE `TenantContextService`, ONE set of TypeORM entity classes,
 * ONE `NotificationService`, used identically by both processes.
 *
 * Deploys as a separate runtime from the API (same monorepo, different
 * package, different container command), never merged into request
 * handling, so nothing here competes with an HTTP request for CPU/DB-pool
 * budget. This file only bootstraps and coordinates; every category's
 * actual logic lives in its own `queues/rab-<domain>/*.job.ts` file, and
 * every business rule lives in the shared services the API also uses
 * (`WorkerModule` imports them; nothing here re-implements one).
 *
 * Worker credential isolation checkpoint (P2/P3): this process authenticates to PostgreSQL ONLY as
 * the restricted `crewflow_app` login — the exact same identity the API uses, same as `DATABASE_URL`.
 * It never reads, requires or initialises `DATABASE_URL_UNPOOLED`. Two `crewflow_app` connections,
 * not two identities: `runtimeDataSource` (pooled, via the shared TypeORM module) for discovery,
 * scans and most cycles; `directDataSource` (a direct connection) only where a session advisory
 * lock needs connection affinity (final timesheet, shift-report scheduler). Workspace discovery
 * reads `core.worker_list_workspaces`, a narrow SECURITY DEFINER function (owned by the separate
 * NOLOGIN `rab_secure_owner`, granted EXECUTE to `crewflow_app`); token cleanup runs through
 * `core.worker_cleanup_auth_tokens` the same way. Neither function returns or touches a staff,
 * business or identity row. Account-invite cleanup and storage reconciliation's catalogue
 * enumeration also now run on `runtimeDataSource` — both were audited and found to need only
 * ordinary grants (never ownership or DDL), confirmed empirically before this move.
 *
 * Workspace schema provisioning (the one genuinely privileged, DDL-performing operation this
 * worker used to run) has been moved OUT of this process entirely, into the separate
 * `workspace-provisioner.main.ts` entrypoint — the only thing in this package that reads
 * `DATABASE_URL_UNPOOLED`. See that file's own doc comment for the full rationale. This process
 * never opens that connection, never imports `runWorkspaceProvisioningCycle`, and structurally
 * cannot run workspace DDL even if compromised.
 *
 * Business mutations (an email send, a shift reminder, a no-show flag, an offer
 * expiry, a report, a replacement request, a cancellation follow-up) run
 * through `TenantContextService` as `crewflow_app`, bound to that SPECIFIC row's
 * real organisation/workspace — see `core/database/scoped-job.ts`. A job's
 * Redis/queue payload is never treated as authorisation: every job reloads
 * the authoritative row first.
 *
 * Lifecycle: no loop overlaps itself; on SIGTERM/SIGINT the worker stops
 * scheduling, lets BullMQ finish its active email jobs, waits (bounded) for
 * in-flight cycles — including a Playwright render — and only then closes
 * Nest, Postgres and Redis. Report jobs hold per-report session advisory
 * locks, which Postgres releases automatically if the process is killed
 * before it can drain, so a hard kill can never wedge a report.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
// 15 min — see account-invite-cleanup.job.ts's own doc comment.
const ACCOUNT_INVITE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
// Short — this drives real user-facing latency (how soon after an admin
// clicks "Create Manager" does the invite actually attempt delivery). The
// request-time fast-path publish (EmailOutboxService.tryFastPublish) covers
// the common case in near-real-time; this interval is the durability
// backstop for whatever that fast path missed (a crash, a Redis blip) — see
// queues/rab-email/email-dispatch.job.ts's own doc comment.
const EMAIL_DISPATCH_INTERVAL_MS = 2_000;
const EMAIL_WORKER_CONCURRENCY = 5;
const PUSH_DISPATCH_INTERVAL_MS = 2_000;
const PUSH_WORKER_CONCURRENCY = 10;
// Shift/offer/attendance monitors are periodic scans, not per-row BullMQ
// delayed jobs (see shift-monitor.job.ts's own doc comment for why) — a few
// minutes' imprecision on "remind 24h before a shift" or "flag a missed
// clock-out" is immaterial, so these run on a modest, DB-pool-friendly
// cadence rather than the email dispatcher's tight 2s loop.
const SHIFT_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const ATTENDANCE_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
// Offers are more time-sensitive (a stale PENDING offer blocks the shift
// slot from being reassigned) — closer to the email dispatcher's cadence.
const OFFER_EXPIRY_INTERVAL_MS = 60 * 1000;
// Same cadence class as offer expiry — a stuck manager-confirmation is the
// same kind of "blocks the slot" urgency.
const MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_MS = 60 * 1000;
// Late clock-in is a soft, early warning — a couple of minutes' imprecision
// on "flag someone running late" is immaterial; same cadence class as the
// shift/attendance monitors it's modelled on.
const LATE_CLOCK_IN_INTERVAL_MS = 2 * 60 * 1000;
// Cancellation follow-up should feel prompt to an affected staff member —
// closer to the offer-expiry cadence than the 5-minute monitors.
const SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_MS = 60 * 1000;
// A decline/expiry is already terminal and not time-critical the way a
// live offer is — a 2-minute cadence is plenty responsive for "prepare a
// shortlist and notify the manager."
const REPLACEMENT_STAFF_INTERVAL_MS = 2 * 60 * 1000;
// Pure housekeeping, no user-facing latency depends on it — once a day is
// plenty, matching this file's own "controlled daily scheduler" allowance
// for genuinely global periodic sweeps.
const TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STORAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Same cadence class as the shift/attendance monitors — PDF generation is
// not latency-sensitive (nothing waits synchronously on it; a manager's
// "Finalise & Send" flips state immediately regardless).
const SHIFT_REPORT_SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
const FINAL_TIMESHEET_INTERVAL_MS = 5 * 60 * 1000;
/** Approved Shift Statement outbox dispatch (a manager waits on it after approving), and the BullMQ consumer's concurrency. */
const SHIFT_STATEMENT_DISPATCH_INTERVAL_MS = 5 * 1000;
const SHIFT_STATEMENT_WORKER_CONCURRENCY = 2;
/** Ended payroll periods with unfinished records: notify the workspace owner once (never prepares/finalises/pays). */
const PAYROLL_PERIOD_ATTENTION_INTERVAL_MS = 30 * 60 * 1000;
// A pending offer/notification should reach its recipient's browser quickly — close to the
// email dispatcher's own cadence, not the multi-minute monitor jobs.
const REALTIME_OUTBOX_PUBLISH_INTERVAL_MS = 2_000;
// How long SIGTERM waits for in-flight cycles (a PDF render is seconds) before giving up and exiting anyway.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** Refuses to start: prints a sanitised reason and exits non-zero before any queue consumer or connection is opened. */
function refuseStartup(error: unknown): never {
  const message = error instanceof Error ? error.message : 'unknown error';
  const prefix =
    error instanceof Error && error.name === 'RuntimeDbError'
      ? '[runtime-db-guard] refused: '
      : error instanceof Error && error.name === 'HwsStartupError'
        ? '[hws-startup-guard] refused: '
        : '';
  // eslint-disable-next-line no-console
  console.error(`${prefix}${message}`);
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  // RUNTIME boundary: the database identity (both the application and owner-role connections) is verified BEFORE any
  // queue consumer, connection or job starts.
  await assertRuntimeDatabaseIdentity('worker').catch(refuseStartup);
  const logger = new NestLogger('RabWorker');

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required — the worker must not start without it');
  }

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();
  // Realtime outbox publisher — ITS OWN connection (`.duplicate()`, ioredis's own documented way
  // to clone a client's connection options into an independent connection), never the BullMQ/
  // heartbeat `redis` above. Not because PUBLISH itself needs isolation (it's an ordinary command,
  // safe on any connection) — it's kept separate so this job's connection lifecycle (and any future
  // retry/backoff tuning specific to Pub/Sub) never couples to BullMQ's own connection semantics.
  const realtimePublisherRedis = redis.duplicate();

  const appContext = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn', 'log'] });
  // The worker's tenant-scoped work runs on this DataSource — it must be the restricted, RLS-bound role, exactly like the API.
  // Worker credential isolation checkpoint: the worker authenticates as `crewflow_app`, like the API. Two pools, one identity,
  // NEITHER of which is ever the privileged `DATABASE_URL_UNPOOLED` identity — see this file's own top doc comment.
  //   runtimeDataSource — pooled crewflow_app (DATABASE_URL, via the shared TypeORM module). Discovery, scans, token/invite
  //                       cleanup, storage-catalogue enumeration, email.
  //   directDataSource  — direct crewflow_app connection (DATABASE_DIRECT_URL, falling back to DATABASE_URL). Used ONLY where a
  //                       session advisory lock needs connection affinity: final timesheet and shift-report scheduler.
  const runtimeDataSource = appContext.get(DataSource);
  await assertRuntimeDbRole(runtimeDataSource, 'worker');
  // HWS runtime cutover (Part 26): same invariant check as the API (same coreDataSourceOptions, same TenantContextService),
  // run against the worker's own runtimeDataSource — it's the one whose entity metadata and migrationsTableName matter.
  await assertHwsStartupInvariants(runtimeDataSource, appContext.get(EnvironmentService).get('HWS_RUNTIME_ENABLED')).catch(refuseStartup);
  const directDataSource = new DataSource({
    type: 'postgres',
    url: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL,
    schema: 'core',
    entities: [],
    synchronize: false,
    extra: {
      query_timeout: 30_000,
      statement_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    },
  });
  await directDataSource.initialize();
  await assertRuntimeDbRole(directDataSource, 'worker-direct');

  const emailService = appContext.get(EmailService);
  const tenantContext = appContext.get(TenantContextService);
  const auditService = appContext.get(AuditService);
  const emailQueue = appContext.get(EmailQueueService);
  const notificationService = appContext.get(NotificationService);
  const fileService = appContext.get(FileService);
  const emailOutboxService = appContext.get(EmailOutboxService);
  const attendanceQrService = appContext.get(AttendanceQrService);
  const qrImageService = appContext.get(QrImageService);
  const environmentService = appContext.get(EnvironmentService);
  const realtimeEventService = appContext.get(RealtimeEventService);
  const storageReconcileCommand = appContext.get(StorageReconcileCommand);
  const pushService = appContext.get(PushService);
  const pushQueue = appContext.get(PushQueueService);
  const pushDeviceService = appContext.get(PushDeviceService);
  const secretEncryptionService = appContext.get(SecretEncryptionService);

  const emailWorker = new Worker(EMAIL_QUEUE_NAME, createEmailSendProcessor({ tenantContext, emailService, auditService, fileService }), {
    connection: redis,
    concurrency: EMAIL_WORKER_CONCURRENCY,
  });
  emailWorker.on('failed', (job, err) => {
    logger.warn(`email job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });
  emailWorker.on('error', (err) => {
    logger.error('email worker error', err);
  });

  const pushWorker = new Worker(
    PUSH_QUEUE_NAME,
    createPushSendProcessor({ tenantContext, pushService, secretEncryption: secretEncryptionService, pushDeviceService }),
    { connection: redis, concurrency: PUSH_WORKER_CONCURRENCY },
  );
  pushWorker.on('failed', (job, err) => {
    logger.warn(`push job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });
  pushWorker.on('error', (err) => {
    logger.error('push worker error', err);
  });

  const runtime = new WorkerRuntime(redis);

  const beat = () => {
    redis.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {
      // Best-effort — a missed heartbeat just makes the next Health tab read report Down/stale, which is correct.
    });
  };
  beat();
  runtime.interval(beat, HEARTBEAT_INTERVAL_MS);

  runtime.every({
    name: 'account-invite cleanup',
    intervalMs: ACCOUNT_INVITE_CLEANUP_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastAccountInviteCleanupAt', failures: 'accountInviteCleanupFailures' },
    run: async () => {
      const result = await runAccountInviteCleanupCycle(runtimeDataSource);
      if (result.expired || result.deleted || result.retained) {
        logger.log(`account-invite cleanup: expired=${result.expired} deleted=${result.deleted} retained=${result.retained}`);
      }
    },
  });

  runtime.every({
    name: 'email dispatch',
    intervalMs: EMAIL_DISPATCH_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastEmailDispatchAt', failures: 'emailDispatchFailures' },
    run: async () => {
      const result = await runEmailDispatchCycle(
        runtimeDataSource,
        tenantContext,
        (id, orgId) => emailQueue.publish(id, orgId),
        (id, orgId, generation) => emailQueue.republish(id, orgId, generation),
        emailService.ambiguousDeliverySafeToRetry,
      );
      if (result.claimed) logger.log(`email dispatch: claimed=${result.claimed} published=${result.published} recovered=${result.recovered} deliveryUncertain=${result.deliveryUncertain}`);
      return Boolean(result.claimed); // only stamps lastEmailDispatchAt when it actually claimed rows
    },
  });

  runtime.every({
    name: 'push dispatch',
    intervalMs: PUSH_DISPATCH_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastPushDispatchAt', failures: 'pushDispatchFailures' },
    run: async () => {
      const result = await runPushDispatchCycle(
        runtimeDataSource,
        tenantContext,
        (id, orgId) => pushQueue.publish(id, orgId),
        (id, orgId, generation) => pushQueue.republish(id, orgId, generation),
        pushService.ambiguousDeliverySafeToRetry,
      );
      if (result.claimed) logger.log(`push dispatch: claimed=${result.claimed} published=${result.published} recovered=${result.recovered} deliveryUncertain=${result.deliveryUncertain}`);
      return Boolean(result.claimed);
    },
  });

  runtime.every({
    name: 'shift monitor',
    intervalMs: SHIFT_MONITOR_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastShiftMonitorAt', failures: 'shiftMonitorFailures' },
    run: async () => {
      const result = await runShiftMonitorCycle(runtimeDataSource, tenantContext, notificationService, auditService, environmentService.get('CLOCK_IN_EARLY_MINUTES'));
      if (result.remindersSent || result.noShowsFlagged) {
        logger.log(`shift monitor: reminders=${result.remindersSent} noShows=${result.noShowsFlagged}`);
      }
    },
  });

  runtime.every({
    name: 'attendance monitor',
    intervalMs: ATTENDANCE_MONITOR_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastAttendanceMonitorAt', failures: 'attendanceMonitorFailures' },
    run: async () => {
      const result = await runAttendanceMonitorCycle(runtimeDataSource, tenantContext, notificationService, auditService);
      if (result.flagged) logger.log(`attendance monitor: flagged=${result.flagged}`);
    },
  });

  runtime.every({
    name: 'late clock-in',
    intervalMs: LATE_CLOCK_IN_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastLateClockInAt', failures: 'lateClockInFailures' },
    run: async () => {
      const result = await runLateClockInCycle(runtimeDataSource, tenantContext, notificationService, auditService, environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'));
      if (result.flagged) logger.log(`late clock-in: flagged=${result.flagged}`);
    },
  });

  runtime.every({
    name: 'shift cancellation follow-up',
    intervalMs: SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastShiftCancellationFollowupAt', failures: 'shiftCancellationFollowupFailures' },
    run: async () => {
      const result = await runShiftCancellationFollowupCycle(runtimeDataSource, tenantContext, notificationService, auditService);
      if (result.assignmentsClosed || result.replacementRequestsCancelled) {
        logger.log(`shift cancellation follow-up: assignments=${result.assignmentsClosed} offers=${result.offersClosed} replacementRequests=${result.replacementRequestsCancelled}`);
      }
    },
  });

  runtime.every({
    name: 'offer expiry',
    intervalMs: OFFER_EXPIRY_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastOfferExpiryAt', failures: 'offerExpiryFailures' },
    run: async () => {
      const result = await runOfferExpiryCycle(runtimeDataSource, tenantContext, notificationService, auditService);
      if (result.expired) logger.log(`offer expiry: expired=${result.expired}`);
    },
  });

  runtime.every({
    name: 'manager confirmation timeout',
    intervalMs: MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastManagerConfirmationTimeoutAt', failures: 'managerConfirmationTimeoutFailures' },
    run: async () => {
      const result = await runManagerConfirmationTimeoutCycle(
        runtimeDataSource,
        tenantContext,
        notificationService,
        auditService,
        realtimeEventService,
        environmentService.get('MANAGER_CONFIRMATION_TIMEOUT_MINUTES'),
      );
      if (result.confirmed) logger.log(`manager confirmation timeout: confirmed=${result.confirmed}`);
    },
  });

  runtime.every({
    name: 'replacement staff',
    intervalMs: REPLACEMENT_STAFF_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastReplacementStaffAt', failures: 'replacementStaffFailures' },
    run: async () => {
      const result = await runReplacementStaffCycle(runtimeDataSource, tenantContext, notificationService, auditService);
      if (result.created) logger.log(`replacement staff: created=${result.created} noCandidates=${result.noCandidates}`);
    },
  });

  runtime.every({
    name: 'token cleanup',
    intervalMs: TOKEN_CLEANUP_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastTokenCleanupAt', failures: 'tokenCleanupFailures' },
    run: async () => {
      const result = await runTokenCleanupCycle(runtimeDataSource);
      if (result.refreshTokensDeleted || result.passwordResetTokensDeleted || result.oauthTransactionsDeleted) {
        logger.log(
          `token cleanup: refreshTokens=${result.refreshTokensDeleted} passwordResetTokens=${result.passwordResetTokensDeleted} oauthTransactions=${result.oauthTransactionsDeleted}`,
        );
      }
    },
  });

  runtime.every({
    name: 'storage cleanup',
    intervalMs: STORAGE_CLEANUP_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastStorageCleanupAt', failures: 'storageCleanupFailures' },
    run: async () => {
      const result = await runStorageCleanupCycle(storageReconcileCommand, environmentService.get('STORAGE_CLEANUP_PURGE_DELETED_IMAGES_AFTER_DAYS'));
      logger.log(`storage cleanup: checked=${result.checkedRows} integrityProblems=${result.integrityProblems} orphans=${result.orphans} actions=${result.actionsTaken}`);
    },
  });

  runtime.every({
    name: 'shift report scheduler',
    intervalMs: SHIFT_REPORT_SCHEDULER_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastShiftReportSchedulerAt', failures: 'shiftReportSchedulerFailures' },
    run: async () => {
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
    },
  });

  // Worker credential isolation checkpoint: workspace provisioning no longer runs in this process
  // at all — it required the one genuinely privileged, DDL-performing connection
  // (`DATABASE_URL_UNPOOLED`), which this process never holds. See `workspace-provisioner.main.ts`,
  // a separate entrypoint/deployable, for the HWS_RUNTIME_ENABLED-gated provisioning cycle this
  // used to run here.

  runtime.every({
    name: 'final timesheet',
    intervalMs: FINAL_TIMESHEET_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastFinalTimesheetAt', failures: 'finalTimesheetFailures' },
    run: async () => {
      const result = await runFinalTimesheetCycle(directDataSource, tenantContext, emailOutboxService, fileService, { audit: auditService });
      if (result.sent || result.failed) {
        logger.log(`final timesheet: sent=${result.sent} failed=${result.failed} skippedLocked=${result.skippedLocked}`);
      }
    },
  });

  // Approved Shift Statement: outbox (payroll_record.statement_status, committed with the approval) → dispatcher →
  // BullMQ → consumer. jobId carries the dispatch generation, so a re-queue after a lost job is a NEW job and an old one
  // is ignored by the consumer's generation check. BullMQ attempts = 1: retries are the dispatcher's, counted on the row.
  const shiftStatementQueue = new Queue<ShiftStatementJobData>(SHIFT_STATEMENT_QUEUE_NAME, { connection: redis });
  const shiftStatementWorker = new Worker<ShiftStatementJobData>(
    SHIFT_STATEMENT_QUEUE_NAME,
    async (job) => processShiftStatementJob(job.data, { tenantContext, files: fileService, notifications: notificationService, audit: auditService }),
    { connection: redis, concurrency: SHIFT_STATEMENT_WORKER_CONCURRENCY },
  );
  shiftStatementWorker.on('error', (err) => logger.error('shift statement worker error', err));
  runtime.every({
    name: 'shift statement dispatch',
    intervalMs: SHIFT_STATEMENT_DISPATCH_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastShiftStatementDispatchAt', failures: 'shiftStatementDispatchFailures' },
    run: async () => {
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
    },
  });

  runtime.every({
    name: 'payroll period attention',
    intervalMs: PAYROLL_PERIOD_ATTENTION_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastPayrollPeriodAttentionAt', failures: 'payrollPeriodAttentionFailures' },
    run: async () => {
      const result = await runPayrollPeriodAttentionCycle(runtimeDataSource, tenantContext, notificationService);
      if (result.notified) logger.log(`payroll period attention: notified=${result.notified}`);
    },
  });

  // Stage 2 — Redis Pub/Sub distribution for Stage 1's durable outbox (`core.realtime_event`).
  // `runtimeDataSource` only (crewflow_app, same restricted role every other job here uses) —
  // never `directDataSource`/`DATABASE_URL_UNPOOLED`. See `publish-outbox.job.ts`'s own doc
  // comment for the claim/validate/publish/complete sequence and its at-least-once contract.
  const realtimeEnv = environmentService.get('NODE_ENV');
  runtime.every({
    name: 'realtime outbox publish',
    intervalMs: REALTIME_OUTBOX_PUBLISH_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastRealtimeOutboxPublishAt', failures: 'realtimeOutboxPublishFailures' },
    run: async () => {
      const result = await runRealtimeOutboxPublishCycle(
        runtimeDataSource,
        tenantContext,
        (channel, message) => realtimePublisherRedis.publish(channel, message),
        realtimeEnv,
      );
      if (result.claimed) {
        logger.log(`realtime outbox publish: claimed=${result.claimed} published=${result.published} invalid=${result.invalid} retried=${result.retried} failed=${result.failed}`);
      }
      return Boolean(result.claimed);
    },
  });

  // eslint-disable-next-line no-console
  console.log('rab-worker ready');

  let shutdownStarted = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const timeoutMs = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    // eslint-disable-next-line no-console
    console.log(`Worker received ${signal}, shutting down (waiting up to ${timeoutMs}ms for in-flight work)`);
    // Hard stop: never hang a deploy on a stuck cycle. Advisory locks are session-scoped, so exiting releases them.
    const hardExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('Worker shutdown exceeded its deadline — exiting');
      process.exit(1);
    }, timeoutMs + 10_000);
    hardExit.unref();
    try {
      runtime.beginShutdown(); // 1. no new cycle can start
      await emailWorker.close(); // 2. BullMQ stops taking jobs and waits for the active ones
      await pushWorker.close();
      await shiftStatementWorker.close();
      await shiftStatementQueue.close();
      const { drained, pending } = await runtime.drain(timeoutMs); // 3. in-flight cycles (a PDF render, an email claim)
      if (!drained) logger.warn(`${pending} cycle(s) still running after ${timeoutMs}ms — closing anyway (their locks release with the connection)`);
      await appContext.close(); // 4. Nest providers: BullMQ queue, Redis clients, crewflow_app pool
      await directDataSource.destroy();
      await realtimePublisherRedis.quit();
      await redis.quit();
      // eslint-disable-next-line no-console
      console.log('Worker shut down cleanly');
      process.exit(0);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Worker shutdown failed:', error);
      process.exit(1);
    }
  };

  releaseEarlyBootSignalGuard(); // synchronous swap: there is no window with neither handler installed
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', error);
  process.exit(1);
});
