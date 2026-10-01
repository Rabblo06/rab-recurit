import { releaseEarlyBootSignalGuard } from '@rab/server/engine/utils/early-boot-signal-guard'; // MUST stay the first import
import 'dotenv/config';
import '@rab/server/instrument';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AuditService } from '@rab/server/engine/core-modules/audit/audit.service';
import { EmailOutboxService } from '@rab/server/engine/core-modules/email/email-outbox.service';
import { EmailQueueService } from '@rab/server/engine/core-modules/email/email-queue.service';
import { EmailService } from '@rab/server/engine/core-modules/email/email.service';
import { EMAIL_QUEUE_NAME } from '@rab/server/engine/core-modules/email/email-queue.constants';
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '@rab/server/engine/utils/assert-runtime-db-role';
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
import { runAttendanceMonitorCycle } from './queues/rab-shifts/attendance-monitor.job';
import { runLateClockInCycle } from './queues/rab-shifts/late-clock-in.job';
import { runShiftCancellationFollowupCycle } from './queues/rab-shifts/shift-cancellation-followup.job';
import { runShiftMonitorCycle } from './queues/rab-shifts/shift-monitor.job';
import { runManagerConfirmationTimeoutCycle, runOfferExpiryCycle } from './queues/rab-offers/offer-expiry.job';
import { runReplacementStaffCycle } from './queues/rab-offers/replacement-staff.job';
import { runFinalTimesheetCycle } from './queues/rab-reports/final-timesheet.job';
import { runShiftReportSchedulerCycle } from './queues/rab-reports/shift-report-scheduler.job';
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
 * Two connection classes, matching CLAUDE.md's own rule — genuinely
 * cross-tenant maintenance/discovery sweeps use the owner connection
 * (`ownerDataSource`, read-only for catalogue discovery; legacy token and
 * invitation retention still perform owner maintenance writes). Business
 * mutations (an email send, a shift reminder, a no-show flag, an offer
 * expiry, a report, a replacement request, a cancellation follow-up) runs
 * through `TenantContextService` as `rab_app`, bound to that SPECIFIC row's
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
// How long SIGTERM waits for in-flight cycles (a PDF render is seconds) before giving up and exiting anyway.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

async function bootstrap(): Promise<void> {
  const logger = new NestLogger('RabWorker');

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error('REDIS_URL is required — the worker must not start without it');
  }

  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.ping();

  const cleanupUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!cleanupUrl) {
    throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) is required — the worker must not start without it');
  }
  // Shared by every owner-connection sweep (invitation cleanup, token
  // cleanup, storage reconciliation, and fixed read-only workspace-ID
  // enumeration for the shift/attendance/offer/report jobs) — one owner connection for every genuinely cross-tenant step this
  // process runs; every per-row mutation moves off it onto `rab_app`
  // immediately after discovery. It MUST be a direct (unpooled) connection:
  // the report jobs rely on session-level advisory locks, which a
  // transaction-mode pooler would not preserve.
  const ownerDataSource = new DataSource({ type: 'postgres', url: cleanupUrl, schema: 'core', entities: [], synchronize: false });
  await ownerDataSource.initialize();

  const appContext = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn', 'log'] });
  // The worker's tenant-scoped work runs on this DataSource — it must be the restricted, RLS-bound role, exactly like the API.
  await assertRuntimeDbRole(appContext.get(DataSource), 'worker');

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
  const storageReconcileCommand = appContext.get(StorageReconcileCommand);
  // Privileged pool enumerates catalogue IDs only; metadata work keeps the injected rab_app pool.
  storageReconcileCommand.catalogueDataSource = ownerDataSource;

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
      const result = await runAccountInviteCleanupCycle(ownerDataSource);
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
        ownerDataSource,
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
    name: 'shift monitor',
    intervalMs: SHIFT_MONITOR_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastShiftMonitorAt', failures: 'shiftMonitorFailures' },
    run: async () => {
      const result = await runShiftMonitorCycle(ownerDataSource, tenantContext, notificationService, auditService);
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
      const result = await runAttendanceMonitorCycle(ownerDataSource, tenantContext, notificationService, auditService);
      if (result.flagged) logger.log(`attendance monitor: flagged=${result.flagged}`);
    },
  });

  runtime.every({
    name: 'late clock-in',
    intervalMs: LATE_CLOCK_IN_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastLateClockInAt', failures: 'lateClockInFailures' },
    run: async () => {
      const result = await runLateClockInCycle(ownerDataSource, tenantContext, notificationService, auditService, environmentService.get('LATE_CLOCK_IN_GRACE_MINUTES'));
      if (result.flagged) logger.log(`late clock-in: flagged=${result.flagged}`);
    },
  });

  runtime.every({
    name: 'shift cancellation follow-up',
    intervalMs: SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastShiftCancellationFollowupAt', failures: 'shiftCancellationFollowupFailures' },
    run: async () => {
      const result = await runShiftCancellationFollowupCycle(ownerDataSource, tenantContext, notificationService, auditService);
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
      const result = await runOfferExpiryCycle(ownerDataSource, tenantContext, notificationService, auditService);
      if (result.expired) logger.log(`offer expiry: expired=${result.expired}`);
    },
  });

  runtime.every({
    name: 'manager confirmation timeout',
    intervalMs: MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastManagerConfirmationTimeoutAt', failures: 'managerConfirmationTimeoutFailures' },
    run: async () => {
      const result = await runManagerConfirmationTimeoutCycle(
        ownerDataSource,
        tenantContext,
        notificationService,
        auditService,
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
      const result = await runReplacementStaffCycle(ownerDataSource, tenantContext, notificationService, auditService);
      if (result.created) logger.log(`replacement staff: created=${result.created} noCandidates=${result.noCandidates}`);
    },
  });

  runtime.every({
    name: 'token cleanup',
    intervalMs: TOKEN_CLEANUP_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastTokenCleanupAt', failures: 'tokenCleanupFailures' },
    run: async () => {
      const result = await runTokenCleanupCycle(ownerDataSource);
      if (result.refreshTokensDeleted || result.passwordResetTokensDeleted) {
        logger.log(`token cleanup: refreshTokens=${result.refreshTokensDeleted} passwordResetTokens=${result.passwordResetTokensDeleted}`);
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
        ownerDataSource,
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

  runtime.every({
    name: 'final timesheet',
    intervalMs: FINAL_TIMESHEET_INTERVAL_MS,
    statKeys: { lastRunAt: 'lastFinalTimesheetAt', failures: 'finalTimesheetFailures' },
    run: async () => {
      const result = await runFinalTimesheetCycle(ownerDataSource, tenantContext, emailOutboxService, fileService, { audit: auditService });
      if (result.sent || result.failed) {
        logger.log(`final timesheet: sent=${result.sent} failed=${result.failed} skippedLocked=${result.skippedLocked}`);
      }
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
      const { drained, pending } = await runtime.drain(timeoutMs); // 3. in-flight cycles (a PDF render, an email claim)
      if (!drained) logger.warn(`${pending} cycle(s) still running after ${timeoutMs}ms — closing anyway (their locks release with the connection)`);
      await appContext.close(); // 4. Nest providers: BullMQ queue, Redis clients, rab_app pool
      await ownerDataSource.destroy();
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
