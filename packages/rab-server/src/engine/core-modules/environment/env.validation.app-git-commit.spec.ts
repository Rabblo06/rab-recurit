import { validate } from './env.validation';

/**
 * Admin Panel "Commit": APP_GIT_COMMIT is optional. An empty value (a Docker build arg that was not passed) counts as
 * unset instead of refusing to boot; anything that is not a 7–40 character lowercase hex SHA still refuses.
 */
const base = { DATABASE_URL: 'postgres://rab:rab@localhost:5432/rab', REDIS_URL: 'redis://localhost:6379', APP_SECRET: 'a'.repeat(32) };

describe('APP_GIT_COMMIT', () => {
  it('may be absent or empty', () => {
    expect(validate({ ...base }).APP_GIT_COMMIT).toBeUndefined();
    expect(() => validate({ ...base, APP_GIT_COMMIT: '' })).not.toThrow();
  });

  it('accepts a short or full hex SHA', () => {
    expect(validate({ ...base, APP_GIT_COMMIT: 'b7103fe1' }).APP_GIT_COMMIT).toBe('b7103fe1');
    expect(validate({ ...base, APP_GIT_COMMIT: 'a'.repeat(40) }).APP_GIT_COMMIT).toBe('a'.repeat(40));
  });

  it.each(['abc', 'B7103FE1', 'b7103fe1 ', '<script>', 'a'.repeat(41)])('refuses to boot with APP_GIT_COMMIT=%p', (value) => {
    expect(() => validate({ ...base, APP_GIT_COMMIT: value })).toThrow(/APP_GIT_COMMIT/);
  });
});
