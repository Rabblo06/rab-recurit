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
 *    queues ("foreign") is left alone. It never touches rab-email / rab-push / rab-shift-statements. Phase A: a
 *    registered scan whose enable predicate is false is treated like a stale one (removed, plus its waiting job).
 *  - NEVER removes schedulers on shutdown (a rolling deploy must not leave a gap); rollback removal is an explicit
 *    operator command (tools/remove-crewflow-schedulers.ts).
 */
export interface ReconcileReport {
  upserted: string[];
  removedStale: string[];
  foreignUntouched: string[];
  /** Phase A: registered scans whose enable predicate is false — their scheduler was removed by this pass. */
  removedDisabled: string[];
  /** Phase A: registered scans skipped because they are disabled (whether or not a scheduler existed). */
  disabled: string[];
  /** Phase A: `<id> <oldMs>→<newMs>` for every scheduler whose interval this pass changed (same id, updated in place). */
  intervalChanged: string[];
}

export interface SchedulerManagerOptions {
  connection: Redis;
  prefix: string;
  /** EVERY registered scan (enabled or not): their queues are managed so a disabled scan's scheduler can be removed. */
  jobs: readonly ScanJobDefinition[];
  intervalOf: (def: ScanJobDefinition) => number;
  /** Phase A enable predicate (default: every job enabled — the pre-Phase-A behaviour). */
  isEnabled?: (def: ScanJobDefinition) => boolean;
  logger: { log(message: string): void; warn(message: string): void };
  /** Test seam for `firstRunAfterInterval`'s start date. */
  now?: () => number;
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

  /**
   * One pass. Phase A additions:
   *  - DISABLED scans (enable predicate false): their Crewflow scheduler is removed (BullMQ deletes its delayed next job)
   *    and any already-due job it left waiting is removed too, so the scan stops firing; re-enabling re-upserts it.
   *  - INTERVAL CHANGE: the SAME scheduler id is upserted with the new `every` (one atomic Lua script — never a second
   *    scheduler). The existing pending next-run time is passed as `startDate`, so the change takes effect after that run
   *    instead of firing an extra immediate run (which also means two replicas briefly disagreeing during a rolling
   *    deploy re-time each other's cadence but never cause extra runs of e.g. a 24 h sweep).
   *  - `firstRunAfterInterval` (default off): a brand-new scheduler's first job is due one interval from now.
   * For an unchanged interval the upsert is behaviourally identical to before: BullMQ keeps the existing next run (the
   * `startDate` it is handed is only consulted when the stored `every` differs), so a reconcile never re-triggers a scan.
   */
  private async reconcileOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = { upserted: [], removedStale: [], foreignUntouched: [], removedDisabled: [], disabled: [], intervalChanged: [] };
    const isEnabled = this.options.isEnabled ?? (() => true);
    const known = new Map(this.options.jobs.map((d) => [schedulerIdOf(d), d]));
    const desired = new Map<string, ScanJobDefinition>();
    for (const [id, def] of known) {
      if (isEnabled(def)) desired.set(id, def);
      else report.disabled.push(id);
    }
    const existingById = new Map<string, { every?: number; next?: number }>();
    for (const [name, queue] of this.queues) {
      const ownPrefix = crewflowSchedulerPrefixOf(name);
      for (const existing of await queue.getJobSchedulers(0, -1, true)) {
        const id = existing.key;
        if (!id.startsWith(ownPrefix)) {
          report.foreignUntouched.push(`${name}/${id}`);
          continue;
        }
        if (desired.has(id)) {
          existingById.set(id, { every: toNumber(existing.every), next: toNumber(existing.next) });
        } else if (known.get(id)?.queue === name) {
          await queue.removeJobScheduler(id);
          await removePendingJobsOf(queue, id);
          report.removedDisabled.push(id);
        } else {
          await queue.removeJobScheduler(id);
          report.removedStale.push(id);
        }
      }
    }
    const now = this.options.now ?? Date.now;
    for (const [id, def] of desired) {
      const every = this.options.intervalOf(def);
      const previous = existingById.get(id);
      const repeat: { every: number; startDate?: number } = { every };
      if (previous) {
        // Inert while BullMQ sees the same `every` (it keeps the scheduler's own next run); used only when the stored
        // `every` differs — including a change another replica made between this pass's listing and this upsert.
        if (previous.next !== undefined) repeat.startDate = previous.next;
        if (previous.every !== undefined && previous.every !== every) report.intervalChanged.push(`${id} ${previous.every}→${every}`);
      } else if (def.firstRunAfterInterval) {
        repeat.startDate = now() + every;
      }
      await this.queue(def.queue).upsertJobScheduler(id, repeat, { name: def.jobName, data: { ...SCAN_JOB_DATA }, opts: { ...SCAN_JOB_OPTIONS } });
      report.upserted.push(id);
    }
    if (report.removedStale.length) this.options.logger.warn(`scheduler reconcile removed stale Crewflow schedulers: ${report.removedStale.join(', ')}`);
    if (report.removedDisabled.length) this.options.logger.log(`scheduler reconcile removed disabled Crewflow schedulers: ${report.removedDisabled.join(', ')}`);
    if (report.intervalChanged.length) this.options.logger.log(`scheduler reconcile changed intervals (ms): ${report.intervalChanged.join(', ')}`);
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

function toNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Removes the not-yet-started jobs a just-removed scheduler left behind (BullMQ's removeJobScheduler deletes only its
 * DELAYED next job; a job already moved to wait/prioritized would otherwise still run once). Best effort: a job that
 * starts meanwhile cannot be removed and simply runs (or is skipped by the consumer's enable check).
 */
async function removePendingJobsOf(queue: Queue, schedulerId: string): Promise<void> {
  const prefix = `repeat:${schedulerId}:`;
  for (const job of await queue.getJobs(['wait', 'paused', 'prioritized', 'delayed'])) {
    if (job && (job.repeatJobKey === schedulerId || String(job.id).startsWith(prefix))) await job.remove().catch(() => undefined);
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
