/**
 * XR-10 (Phase X2.5): the Worker's SIGTERM drain budget, `WORKER_SHUTDOWN_TIMEOUT_MS`.
 *
 * On SIGTERM the Worker stops scheduling, lets every BullMQ Worker finish its active job and waits for in-flight cycles
 * for at most this long (rab-worker/src/main.ts `shutdown`). A hard-exit timer fires `WORKER_SHUTDOWN_HARD_EXIT_MARGIN_MS`
 * later in case the close steps after the drain hang. Every compose file gives the Worker `stop_grace_period: 45s`; after
 * that Docker sends SIGKILL, which kills a job mid-drain. So the whole shutdown, drain plus margin, must end before 45 s:
 *
 *   WORKER_SHUTDOWN_TIMEOUT_MS + 10 000 ms  <  45 000 ms   →   at most 34 000 ms (one second spare for the exit itself).
 *
 * Before this contract the value was read with `Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 30000)` at shutdown and
 * validated nowhere: garbage became `NaN`, so the hard-exit timer fired at once and the Worker exited 1 without draining;
 * a value above 35 000 outlived the grace period and the Worker was SIGKILLed mid-drain.
 *
 * Rule (fail closed, checked at boot by env validation for both processes and again by the Worker before it is ready):
 * unset or empty → 30 000 (the default is unchanged); a plain decimal integer (no sign, no leading zero, no spaces, no
 * exponent) from 1 000 to 34 000 → that many milliseconds; anything else refuses to boot.
 *
 * Pure constants and functions: no Nest, no Node API, no `modules/` import (shared by env validation and the Worker).
 */

/** The default drain budget, unchanged from before XR-10. */
export const WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT = 30_000;

/** The Worker's hard-exit timer fires this long after the drain budget (rab-worker/src/main.ts). */
export const WORKER_SHUTDOWN_HARD_EXIT_MARGIN_MS = 10_000;

/** `stop_grace_period` of the Worker service in every compose file (docker-compose.production.yml, image.yml, …). */
export const WORKER_STOP_GRACE_PERIOD_MS = 45_000;

/** Bounds of WORKER_SHUTDOWN_TIMEOUT_MS: one second at least (the retired launcher's floor); 34 s at most (above). */
export const WORKER_SHUTDOWN_TIMEOUT_MS_MIN = 1_000;
export const WORKER_SHUTDOWN_TIMEOUT_MS_MAX = WORKER_STOP_GRACE_PERIOD_MS - WORKER_SHUTDOWN_HARD_EXIT_MARGIN_MS - 1_000;

export class WorkerShutdownTimeoutError extends Error {
  override readonly name = 'WorkerShutdownTimeoutError';
}

/**
 * `WORKER_SHUTDOWN_TIMEOUT_MS`: unset or empty → 30 000; a plain decimal integer from 1 000 to 34 000 → that many ms;
 * anything else throws `WorkerShutdownTimeoutError`. The message names the bounds and the reason, never the raw value.
 */
export function parseWorkerShutdownTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT;
  const value = typeof raw === 'string' && /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= WORKER_SHUTDOWN_TIMEOUT_MS_MIN && value <= WORKER_SHUTDOWN_TIMEOUT_MS_MAX)) {
    throw new WorkerShutdownTimeoutError(
      `WORKER_SHUTDOWN_TIMEOUT_MS must be an integer number of milliseconds from ${WORKER_SHUTDOWN_TIMEOUT_MS_MIN} to ` +
        `${WORKER_SHUTDOWN_TIMEOUT_MS_MAX} (the drain plus the ${WORKER_SHUTDOWN_HARD_EXIT_MARGIN_MS} ms hard-exit margin ` +
        `must end inside the Worker's ${WORKER_STOP_GRACE_PERIOD_MS / 1000} s stop_grace_period); unset means ` +
        `${WORKER_SHUTDOWN_TIMEOUT_MS_DEFAULT}`,
    );
  }
  return value;
}
