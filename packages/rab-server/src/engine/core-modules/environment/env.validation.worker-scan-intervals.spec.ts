// Phase A pa-intervals
import { validate } from './env.validation';
import { WORKER_SCAN_INTERVAL_KEYS, WORKER_SCAN_INTERVAL_SETTINGS } from './worker-scan-intervals';

/**
 * Worker scan interval settings: unset ⇒ exactly the historical cadences; every key bounded; anything out of bounds,
 * fractional or non-numeric refuses to boot (fail closed, like every other env key). Pre-existing keys keep their meaning.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

// Hand-written (not read from the settings table): the cadences the Worker used before these keys existed, in seconds.
const HISTORICAL: Record<string, number> = {
  WORKER_ACCOUNT_INVITE_CLEANUP_INTERVAL_SECONDS: 900,
  WORKER_EMAIL_DISPATCH_INTERVAL_SECONDS: 2,
  WORKER_PUSH_DISPATCH_INTERVAL_SECONDS: 2,
  WORKER_SHIFT_MONITOR_INTERVAL_SECONDS: 300,
  WORKER_ATTENDANCE_MONITOR_INTERVAL_SECONDS: 300,
  WORKER_LATE_CLOCK_IN_INTERVAL_SECONDS: 120,
  WORKER_SHIFT_CANCELLATION_FOLLOWUP_INTERVAL_SECONDS: 60,
  WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: 60,
  WORKER_MANAGER_CONFIRMATION_TIMEOUT_INTERVAL_SECONDS: 60,
  WORKER_REPLACEMENT_STAFF_INTERVAL_SECONDS: 120,
  WORKER_TOKEN_CLEANUP_INTERVAL_SECONDS: 86_400,
  WORKER_STORAGE_CLEANUP_INTERVAL_SECONDS: 86_400,
  WORKER_SHIFT_REPORT_SCHEDULER_INTERVAL_SECONDS: 300,
  WORKER_FINAL_TIMESHEET_INTERVAL_SECONDS: 300,
  WORKER_SHIFT_STATEMENT_DISPATCH_INTERVAL_SECONDS: 5,
  WORKER_PAYROLL_PERIOD_ATTENTION_INTERVAL_SECONDS: 1_800,
  WORKER_REALTIME_OUTBOX_PUBLISH_INTERVAL_SECONDS: 2,
};

describe('worker scan interval environment variables (Phase A)', () => {
  it('unset: every key defaults to the historical cadence', () => {
    const env = validate({ ...base }) as unknown as Record<string, unknown>;
    expect(Object.keys(HISTORICAL).sort()).toEqual([...WORKER_SCAN_INTERVAL_KEYS].sort());
    for (const [key, seconds] of Object.entries(HISTORICAL)) expect([key, env[key]]).toEqual([key, seconds]);
  });

  it('pre-existing keys keep their meaning and defaults (minutes keys, enable switches, reconcile period)', () => {
    const env = validate({ ...base });
    expect(env.LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES).toBe(15);
    expect(env.OUTBOX_RETENTION_INTERVAL_MINUTES).toBe(60);
    expect(env.AI_RETENTION_INTERVAL_MINUTES).toBe(60);
    expect(env.REALTIME_ENABLED).toBe(false);
    expect(env.PUSH_ENABLED).toBe(false);
    expect(env.WORKER_SCHEDULER).toBe('interval');
    expect(env.WORKER_SCHEDULER_RECONCILE_SECONDS).toBe(60);
  });

  it.each(Object.entries(WORKER_SCAN_INTERVAL_SETTINGS))('%s accepts its inclusive bounds', (key, s) => {
    expect((validate({ ...base, [key]: String(s.minSeconds) }) as unknown as Record<string, unknown>)[key]).toBe(s.minSeconds);
    expect((validate({ ...base, [key]: String(s.maxSeconds) }) as unknown as Record<string, unknown>)[key]).toBe(s.maxSeconds);
  });

  it.each(Object.entries(WORKER_SCAN_INTERVAL_SETTINGS))('%s refuses to boot below/above its bounds, fractional or non-numeric', (key, s) => {
    for (const bad of [String(s.minSeconds - 1), String(s.maxSeconds + 1), '1.5', 'abc', '-1', '0', '60s', 'Infinity']) {
      expect(() => validate({ ...base, [key]: bad })).toThrow(new RegExp(`Invalid environment configuration[\\s\\S]*${key}`));
    }
  });

  it('an empty value means unset (the shared normalisation), so the default applies', () => {
    const env = validate({ ...base, WORKER_OFFER_EXPIRY_INTERVAL_SECONDS: '' }) as unknown as Record<string, unknown>;
    expect(env.WORKER_OFFER_EXPIRY_INTERVAL_SECONDS).toBe(60);
  });
});
