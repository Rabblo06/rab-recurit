import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

import { WORKER_STATS_KEY } from '../heartbeat.constants';
import { DISCOVERY_LOCK_TIMEOUT_MS, isLockUnavailable } from './discovery-lock';

export interface WorkerLoopOptions {
  /** Human name used in logs. */
  name: string;
  intervalMs: number;
  /** Stats keys written to `rab:worker:stats` (names are part of the existing Health contract — do not rename). */
  statKeys: { lastRunAt: string; failures: string };
  /** One cycle. Return `true` to record `lastRunAt` (e.g. email dispatch only stamps when it actually claimed rows). */
  run: () => Promise<boolean | void>;
}

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
 */
export class WorkerRuntime {
  private readonly logger = new Logger('WorkerRuntime');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private shuttingDown = false;
  readonly stats: Record<string, string | number> = { startedAt: Date.now() };

  constructor(private readonly redis: Redis) {}

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  writeStats(): void {
    this.redis.hset(WORKER_STATS_KEY, this.stats).catch(() => {
      // Best-effort — see WORKER_HEARTBEAT_KEY's own doc comment on why this never blocks a job cycle.
    });
  }

  /** Runs the cycle once immediately, then on `intervalMs`. */
  every(options: WorkerLoopOptions): void {
    let running = false;
    const tick = () => {
      if (this.shuttingDown) return;
      if (running) {
        this.logger.warn(`${options.name}: previous cycle still running — skipping this tick`);
        return;
      }
      running = true;
      const cycle: Promise<void> = options
        .run()
        .then((record) => {
          if (record !== false) this.stats[options.statKeys.lastRunAt] = Date.now();
          this.writeStats();
        })
        .catch((error) => {
          if (isLockUnavailable(error)) {
            // The discovery scan yielded to API traffic (see discovery-lock.ts). Not a failure: it retries next tick.
            this.logger.warn(`${options.name}: could not take its table locks within ${DISCOVERY_LOCK_TIMEOUT_MS}ms (API traffic has priority) — retrying next tick`);
            return;
          }
          this.stats[options.statKeys.failures] = Number(this.stats[options.statKeys.failures] ?? 0) + 1;
          this.writeStats();
          this.logger.error(`${options.name} cycle failed`, error as Error);
        })
        .finally(() => {
          running = false;
          this.inFlight.delete(cycle);
        });
      this.inFlight.add(cycle);
    };
    tick();
    this.timers.push(setInterval(tick, options.intervalMs));
  }

  /** Plain interval (heartbeat) — not tracked as a cycle, never blocks shutdown. */
  interval(fn: () => void, intervalMs: number): void {
    this.timers.push(setInterval(fn, intervalMs));
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
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const all = Promise.allSettled([...this.inFlight]).then(() => 'done' as const);
    const outcome = await Promise.race([all, timeout]);
    if (timer) clearTimeout(timer);
    return outcome === 'done' ? { drained: true, pending: 0 } : { drained: false, pending: this.inFlight.size };
  }
}
