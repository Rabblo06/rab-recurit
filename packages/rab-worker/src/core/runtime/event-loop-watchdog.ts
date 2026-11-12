import { Worker } from 'node:worker_threads';

/**
 * Owner-login architecture (M0-D §6, M0 §7 "Worker: new work — a watchdog, replacing the launcher's"): the Worker runs as ONE
 * jobs process with no root launcher. Plain Docker Compose restarts a container only when its process EXITS, so a Worker
 * whose event loop is wedged (a CPU-bound loop, a synchronous call that never returns) would never be restarted. This
 * watchdog runs OFF the main thread (a worker_threads thread, which keeps running while the main event loop is blocked):
 * the main thread stores a timestamp in shared memory on every beat; the thread checks it and, when it is older than the
 * stale limit, writes one line to stderr and SIGKILLs the whole process. The restart policy then starts a fresh one.
 *
 * Only an event-loop STALL kills. A dependency outage (Redis or PostgreSQL down) does not stop the beat, so it can never turn
 * into a restart storm; that is reported by the health check instead (worker-bundle-health.cjs, jobs role).
 *
 * PID 1: the kernel ignores a signal without a handler that is sent to a PID namespace's init — including SIGKILL from
 * inside the container (VERIFIED: node:24-alpine, the kill is ignored as PID 1 and works under `--init`). A watchdog that
 * silently cannot act is worse than none, so `startEventLoopWatchdog` REFUSES to start when this process is PID 1: run the
 * Worker container with `init: true` (docker run --init).
 *
 * The thread receives no environment (`env: {}`), no credential and no data: only the shared timestamp and two numbers.
 */
export const WATCHDOG_STALE_SECONDS_ENV = 'CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS';
export const WATCHDOG_STALE_SECONDS_DEFAULT = 120;
export const WATCHDOG_STALE_SECONDS_MIN = 30;
export const WATCHDOG_STALE_SECONDS_MAX = 900;
/** How often the main thread beats and the thread checks. */
export const WATCHDOG_BEAT_MS = 5_000;

export class WatchdogConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchdogConfigError';
  }
}

/** CREWFLOW_WORKER_WATCHDOG_STALE_SECONDS: whole seconds, 30..900, default 120. Anything else refuses to start. */
export function resolveWatchdogStaleMs(env: Record<string, string | undefined>): number {
  const raw = env[WATCHDOG_STALE_SECONDS_ENV];
  if (raw === undefined || raw === '') return WATCHDOG_STALE_SECONDS_DEFAULT * 1000;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < WATCHDOG_STALE_SECONDS_MIN || n > WATCHDOG_STALE_SECONDS_MAX) {
    throw new WatchdogConfigError(
      `${WATCHDOG_STALE_SECONDS_ENV} must be a whole number of seconds from ${WATCHDOG_STALE_SECONDS_MIN} to ${WATCHDOG_STALE_SECONDS_MAX} (unset = ${WATCHDOG_STALE_SECONDS_DEFAULT}). Refusing to start.`,
    );
  }
  return n * 1000;
}

export interface EventLoopWatchdog {
  /** Stops the thread and the beat (graceful shutdown). */
  stop(): Promise<void>;
}

export interface EventLoopWatchdogOptions {
  staleMs: number;
  beatMs?: number;
  /** For tests only: the pid to treat as this process (PID 1 refusal). */
  pid?: number;
}

/**
 * The thread body, as source text (eval): the compiled bundle needs no separate file, and no transpiler or coverage tool
 * can rewrite it. It references nothing outside itself.
 */
export const WATCHDOG_THREAD_SOURCE = [
  "const { workerData } = require('node:worker_threads');",
  "const fs = require('node:fs');",
  'const last = new BigInt64Array(workerData.sab);',
  'setInterval(() => {',
  '  const age = Date.now() - Number(Atomics.load(last, 0));',
  '  if (age > workerData.staleMs) {',
  "    try { fs.writeSync(2, '[worker-watchdog] the event loop has not beaten for ' + Math.round(age / 1000) + ' s (limit ' + Math.round(workerData.staleMs / 1000) + ' s): killing the Worker so its restart policy starts a fresh one' + String.fromCharCode(10)); } catch (e) { /* stderr unavailable: kill anyway */ }",
  "    process.kill(process.pid, 'SIGKILL');",
  '  }',
  '}, workerData.checkMs);',
].join(String.fromCharCode(10));

export function startEventLoopWatchdog(options: EventLoopWatchdogOptions): EventLoopWatchdog {
  if ((options.pid ?? process.pid) === 1) {
    throw new WatchdogConfigError(
      'The Worker is PID 1 in its container, where the kernel ignores the watchdog\'s SIGKILL: a hung Worker would never be restarted. Run the Worker container with `init: true` (docker run --init). Refusing to start.',
    );
  }
  const beatMs = options.beatMs ?? WATCHDOG_BEAT_MS;
  if (options.staleMs < beatMs * 3) throw new WatchdogConfigError('The watchdog stale limit must be at least three beats. Refusing to start.');
  const sab = new SharedArrayBuffer(8);
  const last = new BigInt64Array(sab);
  const beat = () => Atomics.store(last, 0, BigInt(Date.now()));
  beat();
  const thread = new Worker(WATCHDOG_THREAD_SOURCE, {
    eval: true,
    env: {},
    workerData: { sab, staleMs: options.staleMs, checkMs: Math.min(beatMs, 5_000) },
  });
  thread.unref();
  const timer = setInterval(beat, beatMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await thread.terminate();
    },
  };
}
