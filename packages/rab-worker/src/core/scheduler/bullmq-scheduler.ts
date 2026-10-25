import { Logger } from '@nestjs/common';
import { Job, MetricsTime, UnrecoverableError, Worker } from 'bullmq';
import * as os from 'node:os';
import type Redis from 'ioredis';

import { WORKER_SCHEDULER_STATUS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { ScanLock } from '../locking/scan-lock';
import { WorkerLoopOptions, WorkerRuntime } from '../runtime/worker-runtime';
import { HandlerRegistry, ProcessHandler } from './processor-explorer';
import { CONSUMER_QUEUES, ConsumerQueueDefinition, SCAN_QUEUE_NAMES, ScanQueueName } from './queue-registry';
import { assertRedisReadyForBullmq, assertSupportedBullmqApi } from './redis-preflight';
import { CrewflowSchedulerManager, ReconcileReport } from './scheduler-manager';
import { lockDurationMsFor, ScanJobDefinition, scanJobsOn, schedulerIdOf } from './scan-jobs';

/** The loop options both scheduler modes hand to WorkerRuntime for one scan (same name, stats keys, metric key). */
export function loopOptionsOf(def: ScanJobDefinition, handler: ProcessHandler, intervalMs: number): WorkerLoopOptions {
  return {
    name: def.name,
    intervalMs,
    statKeys: def.statKeys,
    metricKey: def.jobName,
    run: (ctx) => handler(ctx) as Promise<boolean | void>,
  };
}

/**
 * Admin panel follow-up (owner-approved): BullMQ metrics on every Worker this process creates — consumer and scan —
 * one data point per minute, one week kept (`MetricsTime.ONE_WEEK` = `WORKER_METRICS_MAX_DATA_POINTS`). Read by the API's
 * Admin panel Health chart (`Queue.getMetrics`); counts only, never job data.
 */
export const WORKER_METRICS = Object.freeze({ maxDataPoints: MetricsTime.ONE_WEEK });

/**
 * The three existing consumers (`rab-email` 5, `rab-push` 10, `rab-shift-statements` 2) — one Worker each, in BOTH
 * scheduler modes (never duplicated), on the legacy `bull` prefix, with the same connection, concurrency and event
 * logging main.ts always used. Producer-side options (attempts/backoff/jobIds/removeOn*) are untouched.
 */
export function createConsumerWorkers(registry: HandlerRegistry, connection: Redis, logger: Logger): Map<ConsumerQueueDefinition['key'], Worker> {
  const workers = new Map<ConsumerQueueDefinition['key'], Worker>();
  for (const def of Object.values(CONSUMER_QUEUES)) {
    const handler = registry.get(def.name, def.jobName)!.handler;
    // Every job on the queue goes to its one handler, exactly as the single processor function did before.
    const worker = new Worker(def.name, (job: Job) => handler(job), { connection, concurrency: def.concurrency, metrics: WORKER_METRICS });
    if (def.key !== 'shiftStatements') {
      worker.on('failed', (job, err) => {
        logger.warn(`${def.logName} job ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`);
      });
    }
    worker.on('error', (err) => {
      logger.error(`${def.logName} worker error`, err);
    });
    workers.set(def.key, worker);
  }
  return workers;
}

export interface BullmqSchedulerDeps {
  redis: Redis;
  redisUrl: string;
  /** Direct crewflow_app URL for the dedicated scan-lock connection. */
  lockUrl: string;
  prefix: string;
  reconcileMs: number;
  runtime: WorkerRuntime;
  registry: HandlerRegistry;
  jobs: readonly ScanJobDefinition[];
  intervalOf: (def: ScanJobDefinition) => number;
  logger: Logger;
}

export interface BullmqScheduler {
  manager: CrewflowSchedulerManager;
  scanLock: ScanLock;
  scanWorkers: Worker[];
  /** True when every scan Worker is running (used by the heartbeat to refresh `consumersReadyAt`). */
  consumersRunning(): boolean;
}

/** At most one call per `windowMs` (the first error is always reported). */
export function throttled<A extends unknown[]>(windowMs: number, fn: (...args: A) => void, now: () => number = Date.now): (...args: A) => void {
  let last = -Infinity;
  return (...args: A) => {
    const t = now();
    if (t - last < windowMs) return;
    last = t;
    fn(...args);
  };
}

/** A failed scan's BullMQ error: a fixed message, no stack, no cycle error text (which could quote row values). */
function scanFailure(def: ScanJobDefinition): Error {
  const error = new Error(`${def.name} cycle failed (details in the worker log)`);
  error.stack = error.message;
  return error;
}

export async function startBullmqScheduler(deps: BullmqSchedulerDeps): Promise<BullmqScheduler> {
  const { redis, runtime, registry, logger } = deps;
  assertSupportedBullmqApi();
  const preflight = await assertRedisReadyForBullmq(redis, deps.redisUrl, logger);
  logger.log(`bullmq scheduler: Redis maxmemory-policy=${preflight.maxmemoryPolicy} version=${preflight.redisVersion ?? 'unknown'} authenticated=${preflight.authenticated}`);
  runtime.enableSchedulerProgress();

  const scanLock = await ScanLock.open(deps.lockUrl, logger);
  const manager = new CrewflowSchedulerManager({ connection: redis, prefix: deps.prefix, jobs: deps.jobs, intervalOf: deps.intervalOf, logger });
  const instance = `${os.hostname()}:${process.pid}`;
  const writeStatus = (report: ReconcileReport) =>
    redis
      .multi()
      .hset(WORKER_SCHEDULER_STATUS_KEY, { mode: 'bullmq', prefix: deps.prefix, reconciledAt: Date.now(), schedulers: report.upserted.length, instance })
      .expire(WORKER_SCHEDULER_STATUS_KEY, Math.max(180, Math.ceil((deps.reconcileMs * 3) / 1000)))
      .exec()
      .catch(() => undefined);

  const first = await manager.reconcile();
  runtime.markReconcileOk();
  await writeStatus(first);
  logger.log(
    `bullmq scheduler: ${first.upserted.length} Crewflow schedulers reconciled under prefix ${deps.prefix}` +
      (first.removedStale.length ? `, removed stale ${first.removedStale.join(', ')}` : '') +
      (first.foreignUntouched.length ? `, ${first.foreignUntouched.length} foreign scheduler(s) left untouched` : ''),
  );

  const byQueue = new Map<ScanQueueName, Map<string, ScanJobDefinition>>();
  for (const def of deps.jobs) {
    if (!byQueue.has(def.queue)) byQueue.set(def.queue, new Map());
    byQueue.get(def.queue)!.set(def.jobName, def);
  }

  const scanWorkers: Worker[] = [];
  for (const queue of SCAN_QUEUE_NAMES) {
    const defs = byQueue.get(queue);
    if (!defs) continue;
    const worker = new Worker(
      queue,
      async (job: Job) => {
        const def = defs.get(job.name);
        // Fail closed: a job this registry does not know is never mapped to some other scan.
        if (!def) throw new UnrecoverableError('unknown scan job');
        const options = loopOptionsOf(def, registry.scan(def), deps.intervalOf(def));
        const outcome = await runtime.runOnce(options, (work) => scanLock.run(schedulerIdOf(def), work));
        if (outcome === 'failed') throw scanFailure(def);
        return { outcome };
      },
      {
        connection: redis,
        prefix: deps.prefix,
        // One slot per distinct scan on the queue: different scans never wait for each other (as in interval mode,
        // where every loop has its own timer); the same scan never overlaps (runtime guard + scan lock).
        concurrency: scanJobsOn(queue).length,
        lockDuration: lockDurationMsFor(queue),
        metrics: WORKER_METRICS,
        // Recorded by BullMQ on each job (`processedBy`) — which replica ran which tick (host name + pid, no config).
        name: instance.replace(/[^A-Za-z0-9:._-]/g, '_'),
      },
    );
    // Throttled: during a Redis outage every reconnect attempt re-emits on every Worker sharing the connection.
    worker.on('error', throttled(60_000, (err: Error) => logger.error(`scan worker ${queue} error: ${err.message}`)));
    scanWorkers.push(worker);
  }

  manager.startPeriodic(deps.reconcileMs, (result) => {
    if (result.ok) {
      runtime.markReconcileOk();
      void writeStatus(result.report);
    } else {
      logger.warn(`bullmq scheduler reconcile failed: ${result.error.message}`);
    }
  });

  return {
    manager,
    scanLock,
    scanWorkers,
    consumersRunning: () => scanWorkers.every((w) => w.isRunning() && !w.closing),
  };
}

/**
 * Bounded close (M6): every Worker stops fetching and waits for its active jobs, IN PARALLEL, for at most `budgetMs`.
 * Never throws. BullMQ cannot turn a graceful close that has already started into a forced one (`close(true)` returns
 * the pending graceful close), so on timeout this only REPORTS the Workers still busy; the caller then exits the
 * process. Their active jobs are never deleted: they stay in Redis, their lock stops being renewed when the process
 * ends, and BullMQ's stalled check hands them to another replica (harness C4 / bundle B5).
 */
export async function closeWorkersBounded(workers: readonly Worker[], budgetMs: number, logger: { warn(message: string): void }): Promise<{ timedOut: number }> {
  const closed = new Set<Worker>();
  const closes = workers.map((w) =>
    w.close().then(
      () => closed.add(w),
      () => closed.add(w),
    ),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(closes),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, budgetMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  const open = workers.filter((w) => !closed.has(w));
  if (open.length) logger.warn(`${open.length} BullMQ worker(s) still busy after ${budgetMs}ms — exiting; their active jobs stay queued for stalled recovery`);
  return { timedOut: open.length };
}

export const ALL_SCAN_QUEUES = SCAN_QUEUE_NAMES;
