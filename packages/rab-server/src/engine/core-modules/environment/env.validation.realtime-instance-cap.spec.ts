import { validate } from './env.validation';

/**
 * C1 review F7: REALTIME_MAX_CONNECTIONS_PER_INSTANCE bounds the SSE streams one API process holds across every user.
 * A whole number from 1 to 100000, default 1000; anything else refuses to boot (fail closed, never a silent default).
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('REALTIME_MAX_CONNECTIONS_PER_INSTANCE environment variable', () => {
  it('defaults to 1000', () => {
    expect(validate({ ...base }).REALTIME_MAX_CONNECTIONS_PER_INSTANCE).toBe(1000);
  });

  it.each([['1', 1], ['250', 250], ['100000', 100000]])('accepts %s', (value, parsed) => {
    expect(validate({ ...base, REALTIME_MAX_CONNECTIONS_PER_INSTANCE: value }).REALTIME_MAX_CONNECTIONS_PER_INSTANCE).toBe(parsed);
  });

  it.each(['0', '-1', '100001', '2.5', 'abc'])('refuses to boot with %p', (value) => {
    expect(() => validate({ ...base, REALTIME_MAX_CONNECTIONS_PER_INSTANCE: value })).toThrow(/REALTIME_MAX_CONNECTIONS_PER_INSTANCE/);
  });
});
