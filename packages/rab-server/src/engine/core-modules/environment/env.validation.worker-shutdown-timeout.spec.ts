import { validate } from './env.validation';

/**
 * XR-10 (Phase X2.5): WORKER_SHUTDOWN_TIMEOUT_MS is declared and bounded. Before, the Worker read it with Number() at
 * shutdown and nothing validated it: garbage became NaN (the hard-exit timer fired at once, no drain) and a value above
 * 35 000 outlived the 45 s stop_grace_period (SIGKILL mid-drain). Now both processes refuse to boot on either.
 */
const base = { PG_DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('env validation: WORKER_SHUTDOWN_TIMEOUT_MS (XR-10)', () => {
  it('unset or empty keeps booting (the Worker applies the unchanged 30 000 ms default)', () => {
    expect(validate({ ...base }).WORKER_SHUTDOWN_TIMEOUT_MS).toBeUndefined();
    expect(validate({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: '' }).WORKER_SHUTDOWN_TIMEOUT_MS).toBeUndefined();
  });

  it.each(['1000', '15000', '30000', '34000'])('accepts %s ms', (value) => {
    expect(validate({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: value }).WORKER_SHUTDOWN_TIMEOUT_MS).toBe(value);
  });

  it.each(['0', '999', '34001', '35000', '45000', '600000'])('refuses the out-of-range value %s', (value) => {
    expect(() => validate({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: value })).toThrow(
      /Invalid environment configuration:\nWORKER_SHUTDOWN_TIMEOUT_MS must be an integer number of milliseconds from 1000 to 34000/,
    );
  });

  it.each(['abc', '30s', ' 30000', '3e4', '-1000', '30000.0', 'NaN'])('refuses the malformed value %p (never NaN)', (value) => {
    expect(() => validate({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: value })).toThrow(/WORKER_SHUTDOWN_TIMEOUT_MS must be/);
  });

  it('the refusal never echoes the raw value', () => {
    expect(() => validate({ ...base, WORKER_SHUTDOWN_TIMEOUT_MS: 'secret-looking-value' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-looking-value') }),
    );
  });
});
