import { assertRedisReadyForBullmq, UNAUTHENTICATED_REDIS_WARNING } from './redis-preflight';

/**
 * X1.6 (owner decision 2026-11-12): an unauthenticated Redis stays a WARNING, as in Twenty (its compose Redis has no
 * password and no published port). The warning states the accepted risk (private network only) and never promises
 * a later refusal. The bullmq integration spec covers the same function against a real Redis.
 */
const fakeRedis = () => ({
  ping: async () => 'PONG',
  info: async (section: string) => (section === 'memory' ? 'maxmemory_policy:noeviction\r\n' : 'redis_version:7.4.0\r\n'),
  config: async () => [],
});

describe('Redis preflight: unauthenticated Redis warning (X1.6)', () => {
  it('warns once, still starts, and the text names the accepted risk without promising a later refusal', async () => {
    const warn = jest.fn();
    const url = 'redis://rab-redis:6379';
    const result = await assertRedisReadyForBullmq(fakeRedis() as never, url, { warn });
    expect(result).toEqual({ maxmemoryPolicy: 'noeviction', authenticated: false, redisVersion: '7.4.0' });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]![0]);
    expect(message).toBe(UNAUTHENTICATED_REDIS_WARNING);
    expect(message).toMatch(/unauthenticated/);
    expect(message).toMatch(/protected only by the private network/);
    expect(message).toMatch(/accepted risk/);
    expect(message).toMatch(/Never publish its port/);
    // No promise of a future refusal or requirement (the old text said "production should require Redis AUTH/ACL").
    expect(message).not.toMatch(/should require|will (be )?refuse|refus|later|future|before production|stage D/i);
    expect(message).not.toContain(url);
  });

  it('does not warn when REDIS_URL carries a password (and never prints it)', async () => {
    const warn = jest.fn();
    const url = 'redis://crewflow:s3cret-value@rab-redis:6379';
    await expect(assertRedisReadyForBullmq(fakeRedis() as never, url, { warn })).resolves.toMatchObject({ authenticated: true });
    expect(warn).not.toHaveBeenCalled();
  });
});
