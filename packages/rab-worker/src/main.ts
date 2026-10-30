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
import { EnvironmentService } from '@rab/server/engine/core-modules/environment/environment.service';
import { PushDeviceService } from '@rab/server/engine/core-modules/push/push-device.service';
import { PushQueueService } from '@rab/server/engine/core-modules/push/push-queue.service';
import { PushService } from '@rab/server/engine/core-modules/push/push.service';
import { SecretEncryptionService } from '@rab/server/engine/core-modules/secret-encryption/secret-encryption.service';
import { RealtimeEventService } from '@rab/server/engine/core-modules/realtime/realtime-event.service';
import { FileService } from '@rab/server/engine/core-modules/storage/file.service';
import { TenantContextService } from '@rab/server/engine/core-modules/tenant/tenant-context.service';
import { assertRuntimeDbRole } from '@rab/server/engine/utils/assert-runtime-db-role';
import { assertHwsStartupInvariants } from '@rab/server/database/typeorm/core/hws-startup-guard';
import { assertRuntimeDatabaseIdentity } from '@rab/server/database/typeorm/core/runtime-database-guard';
import { runDatabaseBootGates } from '@rab/server/database/boot-checks/database-boot-gates';
import { createPgDataSource, pgClientConfig, probePgSessionAffinity, resolvePgEnvironmentCached, setPgProcessRole } from '@rab/server/database/postgres/index';
import { AttendanceQrService } from '@rab/server/modules/attendance/services/attendance-qr.service';
import { QrImageService } from '@rab/server/modules/attendance/services/qr-image.service';
import { NotificationService } from '@rab/server/modules/notification/services/notification.service';
import { StorageReconcileCommand } from '@rab/server/command/storage-reconcile.command';
import {
  WORKER_CYCLE_DURATIONS_KEY,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '@rab/server/engine/worker-shared/heartbeat.constants';
import { SHIFT_STATEMENT_QUEUE_NAME, ShiftStatementJobData } from '@rab/server/modules/payroll/constants/shift-statement';
import { createInstanceHeartbeat } from './core/runtime/instance-heartbeat';
import { WorkerRuntime } from './core/runtime/worker-runtime';
import { BullmqScheduler, closeWorkersBounded, createConsumerWorkers, registerIntervalScans, startBullmqScheduler } from './core/scheduler/bullmq-scheduler';
import { ProcessorExplorer, ProcessorRegistrationError, validateHandlerRegistry } from './core/scheduler/processor-explorer';
import { resolveScanPrefix } from './core/scheduler/queue-registry';
import { RedisPreflightError } from './core/scheduler/redis-preflight';
import { isScanJobEnabled, resolveIntervalMs, SCAN_JOBS } from './core/scheduler/scan-jobs';
import { WorkerDependencies } from './core/scheduler/worker-dependencies';
import { WorkerModule } from './worker.module';
import { WORKER_DIRECT_POOL_MAX_BUDGET } from '@rab/server/database/runtime/connection-budget';
import { registerDataSourcePoolMetrics } from '@rab/server/database/runtime/database-metrics';
import { AiTitleService } from '@rab/server/modules/ai/services/ai-title.service';
import { AiTurnRunnerService } from '@rab/server/modules/ai/services/ai-turn-runner.service';

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
// The scan intervals (19 when they moved; AI Phase 1 later appended `ai-retention`, now 20 — and the reasoning behind each
// cadence: 2 s dispatchers that back the request-time fast path, 1–5 min monitors, 24 h housekeeping, env-driven cleanups)
// and the consumer concurrencies (5 / 10 / 2 when they moved; AI Phase 1 added `rab-ai`, 4) moved VERBATIM to core/scheduler/scan-jobs.ts and core/scheduler/queue-registry.ts — the single registry both scheduler
// modes read, so interval mode and bullmq mode can never disagree about a cadence or a stats key.
// How long SIGTERM waits for in-flight cycles (a PDF render is seconds) before giving up and exiting anyway.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
/**
 * Phase B (P6): explicit ceiling of `directDataSource` (it used to have none, so pg's default 10 applied, unrelated to the
 * runtime pool's setting). Holders, from the code: the five lock-holding scans (shift-report-scheduler, final-timesheet,
 * login-handoff-cleanup, outbox-retention, ai-retention) each pin at most ONE direct connection at a time for the length
 * of their lock, plus the brief discovery page transaction shift-report-scheduler and final-timesheet run on it before
 * taking a lock. 5 + 1 spare = 6. The value is the connection budget's own constant (connection-budget.ts), so the
 * startup budget check and this pool can never disagree. The scan lock and the storage-reconcile lock use their own
 * dedicated connections, not this pool.
 */
const WORKER_DIRECT_POOL_MAX = WORKER_DIRECT_POOL_MAX_BUDGET;

/** Refuses to start: prints a sanitised reason and exits non-zero before any queue consumer or connection is opened. */
function refuseStartup(error: unknown): never {
  const message = error instanceof Error ? error.message : 'unknown error';
  const prefix =
    error instanceof Error && error.name === 'RuntimeDbError'
      ? '[runtime-db-guard] refused: '
      : error instanceof Error && error.name === 'HwsStartupError'
        ? '[hws-startup-guard] refused: '
        : error instanceof Error && (error.name === 'PgConfigError' || error.name === 'PgSessionProbeError')
          ? '[pg-config] refused: '
        : error instanceof ProcessorRegistrationError || error instanceof RedisPreflightError
          ? '[worker-scheduler] refused: '
          : '';
  // eslint-disable-next-line no-console
  console.error(`${prefix}${message}`);
  process.exit(1);
}

async function bootstrap(): Promise<void> {
  // Phase B (B1): this is the Worker jobs process (application_name `crewflow-worker…`; a transaction-pooler URL shape is
  // refused because it holds session advisory locks). Declared before any DataSource exists; the configuration
  // (PG_DATABASE_URL, legacy names, URL policy, TLS) is refused here, before anything connects.
  setPgProcessRole('worker');
  const pg = (() => {
    try {
      return resolvePgEnvironmentCached(process.env, { processRole: 'worker' });
    } catch (error) {
      return refuseStartup(error);
    }
  })();
  // RUNTIME boundary: the database identity (both the application and owner-role connections) is verified BEFORE any
  // queue consumer, connection or job starts.
  await assertRuntimeDatabaseIdentity('worker').catch(refuseStartup);
  // ---- Phase B (A2): database boot gates (role, version, extensions, deployment identity, FORCE RLS, TLS, pending
  // migrations), before any queue consumer or pool. ----
  await runDatabaseBootGates('worker').catch(refuseStartup);
  // ---- end Phase B (A2) ----
  // Phase B (P4): the session-lock connection must be session-stable — a live two-connection probe (pg-session-probe.ts),
  // run even when PG_DATABASE_URL_IS_DIRECT=true. Strong evidence, not proof; the URL denylist already ran above.
  await probePgSessionAffinity(pgClientConfig(pg, { endpoint: 'lock', purpose: 'probe', statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }), {
    label: 'the Worker session-lock connection',
  }).catch(refuseStartup);
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
  // ioredis reconnects on its own; without a listener every failed reconnect during a Redis outage printed
  // "[ioredis] Unhandled error event" (found by the Lane A outage harness). A failed PUBLISH still fails its cycle.
  realtimePublisherRedis.on('error', () => undefined);

  const appContext = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn', 'log'] });
  // The worker's tenant-scoped work runs on this DataSource — it must be the restricted, RLS-bound role, exactly like the API.
  // Worker credential isolation checkpoint: the worker authenticates as `crewflow_app`, like the API. Two pools, one identity,
  // NEITHER of which is ever the privileged `DATABASE_URL_UNPOOLED` identity — see this file's own top doc comment.
  //   runtimeDataSource — pooled crewflow_app (DATABASE_URL, via the shared TypeORM module). Discovery, scans, token/invite
  //                       cleanup, storage-catalogue enumeration, email.
  //   directDataSource  — direct crewflow_app connection (the factory's lock endpoint: PG_DATABASE_URL; legacy
  //                       DATABASE_DIRECT_URL / DATABASE_URL outside production). Used ONLY where a session advisory lock
  //                       needs connection affinity (the five lock-holding scans).
  const runtimeDataSource = appContext.get(DataSource);
  await assertRuntimeDbRole(runtimeDataSource, 'worker');
  // HWS runtime cutover (Part 26): same invariant check as the API (same coreDataSourceOptions, same TenantContextService),
  // run against the worker's own runtimeDataSource — it's the one whose entity metadata and migrationsTableName matter.
  await assertHwsStartupInvariants(runtimeDataSource, appContext.get(EnvironmentService).get('HWS_RUNTIME_ENABLED')).catch(refuseStartup);
  // Phase B: same timeouts as before (30 s statement and query, 10 s connect, keep-alive), now from the factory, with an
  // explicit TLS object, application_name `crewflow-worker-lock`, idle-in-transaction timeout and an explicit max.
  const directDataSource = createPgDataSource(
    pg,
    { endpoint: 'lock', purpose: 'lock', max: WORKER_DIRECT_POOL_MAX },
    { schema: 'core', entities: [], synchronize: false },
  );
  await directDataSource.initialize();
  // Phase B (B5): pool metrics for the session-lock pool (internal metrics only; no credential, no tenant data).
  registerDataSourcePoolMetrics('worker-direct', directDataSource);
  await assertRuntimeDbRole(directDataSource, 'worker-direct');

  const environmentService = appContext.get(EnvironmentService);
  const schedulerMode = environmentService.get('WORKER_SCHEDULER');
  const realtimePublish = (channel: string, message: string) => realtimePublisherRedis.publish(channel, message);
  // Approved Shift Statement producer (legacy `bull` prefix): the dispatcher adapter publishes through it.
  const shiftStatementQueue = new Queue<ShiftStatementJobData>(SHIFT_STATEMENT_QUEUE_NAME, { connection: redis });
  appContext.get(WorkerDependencies).provide({
    logger,
    runtimeDataSource,
    directDataSource,
    tenantContext: appContext.get(TenantContextService),
    auditService: appContext.get(AuditService),
    notificationService: appContext.get(NotificationService),
    environmentService,
    realtimeEventService: appContext.get(RealtimeEventService),
    emailService: appContext.get(EmailService),
    emailQueue: appContext.get(EmailQueueService),
    emailOutboxService: appContext.get(EmailOutboxService),
    pushService: appContext.get(PushService),
    pushQueue: appContext.get(PushQueueService),
    pushDeviceService: appContext.get(PushDeviceService),
    secretEncryptionService: appContext.get(SecretEncryptionService),
    fileService: appContext.get(FileService),
    attendanceQrService: appContext.get(AttendanceQrService),
    qrImageService: appContext.get(QrImageService),
    storageReconcileCommand: appContext.get(StorageReconcileCommand),
    realtimePublish,
    shiftStatementQueue,
  });

  // Processor discovery (BullMQ migration M2): every scan and consumer handler is a `@Process` method on a `@Processor`
  // provider. A duplicate handler, a scheduled job with no handler, an unknown queue or an orphan handler refuses to
  // start here — before any consumer, scheduler or loop exists.
  const registry = (() => {
    try {
      const found = appContext.get(ProcessorExplorer).explore();
      validateHandlerRegistry(found);
      return found;
    } catch (error) {
      return refuseStartup(error);
    }
  })();
  const intervalOf = (def: (typeof SCAN_JOBS)[number]) => resolveIntervalMs(def, environmentService);
  // Phase A pa-intervals: push-dispatch only with PUSH_ENABLED=true, realtime-outbox-publish only with REALTIME_ENABLED=true.
  const isEnabled = (def: (typeof SCAN_JOBS)[number]) => isScanJobEnabled(def, environmentService);
  // Fail closed before any consumer, scheduler or loop exists: every scan interval must resolve (validated env + bounds).
  try {
    for (const def of SCAN_JOBS) intervalOf(def);
  } catch (error) {
    refuseStartup(error);
  }

  // The three existing consumers — one Worker each, both modes, legacy `bull` prefix, concurrency 5 / 10 / 2.
  const consumers = createConsumerWorkers(registry, redis, logger);

  const runtime = new WorkerRuntime(redis, {
    // interval: whole-object stats writes, exactly as before. bullmq: per-field writes (replicas take turns).
    statsWrite: schedulerMode === 'bullmq' ? 'fields' : 'whole',
    durationsKey: WORKER_CYCLE_DURATIONS_KEY,
  });
  // Per-instance heartbeat file — a no-op unless CREWFLOW_INSTANCE_HEALTH_FILE is set (the Worker bundle sets it). The
  // global Redis key below can be refreshed by another replica; see instance-heartbeat.ts.
  const instanceHeartbeat = createInstanceHeartbeat('jobs', runtime);
  let scheduler: BullmqScheduler | null = null;

  // Heartbeat: unchanged in both modes (the liveness signal Admin Health and invitation sends read).
  const beat = () => {
    if (scheduler?.consumersRunning()) runtime.markConsumersReady();
    instanceHeartbeat.beat();
    redis.set(WORKER_HEARTBEAT_KEY, Date.now().toString(), 'EX', WORKER_HEARTBEAT_TTL_SECONDS).then(instanceHeartbeat.markRedisOk, () => {
      // Best-effort — a missed heartbeat just makes the next Health tab read report Down/stale, which is correct.
    });
  };
  beat();
  runtime.interval(beat, HEARTBEAT_INTERVAL_MS);

  if (schedulerMode === 'bullmq') {
    // ONE cluster-wide job scheduler per scan; this replica consumes whichever ticks it wins. Redis preflight
    // (noeviction, API support) and the dedicated scan-lock connection come first — any failure refuses to start.
    const prefix = resolveScanPrefix(environmentService.get('NODE_ENV'), environmentService.get('BULLMQ_PREFIX'));
    scheduler = await startBullmqScheduler({
      redis,
      redisUrl,
      // Phase B: the factory's lock endpoint as an explicit pg config (target, TLS object, application_name, startup
      // options; pooler denylist applied), with ScanLock's own 5 s timeouts.
      lockConnection: pgClientConfig(pg, { endpoint: 'lock', purpose: 'scan-lock', statementTimeoutMs: 5_000, queryTimeoutMs: 5_000 }),
      prefix,
      reconcileMs: environmentService.get('WORKER_SCHEDULER_RECONCILE_SECONDS') * 1000,
      runtime,
      registry,
      jobs: SCAN_JOBS, // ALL scans: a disabled scan's scheduler is removed on reconcile, re-added when re-enabled
      intervalOf,
      isEnabled,
      logger,
    }).catch(refuseStartup);
    beat();
  } else {
    // interval (default): the historical behaviour — every ENABLED loop on this process's own timer, in the original
    // order, registered exactly once.
    const { disabled } = registerIntervalScans(runtime, registry, SCAN_JOBS, intervalOf, isEnabled);
    if (disabled.length) logger.log(`interval scheduler: not registered (disabled by their enable switch): ${disabled.join(', ')}`);
  }

  // eslint-disable-next-line no-console
  console.log(`rab-worker ready${schedulerMode === 'bullmq' ? ' (scheduler=bullmq)' : ''}`);

  // Every consumer Worker (email, push, shift statements and — AI Phase 1 — rab-ai), from the one registry.
  const consumerWorkers: Worker[] = [...consumers.values()];
  const aiTurns = appContext.get(AiTurnRunnerService);
  const aiTitles = appContext.get(AiTitleService);
  let shutdownStarted = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    const timeoutMs = Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    const startedAt = Date.now();
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
      runtime.beginShutdown(); // 1. no new cycle can start (interval timers stop; a bullmq job delivered now is skipped)
      // AI Phase 1: in-flight AI turns stop calling the model now and finalise as AI_WORKER_INTERRUPTED (no partial re-run).
      const abortedTurns = aiTurns.abortAll();
      if (abortedTurns) logger.log(`aborting ${abortedTurns} in-flight AI turn(s) for shutdown`);
      // AI Phase 2: in-flight title calls stop too (the fallback title stays; no retry).
      const abortedTitles = aiTitles.abortAll();
      if (abortedTitles) logger.log(`aborting ${abortedTitles} in-flight AI title call(s) for shutdown`);
      if (scheduler) {
        // 2. bullmq: stop the periodic reconcile (schedulers are NEVER removed on shutdown — the next replica keeps them),
        // then every Worker (scan + consumer) stops fetching and finishes its active job, in parallel, inside the drain
        // budget; a Worker still busy at the deadline is force-closed and its job is left in Redis for stalled recovery.
        scheduler.manager.stop();
        const { timedOut } = await closeWorkersBounded([...scheduler.scanWorkers, ...consumerWorkers], timeoutMs, logger);
        if (timedOut) {
          // Budget spent with jobs still running: exit now (well inside the hard-exit deadline). Session advisory locks
          // die with the connections; the active BullMQ jobs stay in Redis and are recovered by another replica.
          await runtime.flushMetrics();
          process.exit(1);
        }
      } else {
        for (const worker of consumerWorkers) await worker.close(); // 2. BullMQ stops taking jobs and waits for the active ones
      }
      await shiftStatementQueue.close();
      const remaining = scheduler ? Math.max(0, timeoutMs - (Date.now() - startedAt)) : timeoutMs;
      const { drained, pending } = await runtime.drain(remaining); // 3. in-flight cycles (a PDF render, an email claim)
      if (!drained) logger.warn(`${pending} cycle(s) still running after ${timeoutMs}ms — closing anyway (their locks release with the connection)`);
      await runtime.flushMetrics();
      if (scheduler) {
        await scheduler.manager.close();
        await scheduler.scanLock.close(); // releases every scan lock this replica held (session-scoped)
      }
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
