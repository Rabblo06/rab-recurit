import { validate } from './env.validation';

/**
 * Wave 5 lane OPS env vars. The first two cases are the regression for a bug caught by this lane's own load test: without
 * `@Type(() => String)` ahead of the strict-boolean transform, `enableImplicitConversion` turned the STRING 'false' into
 * `true` — which would have switched outbox retention (and the L1) ON in an environment that set them explicitly off.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('wave 5 lane OPS environment variables', () => {
  it.each(['OUTBOX_RETENTION_ENABLED', 'METADATA_L1_CACHE_ENABLED', 'LOGIN_HANDOFF_CLEANUP_ENABLED'])('%s: "false" is false, "true" is true, a typo refuses to boot', (key) => {
    expect(validate({ ...base, [key]: 'false' })[key as 'OUTBOX_RETENTION_ENABLED']).toBe(false);
    expect(validate({ ...base, [key]: 'true' })[key as 'OUTBOX_RETENTION_ENABLED']).toBe(true);
    expect(() => validate({ ...base, [key]: 'flase' })).toThrow(new RegExp(key));
    expect(() => validate({ ...base, [key]: '1' })).toThrow(new RegExp(key));
  });

  it('defaults: retention + L1 off, handoff cleanup on, report mode, suggested periods, L1 2 s / 5000 entries / 8 MiB', () => {
    const env = validate({ ...base });
    expect(env).toMatchObject({
      OUTBOX_RETENTION_ENABLED: false,
      OUTBOX_RETENTION_MODE: 'report',
      OUTBOX_RETENTION_EMAIL_DAYS: 90,
      OUTBOX_RETENTION_PUSH_DAYS: 30,
      OUTBOX_RETENTION_REALTIME_DAYS: 7,
      OUTBOX_RETENTION_WORKER_EVENT_DAYS: 30,
      OUTBOX_RETENTION_BATCH_SIZE: 1000,
      OUTBOX_RETENTION_MAX_BATCHES_PER_SCOPE: 20,
      OUTBOX_RETENTION_INTERVAL_MINUTES: 60,
      METADATA_L1_CACHE_ENABLED: false,
      METADATA_L1_CACHE_TTL_MS: 2000,
      METADATA_L1_CACHE_MAX_ENTRIES: 5000,
      METADATA_L1_CACHE_MAX_BYTES: 8388608,
      // MFA-lane request: short-lived security tokens — purged by default.
      LOGIN_HANDOFF_CLEANUP_ENABLED: true,
      LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES: 15,
    });
  });

  it.each([
    ['OUTBOX_RETENTION_EMAIL_DAYS', '29'],
    ['OUTBOX_RETENTION_PUSH_DAYS', '29'],
    ['OUTBOX_RETENTION_REALTIME_DAYS', '6'],
    ['OUTBOX_RETENTION_WORKER_EVENT_DAYS', '29'],
    ['OUTBOX_RETENTION_MODE', 'delete-everything'],
    ['OUTBOX_RETENTION_BATCH_SIZE', '10001'],
    ['METADATA_L1_CACHE_TTL_MS', '999'],
    ['METADATA_L1_CACHE_TTL_MS', '5001'],
    ['METADATA_L1_CACHE_MAX_ENTRIES', '50001'],
    ['METADATA_L1_CACHE_MAX_BYTES', '1000'],
    ['LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES', '0'],
    ['LOGIN_HANDOFF_CLEANUP_INTERVAL_MINUTES', '1441'],
  ])('refuses to boot with %s=%s (below the floor / outside the range)', (key, value) => {
    expect(() => validate({ ...base, [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts the floors themselves and purge mode', () => {
    const env = validate({ ...base, OUTBOX_RETENTION_EMAIL_DAYS: '30', OUTBOX_RETENTION_REALTIME_DAYS: '7', OUTBOX_RETENTION_MODE: 'purge' });
    expect(env.OUTBOX_RETENTION_EMAIL_DAYS).toBe(30);
    expect(env.OUTBOX_RETENTION_REALTIME_DAYS).toBe(7);
    expect(env.OUTBOX_RETENTION_MODE).toBe('purge');
  });
});
