import 'reflect-metadata';

import Redis from 'ioredis';

import { validate } from '@rab/server/engine/core-modules/environment/env.validation';
import type { EnvironmentVariables } from '@rab/server/engine/core-modules/environment/environment-variables';
import { assertScanQueueSettings } from './core/scheduler/bullmq-scheduler';
import { assertRedisReadyForBullmq, assertSupportedBullmqApi } from './core/scheduler/redis-preflight';
import { buildSchedulerPlan, SchedulerPlan } from './core/scheduler/scheduler-plan';
import { CrewflowSchedulerManager, ReconcileReport } from './core/scheduler/scheduler-manager';

/**
 * O3 C2 (owner decision 2026-11-05, "exactly like Twenty"): the API registers EVERY scheduled job at start-up. This is the
 * one-shot command api-prestart.sh runs after the migrate step and before it execs main.js (Twenty's entrypoint registers
 * its cron jobs the same way), unless DISABLE_CRON_JOBS_REGISTRATION=true:
 *
 *   node packages/rab-worker/dist/register-schedulers.js
 *
 * It validates the configuration with the SAME validator the API and the Worker use, builds the scan schedule with the
 * SAME plan builder the Worker uses (scheduler-plan.ts: intervals, enable switches, Phase D backstop/combined scan, prefix),
 * runs the bullmq Redis preflight (noeviction, BullMQ API), then ONE `CrewflowSchedulerManager.reconcile()`:
 * `upsertJobScheduler` under the FIXED ids `crewflow:<queue>:<jobName>` (idempotent — a re-run, or several API replicas at
 * once, leave exactly one scheduler and one pending job per id, and keep each scheduler's next run), removal of a disabled
 * scan's scheduler and of stale Crewflow-owned ids; foreign schedulers are never touched. After a Redis restart the next API
 * start re-registers them, with no duplicates.
 *
 * No database connection, no secret printed (never REDIS_URL). Exit codes: 0 registered (or nothing to register:
 * DISABLE_CRON_JOBS_REGISTRATION=true, or WORKER_SCHEDULER=interval outside production); 64 configuration refused; 1 Redis
 * or registration failure. api-prestart.sh treats a non-zero exit as a loud WARNING and starts the API anyway (Twenty's
 * entrypoint does the same); the consume-only Worker's read-only verify then reports the missing ids as an ERROR.
 */
export const REGISTER_SCHEDULERS_EXIT = Object.freeze({ ok: 0, failed: 1, config: 64 } as const);
/** Hard bound on the whole command, so a hung Redis can never hold the API's start. */
export const REGISTER_SCHEDULERS_TIMEOUT_MS = 60_000;

export interface RegistrationLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RegistrationDeps {
  env: Record<string, string | undefined>;
  /** Opens the Redis connection the registration uses (test seam). */
  connect: (redisUrl: string) => Redis;
  logger: RegistrationLogger;
  /** Test seam: the manager (defaults to the real CrewflowSchedulerManager). */
  createManager?: (redis: Redis, plan: SchedulerPlan, logger: RegistrationLogger) => Pick<CrewflowSchedulerManager, 'reconcile' | 'close'>;
  /** Test seam: the Redis preflight (defaults to the real one). */
  preflight?: (redis: Redis, redisUrl: string, logger: RegistrationLogger) => Promise<unknown>;
}

