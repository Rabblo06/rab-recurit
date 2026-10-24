import { Logger } from '@nestjs/common';
import * as os from 'node:os';
import Redis from 'ioredis';

import { WORKER_STATS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { CycleMetrics, CycleOutcome } from './cycle-metrics';

export type { CycleOutcome } from './cycle-metrics';

/** Handed to every cycle. `setStat` adds an extra field to this runtime's stats hash (e.g. outbox retention's mode/rows). */
export interface CycleContext {
  setStat(field: string, value: string | number): void;
}

export interface WorkerLoopOptions {
  /** Human name used in logs. */
  name: string;
  intervalMs: number;
  /**
   * Stats keys written to the stats hash (names are part of the existing Health contract — do not rename). `skipped` is
   * only ever written by the BullMQ scheduler path (a scan another replica — or this one — was already running).
   */
  statKeys: { lastRunAt: string; failures: string; skipped?: string };
  /** Stable machine key for duration metrics (defaults to `name`). */
  metricKey?: string;
  /** One cycle. Return `false` to NOT record `lastRunAt` (e.g. email dispatch only stamps when it actually claimed rows). */
  run: (ctx: CycleContext) => Promise<boolean | void>;
}

/** Per-instance progress snapshot (see `progress()`): process-local, never written to Redis. */
export interface WorkerRuntimeProgress {
  startedAt: number;
  /** When any periodic cycle last finished, successfully or not. Null until the first one finishes. */
  lastCycleSettledAt: number | null;
  /** When any periodic cycle last finished without throwing. */
  lastCycleSucceededAt: number | null;
  inFlight: number;
  /** The longest-running in-flight cycle, if any — a hung cycle shows up here while other loops keep settling. */
  oldestInFlight: { name: string; startedAt: number } | null;
  shuttingDown: boolean;
  /**
   * BullMQ mode only (absent in interval mode, so the interval-mode heartbeat file is unchanged): the scheduler mode,
   * when this instance's BullMQ consumers were last confirmed running, and when its last scheduler reconcile succeeded.
   * The bundle health check uses these instead of "a cycle finished recently", because an idle replica may legitimately
   * win no scan job for minutes.
   */
  mode?: 'bullmq';
  consumersReadyAt?: number | null;
  reconcileOkAt?: number | null;
}

export interface WorkerRuntimeOptions {
  /** Hash the full stats object (or, in `fields` mode, the changed fields) is written to. Default `rab:worker:stats`. */
  statsKey?: string;
  /**
   * `whole` (default — the interval-mode behaviour, unchanged): every settle HSETs the whole in-memory stats object.
   * `fields` (BullMQ mode): every settle writes ONLY the fields that cycle changed — HSET lastRunAt (+ startedAt), HINCRBY
   * failures/skipped — so replicas that take turns running scans never overwrite each other's fresher timestamps.
   */
  statsWrite?: 'whole' | 'fields';
  /**
   * Mirror ONLY each loop's own lastRunAt/failures fields (never `startedAt`) into this second hash. The provisioner uses it
   * to keep writing `lastWorkspaceProvisioningAt` & co. into `rab:worker:stats` for existing readers (E2E 5.3, Admin queue
   * health) while its own full stats — including ITS `startedAt` — live in its own hash (owner-approved fix: the provisioner
   * no longer overwrites the jobs process's `startedAt`).
   */
  mirrorKey?: string;
  /** Hash the per-loop duration summary is written to (M1). Unset → metrics are kept and logged, never written. */
  durationsKey?: string;
  /** How often dirty duration summaries are written to `durationsKey` (default 60 s). */
  metricsFlushMs?: number;
  /** How often the duration summary is logged (default 15 min). 0 disables. */
  metricsLogMs?: number;
  /** TTL of `durationsKey` (refreshed on each write). Default 7 days. */
  durationsTtlSeconds?: number;
}

const SKIPPED: ReadonlySet<CycleOutcome> = new Set(['skipped-running', 'skipped-locked', 'skipped-shutdown']);

/** The lock wrapper a scheduler passes to `runOnce` (the per-scan advisory lock). `acquired: false` → skipped-locked. */
export type CycleLockWrapper = <T>(work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;

/**
 * Lifecycle for the worker's periodic loops: guarantees a loop never
 * overlaps itself, tracks every in-flight cycle, and lets shutdown stop
 * scheduling new work and then WAIT for what is already running (a
 * half-rendered PDF, a mid-flight email claim) instead of `process.exit`-ing
 * underneath it.
 *
 * Why non-overlap matters: several jobs are heavy (a Playwright render is
 * seconds). If a cycle outlasted its interval a second cycle would start on
 * top of it — harmless for correctness (per-resource advisory locks + CAS),
 * but it multiplies Chromium/DB-connection load exactly when the system is
 * already slow.
 *
 * Two drivers share ONE execution path (`execute`): `every()` (interval mode — a process-local timer per loop, exactly as
 * before) and `runOnce()` (BullMQ mode — called by a scan-queue processor when the cluster-wide job scheduler hands this
 * replica a job). Same overlap guard, same stats contract, same duration metrics, same in-flight tracking for shutdown.
 */
export class WorkerRuntime {
  private readonly logger = new Logger('WorkerRuntime');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<Promise<CycleOutcome>>();
  private readonly running = new Set<string>();
  private shuttingDown = false;
  readonly stats: Record<string, string | number> = { startedAt: Date.now() };
  readonly metrics = new CycleMetrics();
  // Per-instance progress (Worker bundle health, packages/rab-docker/rab/worker-bundle-health.cjs). The Redis keys above
  // are global — another healthy replica refreshes them too — so they cannot show that THIS process is still making
  // progress. Additive and process-local: nothing here is written to Redis or changes any existing contract.
  private lastCycleSettledAt: number | null = null;
  private lastCycleSucceededAt: number | null = null;
  private readonly inFlightStartedAt = new Map<Promise<CycleOutcome>, { name: string; startedAt: number }>();
  private bullmq: { consumersReadyAt: number | null; reconcileOkAt: number | null } | null = null;
  private readonly statsKey: string;
  private readonly statsWrite: 'whole' | 'fields';
  private readonly instance = `${os.hostname()}:${process.pid}`;

  constructor(
    private readonly redis: Redis,
    private readonly options: WorkerRuntimeOptions = {},
  ) {
    this.statsKey = options.statsKey ?? WORKER_STATS_KEY;
    this.statsWrite = options.statsWrite ?? 'whole';
    const flushMs = options.metricsFlushMs ?? 60_000;
    if (options.durationsKey && flushMs > 0) this.untracked(() => this.flushMetrics(), flushMs);
    const logMs = options.metricsLogMs ?? 15 * 60_000;
    if (logMs > 0) this.untracked(() => this.logMetrics(), logMs);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** BullMQ mode: switches the progress snapshot to the scheduler-aware health contract (see WorkerRuntimeProgress). */
  enableSchedulerProgress(): void {
    this.bullmq ??= { consumersReadyAt: null, reconcileOkAt: null };
  }

  markConsumersReady(at = Date.now()): void {
    if (this.bullmq) this.bullmq.consumersReadyAt = at;
  }

  markReconcileOk(at = Date.now()): void {
    if (this.bullmq) this.bullmq.reconcileOkAt = at;
  }

  progress(): WorkerRuntimeProgress {
    let oldestInFlight: { name: string; startedAt: number } | null = null;
    for (const entry of this.inFlightStartedAt.values()) {
      if (!oldestInFlight || entry.startedAt < oldestInFlight.startedAt) oldestInFlight = entry;
    }
    const base: WorkerRuntimeProgress = {
      startedAt: Number(this.stats.startedAt),
      lastCycleSettledAt: this.lastCycleSettledAt,
      lastCycleSucceededAt: this.lastCycleSucceededAt,
      inFlight: this.inFlight.size,
      oldestInFlight: oldestInFlight ? { ...oldestInFlight } : null,
      shuttingDown: this.shuttingDown,
    };
    if (!this.bullmq) return base;
    return { ...base, mode: 'bullmq', consumersReadyAt: this.bullmq.consumersReadyAt, reconcileOkAt: this.bullmq.reconcileOkAt };
  }

  /** Whole-object write — the interval-mode contract (unchanged). */
  writeStats(): void {
    this.redis.hset(this.statsKey, this.stats).catch(() => {
      // Best-effort — see WORKER_HEARTBEAT_KEY's own doc comment on why this never blocks a job cycle.
    });
  }

  private writeChanged(set: Record<string, string | number>, increment?: string): void {
    if (this.statsWrite === 'whole') {
      this.writeStats();
    } else {
      const multi = this.redis.multi();
      if (Object.keys(set).length) multi.hset(this.statsKey, { ...set, startedAt: this.stats.startedAt });
      if (increment) multi.hincrby(this.statsKey, increment, 1);
      multi.exec().catch(() => undefined);
    }
    if (this.options.mirrorKey) {
      // Only the loop's own fields — never startedAt (that was the collision this mirror exists to remove).
      const mirror = this.redis.multi();
      if (Object.keys(set).length) mirror.hset(this.options.mirrorKey, set);
      if (increment) mirror.hset(this.options.mirrorKey, increment, this.stats[increment] ?? 0);
      mirror.exec().catch(() => undefined);
    }
  }

  /**
   * The ONE execution path. Never throws: a failed cycle is counted, logged and reported as `failed`.
   * `lock` (BullMQ mode) wraps the run in the per-scan advisory lock; `acquired: false` → `skipped-locked`, no stamp.
   */
  private execute(options: WorkerLoopOptions, lock?: CycleLockWrapper): Promise<CycleOutcome> {
    const key = options.metricKey ?? options.name;
    this.running.add(options.name);
    const startedAt = Date.now();
    const extra: Record<string, string | number> = {};
    const ctx: CycleContext = {
      setStat: (field, value) => {
        this.stats[field] = value;
        extra[field] = value;
      },
    };
    const work = async (): Promise<CycleOutcome> => {
      if (!lock) return (await options.run(ctx)) === false ? 'idle' : 'succeeded';
      const locked = await lock(() => options.run(ctx));
      if (!locked.acquired) return 'skipped-locked';
      return locked.value === false ? 'idle' : 'succeeded';
    };
    const cycle: Promise<CycleOutcome> = work()
      .then((outcome) => {
        if (outcome === 'skipped-locked') {
          if (options.statKeys.skipped) {
            this.stats[options.statKeys.skipped] = Number(this.stats[options.statKeys.skipped] ?? 0) + 1;
            this.writeChanged({}, options.statKeys.skipped);
          }
          this.metrics.record(key, outcome);
          return outcome;
        }
        const set: Record<string, string | number> = { ...extra };
        if (outcome === 'succeeded') {
          this.stats[options.statKeys.lastRunAt] = Date.now();
          set[options.statKeys.lastRunAt] = this.stats[options.statKeys.lastRunAt]!;
        }
        this.lastCycleSucceededAt = Date.now();
        this.writeChanged(set);
        this.metrics.record(key, outcome, Date.now() - startedAt);
        return outcome;
      })
      .catch((error): CycleOutcome => {
        this.stats[options.statKeys.failures] = Number(this.stats[options.statKeys.failures] ?? 0) + 1;
        this.writeChanged({ ...extra }, options.statKeys.failures);
        this.logger.error(`${options.name} cycle failed`, error as Error);
        this.metrics.record(key, 'failed', Date.now() - startedAt);
        return 'failed';
      })
      .finally(() => {
        this.running.delete(options.name);
        this.lastCycleSettledAt = Date.now();
        this.inFlight.delete(cycle);
        this.inFlightStartedAt.delete(cycle);
      });
    this.inFlight.add(cycle);
    this.inFlightStartedAt.set(cycle, { name: options.name, startedAt });
    return cycle;
  }

  /** Runs the cycle once immediately, then on `intervalMs` (interval mode). */
  every(options: WorkerLoopOptions): void {
    const tick = () => {
      if (this.shuttingDown) return;
      if (this.running.has(options.name)) {
        this.logger.warn(`${options.name}: previous cycle still running — skipping this tick`);
        return;
      }
      void this.execute(options);
    };
    tick();
    this.timers.push(setInterval(tick, options.intervalMs));
  }

  /**
   * BullMQ mode: one scheduled job → one cycle on this replica. Same overlap guard as `every()` (a second job for a scan
   * this process is already running is skipped, counted, never stacked), plus the cross-replica `lock`.
   */
  async runOnce(options: WorkerLoopOptions, lock?: CycleLockWrapper): Promise<CycleOutcome> {
    const key = options.metricKey ?? options.name;
    if (this.shuttingDown) {
      this.metrics.record(key, 'skipped-shutdown');
      return 'skipped-shutdown';
    }
    if (this.running.has(options.name)) {
      this.logger.warn(`${options.name}: previous cycle still running on this instance — skipping this job`);
      if (options.statKeys.skipped) {
        this.stats[options.statKeys.skipped] = Number(this.stats[options.statKeys.skipped] ?? 0) + 1;
        this.writeChanged({}, options.statKeys.skipped);
      }
      this.metrics.record(key, 'skipped-running');
      return 'skipped-running';
    }
    return this.execute(options, lock);
  }

  /** Plain interval (heartbeat) — not tracked as a cycle, never blocks shutdown. */
  interval(fn: () => void, intervalMs: number): void {
    this.timers.push(setInterval(fn, intervalMs));
  }

  private untracked(fn: () => void, intervalMs: number): void {
    const timer = setInterval(fn, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** Writes dirty per-loop duration summaries to `durationsKey`. Best-effort, never throws. */
  flushMetrics(): Promise<void> {
    if (!this.options.durationsKey) return Promise.resolve();
    const dirty = this.metrics.takeDirty();
    if (!dirty.length) return Promise.resolve();
    const fields = Object.fromEntries(dirty.map(([k, s]) => [k, JSON.stringify({ ...s, at: Date.now(), instance: this.instance })]));
    return this.redis
      .multi()
      .hset(this.options.durationsKey, fields)
      .expire(this.options.durationsKey, this.options.durationsTtlSeconds ?? 7 * 24 * 60 * 60)
      .exec()
      .then(() => undefined, () => undefined);
  }

  /** One log line per loop that ran: window size, p50/p95/p99/max (ms) and cumulative outcome counters. */
  logMetrics(): void {
    for (const key of this.metrics.keys()) {
      const s = this.metrics.summary(key);
      if (!s || (s.n === 0 && s.skipped === 0)) continue;
      this.logger.log(
        `cycle durations ${key}: n=${s.n} p50=${s.p50 ?? '-'}ms p95=${s.p95 ?? '-'}ms p99=${s.p99 ?? '-'}ms max=${s.max ?? '-'}ms ` +
          `ok=${s.succeeded} idle=${s.idle} failed=${s.failed} skipped=${s.skipped}`,
      );
    }
  }

  /** True while a cycle with this name is running in this process. */
  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /** Stop scheduling: no new cycle can start after this returns. */
  beginShutdown(): void {
    this.shuttingDown = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  /** Waits for in-flight cycles; resolves `drained: false` (never throws) if `timeoutMs` elapses first. */
  async drain(timeoutMs: number): Promise<{ drained: boolean; pending: number }> {
    if (this.inFlight.size === 0) return { drained: true, pending: 0 };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
    });
    const all = Promise.allSettled([...this.inFlight]).then(() => 'done' as const);
    const outcome = await Promise.race([all, timeout]);
    if (timer) clearTimeout(timer);
    return outcome === 'done' ? { drained: true, pending: 0 } : { drained: false, pending: this.inFlight.size };
  }
}

export const isSkippedOutcome = (outcome: CycleOutcome): boolean => SKIPPED.has(outcome);
