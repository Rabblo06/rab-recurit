import 'dotenv/config';
import '../instrument';

import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';

import { AppModule } from '../app.module';
import { AuditService } from '../engine/core-modules/audit/audit.service';
import { EmailQueueService } from '../engine/core-modules/email/email-queue.service';
import { EmailService } from '../engine/core-modules/email/email.service';
import { EMAIL_QUEUE_NAME } from '../engine/core-modules/email/email-queue.constants';
import { TenantContextService } from '../engine/core-modules/tenant/tenant-context.service';
import { NotificationService } from '../modules/notification/services/notification.service';
import { WORKER_HEARTBEAT_KEY, WORKER_HEARTBEAT_TTL_SECONDS, WORKER_STATS_KEY } from './heartbeat.constants';
import { runAccountInviteCleanupCycle } from './jobs/account-invite-cleanup.job';
import { runEmailDispatchCycle } from './jobs/email-dispatch.job';
import { createEmailSendProcessor } from './jobs/email-send.processor';
import { runAttendanceMonitorCycle } from './attendance/attendance-monitor.job';
import { runTokenCleanupCycle } from './maintenance/token-cleanup.job';
import { runOfferExpiryCycle } from './offers/offer-expiry.job';
import { runShiftMonitorCycle } from './shifts/shift-monitor.job';

