import { Queue } from 'bullmq';
import type Redis from 'ioredis';

import { SCAN_JOB_DATA, SCAN_JOB_OPTIONS, ScanQueueName } from './queue-registry';
import { crewflowSchedulerPrefixOf, ScanJobDefinition, schedulerIdOf } from './scan-jobs';

/**
 * Crewflow job-scheduler lifecycle for `WORKER_SCHEDULER=bullmq` (Lane A M4).
 *
 *  - IDEMPOTENT and replica-safe: `upsertJobScheduler` is one atomic Lua script (bullmq 5.81.3
 *    commands/addJobScheduler-11.lua). Re-upserting an existing scheduler with the same `every` removes its pending
 *    next job and re-adds it at the SAME timestamp, so N replicas upserting at once still leave exactly one scheduler and
 *    one pending job per id, and a restart does not re-run a 24 h scan. Only a brand-new (or lost) scheduler runs
 *    immediately.
 *  - PERIODIC re-reconcile (WORKER_SCHEDULER_RECONCILE_SECONDS, default 60 s): schedulers live only in Redis; a Redis
 *    restart without AOF (dev) or a flush deletes them and nothing would recreate them until the next deploy. Each
 *    reconcile re-upserts every registered scheduler, which also repairs a scheduler whose next job was lost.
 *  - OWNERSHIP: it only ever touches the registered scan queues under the Crewflow scan prefix, and on those it removes
 *    only ids that start with `crewflow:<queue>:` and are no longer registered (stale). Any other scheduler on those
 *    queues ("foreign") is left alone. It never touches rab-email / rab-push / rab-shift-statements.
 *  - NEVER removes schedulers on shutdown (a rolling deploy must not leave a gap); rollback removal is an explicit
 *    operator command (tools/remove-crewflow-schedulers.ts).
 */
export interface ReconcileReport {
  upserted: string[];
  removedStale: string[];
  foreignUntouched: string[];
}

export interface SchedulerManagerOptions {
  connection: Redis;
  prefix: string;
  jobs: readonly ScanJobDefinition[];
  intervalOf: (def: ScanJobDefinition) => number;
  logger: { log(message: string): void; warn(message: string): void };
}

export class CrewflowSchedulerManager {
  private readonly queues = new Map<ScanQueueName, Queue>();
  private timer: NodeJS.Timeout | null = null;
  private reconciling: Promise<ReconcileReport> | null = null;
  private stopped = false;

  constructor(private readonly options: SchedulerManagerOptions) {
    let lastWarn = -Infinity;
    const onError = (error: Error) => {
      // Reconnect attempts during a Redis outage re-emit here; the next reconcile reports the real outcome.
      if (Date.now() - lastWarn < 60_000) return;
      lastWarn = Date.now();
      options.logger.warn(`scheduler queue connection error: ${error.message}`);
    };
    for (const def of options.jobs) {
      if (this.queues.has(def.queue)) continue;
      const queue = new Queue(def.queue, { connection: options.connection, prefix: options.prefix });
      queue.on('error', onError);
      this.queues.set(def.queue, queue);
    }
  }

  queue(name: ScanQueueName): Queue {
    const q = this.queues.get(name);
    if (!q) throw new Error(`scan queue ${name} is not managed`);
    return q;
  }

  /** One reconcile pass. Concurrent calls share the in-flight pass. Throws on a Redis failure (caller counts it). */
  reconcile(): Promise<ReconcileReport> {
    this.reconciling ??= this.reconcileOnce().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = { upserted: [], removedStale: [], foreignUntouched: [] };
    const desired = new Map(this.options.jobs.map((d) => [schedulerIdOf(d), d]));
    for (const [name, queue] of this.queues) {
      const ownPrefix = crewflowSchedulerPrefixOf(name);
      for (const existing of await queue.getJobSchedulers(0, -1, true)) {
        const id = existing.key;
        if (!id.startsWith(ownPrefix)) {
          report.foreignUntouched.push(`${name}/${id}`);
          continue;
        }
        if (!desired.has(id)) {
          await queue.removeJobScheduler(id);
          report.removedStale.push(id);
        }
      }
    }
    for (const [id, def] of desired) {
      await this.queue(def.queue).upsertJobScheduler(
        id,
        { every: this.options.intervalOf(def) },
        { name: def.jobName, data: { ...SCAN_JOB_DATA }, opts: { ...SCAN_JOB_OPTIONS } },
      );
      report.upserted.push(id);
    }
    if (report.removedStale.length) this.options.logger.warn(`scheduler reconcile removed stale Crewflow schedulers: ${report.removedStale.join(', ')}`);
    return report;
  }

  /** Starts the periodic reconcile. `onResult` sees every pass (success or failure); a failure never throws here. */
  startPeriodic(periodMs: number, onResult: (outcome: { ok: true; report: ReconcileReport } | { ok: false; error: Error }) => void): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      if (this.stopped) return;
      this.reconcile().then(
        (report) => onResult({ ok: true, report }),
        (error: Error) => onResult({ ok: false, error }),
      );
    }, periodMs);
    this.timer.unref?.();
  }

  /** Stops the periodic reconcile. Deliberately does NOT remove any scheduler. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async close(): Promise<void> {
    this.stop();
    await this.reconciling?.catch(() => undefined);
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}

/**
 * Operator rollback helper (owner decision D5 = explicit command, never automatic): removes the Crewflow-owned
 * schedulers (and only those) from the scan queues. Pending scan jobs are inert without a bullmq-mode consumer (a job
 * scheduler only creates its next job when the current one starts), so this is housekeeping, not a correctness step.
 */
export async function removeCrewflowSchedulers(connection: Redis, prefix: string, queues: readonly ScanQueueName[]): Promise<string[]> {
  const removed: string[] = [];
  for (const name of queues) {
    const queue = new Queue(name, { connection, prefix });
    try {
      for (const existing of await queue.getJobSchedulers(0, -1, true)) {
        if (existing.key.startsWith(crewflowSchedulerPrefixOf(name))) {
          await queue.removeJobScheduler(existing.key);
          removed.push(existing.key);
        }
      }
    } finally {
      await queue.close();
    }
  }
  return removed;
}
