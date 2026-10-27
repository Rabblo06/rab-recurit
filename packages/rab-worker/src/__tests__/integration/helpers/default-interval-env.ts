import { WORKER_SCAN_INTERVAL_SETTINGS } from '@rab/server/engine/core-modules/environment/worker-scan-intervals';

/**
 * Phase A pa-intervals: an `EnvironmentService`-shaped stub holding every scan-interval setting at its real default
 * (the 17 `WORKER_<JOB>_INTERVAL_SECONDS` keys from worker-scan-intervals.ts + the three pre-existing minutes keys at
 * their environment-variables.ts defaults 15 / 60 / 60). `overrides` replaces individual keys. Unknown keys read as
 * undefined, so resolveIntervalMs fails closed on anything not provided here.
 */
export function defaultIntervalEnv(overrides: Record<string, number | boolean | string | undefined> = {}): { get: (key: string) => never } {
  const values: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(WORKER_SCAN_INTERVAL_SETTINGS).map(([key, s]) => [key, s.defaultSeconds])),
    LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES: 15,
    OUTBOX_RETENTION_INTERVAL_MINUTES: 60,
    AI_RETENTION_INTERVAL_MINUTES: 60,
    ...overrides,
  };
  return { get: (key: string) => values[key] as never };
}
