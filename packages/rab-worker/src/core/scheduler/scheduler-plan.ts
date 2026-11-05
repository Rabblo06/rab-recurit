import { resolveScanPrefix } from './queue-registry';
import {
  assertCombinedShiftScanTick,
  isScanJobEnabled,
  IntervalSourceEnvKey,
  resolveIntervalMs,
  resolveShiftScanMode,
  SCAN_JOBS,
  ScanEnableKey,
  ScanJobDefinition,
  schedulerIdOf,
  ShiftScanMode,
} from './scan-jobs';
import { DispatchConfig, dispatchIntervalOf, resolveDispatchConfig } from '../wake/dispatch-config';

/**
 * O3 C2 (owner decision 2026-11-05, "exactly like Twenty"): the ONE place that turns the validated configuration into the
 * scan schedule — which scans are enabled, each scan's interval and the scan queues' Redis prefix. Used by BOTH:
 *   - the Worker (main.ts), which consumes the scan queues (and, in development and test, still registers them itself);
 *   - the API's one-shot registration command (register-schedulers.ts, run by api-prestart.sh before main.js), which
 *     upserts every enabled scan's BullMQ job scheduler under its fixed id `crewflow:<queue>:<jobName>`.
 * Same inputs → same schedule, so the API registers exactly the cadences the Worker used to register (Phase D included:
 * event mode's backstop interval for the four dispatch scans, the combined shift scan and its 30-s floor, the enable
 * switches). Pure apart from reading `env`; throws on any invalid value (fail closed, nothing scheduled).
 */
export type SchedulerPlanEnv = { get(key: string): unknown };

export interface SchedulerPlan {
  /** EVERY scan (enabled or not): a disabled scan's scheduler is removed by a registering reconcile. */
  jobs: readonly ScanJobDefinition[];
  intervalOf: (def: ScanJobDefinition) => number;
  isEnabled: (def: ScanJobDefinition) => boolean;
  /** The scan queues' Redis prefix (`crewflow:<NODE_ENV>:bull` unless BULLMQ_PREFIX). */
  prefix: string;
  dispatchConfig: DispatchConfig;
  shiftScanMode: ShiftScanMode;
}

export function buildSchedulerPlan(env: SchedulerPlanEnv, dispatchConfig: DispatchConfig = resolveDispatchConfig(env)): SchedulerPlan {
  // event mode: the four dispatch scans tick at WORKER_DISPATCH_BACKSTOP_SECONDS (the backstop); every other interval as before.
  const intervalOf = (def: ScanJobDefinition) => dispatchIntervalOf(def, resolveIntervalMs(def, env as { get(key: IntervalSourceEnvKey): number }), dispatchConfig);
  // Phase A pa-intervals: push-dispatch only with PUSH_ENABLED=true, realtime-outbox-publish only with REALTIME_ENABLED=true.
  const isEnabled = (def: ScanJobDefinition) => isScanJobEnabled(def, env as { get(key: ScanEnableKey | 'WORKER_SHIFT_SCAN_MODE'): unknown });
  // Fail closed before anything is scheduled: every scan interval must resolve (validated env + bounds).
  for (const def of SCAN_JOBS) intervalOf(def);
  // Phase D-Q4a: an unknown WORKER_SHIFT_SCAN_MODE, or combined mode with a common tick under 30 s, refuses.
  const shiftScanMode = resolveShiftScanMode(env as { get(key: 'WORKER_SHIFT_SCAN_MODE'): unknown });
  if (shiftScanMode === 'combined') {
    const combined = SCAN_JOBS.find((d) => d.interval.kind === 'combined-shift-scan');
    if (!combined) throw new Error('the combined shift scan is not in SCAN_JOBS');
    assertCombinedShiftScanTick(intervalOf(combined));
  }
  const nodeEnv = env.get('NODE_ENV');
  const configuredPrefix = env.get('BULLMQ_PREFIX');
  const prefix = resolveScanPrefix(typeof nodeEnv === 'string' ? nodeEnv : 'development', typeof configuredPrefix === 'string' ? configuredPrefix : undefined);
  return { jobs: SCAN_JOBS, intervalOf, isEnabled, prefix, dispatchConfig, shiftScanMode };
}

/** The fixed scheduler ids of every ENABLED scan under `plan` (what the API registers and the consume-only Worker expects). */
export function enabledSchedulerIds(plan: Pick<SchedulerPlan, 'jobs' | 'isEnabled'>): string[] {
  return plan.jobs.filter((def) => plan.isEnabled(def)).map(schedulerIdOf);
}

/**
 * O3 C2: what THIS Worker does with the scan schedule — re-checked here, fail closed, behind env.validation.ts (defence in
 * depth, like every other Worker switch):
 *   - `interval`  every enabled scan on this process's own timer. Development and test only; refused in production.
 *   - `register`  bullmq, this Worker registers the schedulers itself (DISABLE_CRON_JOBS_REGISTRATION unset/false): today's
 *                 behaviour, kept for development bullmq trials.
 *   - `consume`   bullmq with DISABLE_CRON_JOBS_REGISTRATION=true (production): the Worker NEVER upserts or removes a
 *                 scheduler and never starts an interval timer; the API registers them at start-up.
 * DISABLE_CRON_JOBS_REGISTRATION=true with interval refuses (nothing would ever be scheduled).
 */
export type WorkerSchedulerRole = 'interval' | 'register' | 'consume';

export class SchedulerRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerRoleError';
  }
}

export function resolveWorkerSchedulerRole(env: SchedulerPlanEnv): WorkerSchedulerRole {
  const production = env.get('NODE_ENV') === 'production';
  const raw = env.get('WORKER_SCHEDULER');
  const mode = raw === undefined || raw === null || raw === '' ? (production ? 'bullmq' : 'interval') : raw;
  if (mode !== 'interval' && mode !== 'bullmq') throw new SchedulerRoleError('WORKER_SCHEDULER must be exactly interval or bullmq');
  const disable = env.get('DISABLE_CRON_JOBS_REGISTRATION');
  if (disable !== undefined && disable !== null && disable !== '' && disable !== true && disable !== false && disable !== 'true' && disable !== 'false') {
    throw new SchedulerRoleError('DISABLE_CRON_JOBS_REGISTRATION must be exactly true or false');
  }
  const consumeOnly = disable === true || disable === 'true';
  if (mode === 'interval') {
    if (production) throw new SchedulerRoleError('WORKER_SCHEDULER=interval is not the production path: production uses bullmq (the API registers the job schedulers, the Worker consumes them)');
    if (consumeOnly) throw new SchedulerRoleError('DISABLE_CRON_JOBS_REGISTRATION=true requires WORKER_SCHEDULER=bullmq (with interval timers nothing would be scheduled)');
    return 'interval';
  }
  return consumeOnly ? 'consume' : 'register';
}