/**
 * ONE `rab-worker` process, multiple job categories — deploys as a
 * separate service from the API (§3 of this file's own history), never
 * merged into request handling, so nothing here competes with an HTTP
 * request for CPU/DB-pool budget. This file only bootstraps and
 * coordinates; every category's actual logic lives in its own module
 * (`email/` via `jobs/`, `shifts/`, `attendance/`, `offers/`,
 * `maintenance/`) — see each file's own doc comment for why it exists and
 * how it's scoped. `jobs/` (email-dispatch, email-send, account-invite-
 * cleanup) keeps its original location and name rather than being
 * relocated into `email/`/`maintenance/` purely for taxonomy's sake —
 * those three files are already working, already tested, already imported
 * by name from two integration-test files; moving them would be pure
 * churn with real regression risk for zero behavioural gain. New
 * categories get new folders; nothing that already worked was reshuffled.
 *
 * Two connection classes, matching CLAUDE.md's own rule and this file's
 * explicit remit — genuinely cross-tenant maintenance/discovery sweeps use
 * the owner connection throughout (`ownerDataSource`, unchanged from
 * before); every actual per-row mutation (an email send, a shift reminder,
 * a no-show flag, an offer expiry) runs through `TenantContextService` as
 * `rab_app`, bound to that SPECIFIC row's real organisation — see
 * `shared/scoped-job.ts`. No processor here ever gets the owner
 * connection for anything except read-only candidate discovery.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;
// 15 min — see account-invite-cleanup.job.ts's own doc comment.
const ACCOUNT_INVITE_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
// Short — this drives real user-facing latency (how soon after an admin
// clicks "Create Manager" does the invite actually attempt delivery). The
// request-time fast-path publish (EmailOutboxService.tryFastPublish) covers
// the common case in near-real-time; this interval is the durability
// backstop for whatever that fast path missed (a crash, a Redis blip) — see
// jobs/email-dispatch.job.ts's own doc comment.
const EMAIL_DISPATCH_INTERVAL_MS = 2_000;
const EMAIL_WORKER_CONCURRENCY = 5;
// Shift/offer/attendance monitors are periodic scans, not per-row BullMQ
// delayed jobs (see shifts/shift-monitor.job.ts's own doc comment for why)
// — a few minutes' imprecision on "remind 24h before a shift" or "flag a
// missed clock-out" is immaterial, so these run on a modest, DB-pool-
// friendly cadence rather than the email dispatcher's tight 2s loop.
const SHIFT_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const ATTENDANCE_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
// Offers are more time-sensitive (a stale PENDING offer blocks the shift
// slot from being reassigned) — closer to the email dispatcher's cadence.
const OFFER_EXPIRY_INTERVAL_MS = 60 * 1000;
// Pure housekeeping, no user-facing latency depends on it — once a day is
// plenty, matching this file's own "controlled daily scheduler" allowance
// for genuinely global periodic sweeps.
const TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function bootstrap(): Promise<void> {
  const logger = new NestLogger('QueueWorker');

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
  // cleanup, and the read-only candidate-discovery half of the shift/
  // attendance/offer monitors) — one owner connection for every genuinely
  // cross-tenant step this process runs; every per-row mutation moves off
  // it onto `rab_app` immediately after discovery (see this file's own
  // doc comment above).
  const ownerDataSource = new DataSource({ type: 'postgres', url: cleanupUrl, schema: 'core', entities: [], synchronize: false });
  await ownerDataSource.initialize();

  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const emailService = appContext.get(EmailService);
  const tenantContext = appContext.get(TenantContextService);
  const auditService = appContext.get(AuditService);
  const emailQueue = appContext.get(EmailQueueService);
  const notificationService = appContext.get(NotificationService);

  const emailWorker = new Worker(EMAIL_QUEUE_NAME, createEmailSendProcessor({ tenantContext, emailService, auditService }), {
    connection: redis,
    concurrency: EMAIL_WORKER_CONCURRENCY,
  });
  emailWorker.on('failed', (job, err) => {
    logger.warn(`email job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
  });
  emailWorker.on('error', (err) => {
    logger.error('email worker error', err);
  });

  // eslint-disable-next-line no-console
  console.log('rab-server worker ready');

  const stats: Record<string, string | number> = { startedAt: Date.now() };
  const writeStats = () => {
    redis.hset(WORKER_STATS_KEY, stats).catch(() => {
      // Best-effort — see WORKER_HEARTBEAT_KEY's own doc comment on why this never blocks a job cycle.
    });
  };

  const beat = () => {
    redis.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS).catch(() => {
      // Best-effort — a missed heartbeat just makes the next Health tab read report Down/stale, which is correct.
    });
  };
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const runCleanup = () => {
    runAccountInviteCleanupCycle(ownerDataSource)
      .then((result) => {
        stats.lastAccountInviteCleanupAt = Date.now();
        if (result.expired || result.deleted || result.retained) {
          // eslint-disable-next-line no-console
          console.log(`account-invite cleanup: expired=${result.expired} deleted=${result.deleted} retained=${result.retained}`);
        }
        writeStats();
      })
      .catch((error) => {
        stats.accountInviteCleanupFailures = Number(stats.accountInviteCleanupFailures ?? 0) + 1;
        writeStats();
        // eslint-disable-next-line no-console
        console.error('account-invite cleanup cycle failed:', error);
      });
  };
  runCleanup();
  const cleanupTimer = setInterval(runCleanup, ACCOUNT_INVITE_CLEANUP_INTERVAL_MS);

  const runDispatch = () => {
    runEmailDispatchCycle(ownerDataSource, (id, orgId) => emailQueue.publish(id, orgId))
      .then((result) => {
        if (result.claimed) {
          stats.lastEmailDispatchAt = Date.now();
          writeStats();
          logger.log(`email dispatch: claimed=${result.claimed} published=${result.published}`);
        }
      })
      .catch((error) => {
        stats.emailDispatchFailures = Number(stats.emailDispatchFailures ?? 0) + 1;
        writeStats();
        logger.error('email dispatch cycle failed', error as Error);
      });
  };
  runDispatch();
  const dispatchTimer = setInterval(runDispatch, EMAIL_DISPATCH_INTERVAL_MS);

  const runShiftMonitor = () => {
    runShiftMonitorCycle(ownerDataSource, tenantContext, notificationService, auditService)
      .then((result) => {
        stats.lastShiftMonitorAt = Date.now();
        if (result.remindersSent || result.noShowsFlagged) {
          logger.log(`shift monitor: reminders=${result.remindersSent} noShows=${result.noShowsFlagged}`);
        }
        writeStats();
      })
      .catch((error) => {
        stats.shiftMonitorFailures = Number(stats.shiftMonitorFailures ?? 0) + 1;
        writeStats();
        logger.error('shift monitor cycle failed', error as Error);
      });
  };
  runShiftMonitor();
  const shiftMonitorTimer = setInterval(runShiftMonitor, SHIFT_MONITOR_INTERVAL_MS);

  const runAttendanceMonitor = () => {
    runAttendanceMonitorCycle(ownerDataSource, tenantContext, notificationService, auditService)
      .then((result) => {
        stats.lastAttendanceMonitorAt = Date.now();
        if (result.flagged) logger.log(`attendance monitor: flagged=${result.flagged}`);
        writeStats();
      })
      .catch((error) => {
        stats.attendanceMonitorFailures = Number(stats.attendanceMonitorFailures ?? 0) + 1;
        writeStats();
        logger.error('attendance monitor cycle failed', error as Error);
      });
  };
  runAttendanceMonitor();
  const attendanceMonitorTimer = setInterval(runAttendanceMonitor, ATTENDANCE_MONITOR_INTERVAL_MS);

  const runOfferExpiry = () => {
    runOfferExpiryCycle(ownerDataSource, tenantContext, notificationService, auditService)
      .then((result) => {
        stats.lastOfferExpiryAt = Date.now();
        if (result.expired) logger.log(`offer expiry: expired=${result.expired}`);
        writeStats();
      })
      .catch((error) => {
        stats.offerExpiryFailures = Number(stats.offerExpiryFailures ?? 0) + 1;
        writeStats();
        logger.error('offer expiry cycle failed', error as Error);
      });
  };
  runOfferExpiry();
  const offerExpiryTimer = setInterval(runOfferExpiry, OFFER_EXPIRY_INTERVAL_MS);

  const runTokenCleanup = () => {
    runTokenCleanupCycle(ownerDataSource)
      .then((result) => {
        stats.lastTokenCleanupAt = Date.now();
        if (result.refreshTokensDeleted || result.passwordResetTokensDeleted) {
          logger.log(`token cleanup: refreshTokens=${result.refreshTokensDeleted} passwordResetTokens=${result.passwordResetTokensDeleted}`);
        }
        writeStats();
      })
      .catch((error) => {
        stats.tokenCleanupFailures = Number(stats.tokenCleanupFailures ?? 0) + 1;
        writeStats();
        logger.error('token cleanup cycle failed', error as Error);
      });
  };
  runTokenCleanup();
  const tokenCleanupTimer = setInterval(runTokenCleanup, TOKEN_CLEANUP_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Worker received ${signal}, shutting down`);
    clearInterval(heartbeatTimer);
    clearInterval(cleanupTimer);
    clearInterval(dispatchTimer);
    clearInterval(shiftMonitorTimer);
    clearInterval(attendanceMonitorTimer);
    clearInterval(offerExpiryTimer);
    clearInterval(tokenCleanupTimer);
    await emailWorker.close();
    await appContext.close();
    await ownerDataSource.destroy();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', error);
  process.exit(1);
});