export interface RegistrationOutcome {
  exitCode: number;
  report?: ReconcileReport;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSchedulerRegistration(deps: RegistrationDeps): Promise<RegistrationOutcome> {
  const { logger } = deps;
  let env: EnvironmentVariables;
  let plan: SchedulerPlan;
  try {
    env = validate(deps.env);
  } catch (error) {
    logger.error(`register-schedulers: REFUSED - configuration invalid: ${message(error)}`);
    return { exitCode: REGISTER_SCHEDULERS_EXIT.config };
  }
  if (env.DISABLE_CRON_JOBS_REGISTRATION === true) {
    logger.log('register-schedulers: DISABLE_CRON_JOBS_REGISTRATION=true - nothing registered');
    return { exitCode: REGISTER_SCHEDULERS_EXIT.ok };
  }
  if (env.WORKER_SCHEDULER !== 'bullmq') {
    // Never reached in production (env validation refuses interval there); development keeps per-Worker timers.
    logger.log('register-schedulers: WORKER_SCHEDULER=interval - each Worker runs its own timers; nothing registered');
    return { exitCode: REGISTER_SCHEDULERS_EXIT.ok };
  }
  try {
    plan = buildSchedulerPlan({ get: (key: string) => (env as unknown as Record<string, unknown>)[key] });
    assertScanQueueSettings(plan.jobs);
    assertSupportedBullmqApi();
  } catch (error) {
    logger.error(`register-schedulers: REFUSED - ${message(error)}`);
    return { exitCode: REGISTER_SCHEDULERS_EXIT.config };
  }

  const redisUrl = env.REDIS_URL;
  const redis = deps.connect(redisUrl);
  // Reconnect attempts re-emit errors; the awaited calls below report the real outcome (never the URL).
  redis.on('error', () => undefined);
  let manager: Pick<CrewflowSchedulerManager, 'reconcile' | 'close'> | null = null;
  try {
    await (deps.preflight ?? assertRedisReadyForBullmq)(redis, redisUrl, logger);
    manager = deps.createManager
      ? deps.createManager(redis, plan, logger)
      : new CrewflowSchedulerManager({ connection: redis, prefix: plan.prefix, jobs: plan.jobs, intervalOf: plan.intervalOf, isEnabled: plan.isEnabled, logger });
    const report = await manager.reconcile();
    logger.log(
      `register-schedulers: ${report.upserted.length} Crewflow job scheduler(s) registered under prefix ${plan.prefix}: ${report.upserted.join(', ')}` +
        (report.disabled.length ? `; ${report.disabled.length} disabled (not scheduled): ${report.disabled.join(', ')}` : '') +
        (report.removedDisabled.length ? `; removed disabled: ${report.removedDisabled.join(', ')}` : '') +
        (report.removedStale.length ? `; removed stale: ${report.removedStale.join(', ')}` : '') +
        (report.intervalChanged.length ? `; interval changed (ms): ${report.intervalChanged.join(', ')}` : '') +
        (report.foreignUntouched.length ? `; ${report.foreignUntouched.length} foreign scheduler(s) left untouched` : ''),
    );
    return { exitCode: REGISTER_SCHEDULERS_EXIT.ok, report };
  } catch (error) {
    logger.error(`register-schedulers: FAILED - ${message(error)}`);
    return { exitCode: REGISTER_SCHEDULERS_EXIT.failed };
  } finally {
    await manager?.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}

/** The command: bounded by REGISTER_SCHEDULERS_TIMEOUT_MS, logs to stdout/stderr, exits with the outcome's code. */
async function main(): Promise<void> {
  const timer = setTimeout(() => {
    console.error(`register-schedulers: FAILED - did not finish within ${REGISTER_SCHEDULERS_TIMEOUT_MS / 1000}s`);
    process.exit(REGISTER_SCHEDULERS_EXIT.failed);
  }, REGISTER_SCHEDULERS_TIMEOUT_MS);
  timer.unref();
  const outcome = await runSchedulerRegistration({
    env: process.env,
    // Fail fast: a one-shot command must not retry forever (bounded reconnects, bounded per-command retries).
    connect: (url) => new Redis(url, { maxRetriesPerRequest: 2, connectTimeout: 10_000, retryStrategy: (times) => (times > 3 ? null : 1_000) }),
    logger: {
      log: (m) => console.log(m),
      warn: (m) => console.warn(`register-schedulers: WARNING ${m}`),
      error: (m) => console.error(m),
    },
  });
  clearTimeout(timer);
  process.exit(outcome.exitCode);
}

if (require.main === module) {
  void main();
}
