import { ExecutionContext } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

import { ThrottlerRedisClientProvider } from '../../../engine/core-modules/throttler/throttler-redis-client.provider';
import { AttendancePerUserThrottleGuard } from './attendance-per-user-throttle.guard';

/**
 * X1.7 (cleanup audit DUP-02). The per-user clock-in/out throttle used `INCR` and then, as a SEPARATE command, `EXPIRE`
 * when the count was 1. If `EXPIRE` failed after `INCR` succeeded (command timeout, connection drop, process crash), the
 * catch failed open but the key stayed in Redis with NO TTL: every later request incremented it, and from the 11th on that
 * staff member got 429 on Clock In / Clock Out / geofence exit permanently.
 *
 * These run against a REAL Redis (REDIS_URL: CI's service, or a disposable local container), on random per-test user ids
 * whose keys are deleted afterwards. The "EXPIRE fails" fault is injected by a client wrapper whose `expire` / `pexpire`
 * throw after the real `incr` ran, which is exactly the reported sequence.
 */
const REDIS_URL = process.env.REDIS_URL;
const describeIfRedis = REDIS_URL ? describe : describe.skip;

const LIMIT = 10;

function contextFor(userId: string | null): ExecutionContext {
  const request = { authContext: userId ? { userId } : undefined };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

/** A real ioredis client whose EXPIRE-family commands fail (a transport fault between two commands). */
function expireFailingClient(real: Redis): Redis {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'expire' || prop === 'pexpire') {
        return async () => {
          throw new Error('simulated EXPIRE timeout');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describeIfRedis('AttendancePerUserThrottleGuard: atomic window (X1.7, audit DUP-02)', () => {
  let redis: Redis;
  const keys: string[] = [];
  const previousFlag = process.env.RAB_DISABLE_RATE_LIMIT;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1, lazyConnect: true });
    await redis.connect();
    // The guard is exercised for real (the Jest bypass would skip it).
    process.env.RAB_DISABLE_RATE_LIMIT = 'false';
  });

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.RAB_DISABLE_RATE_LIMIT;
    else process.env.RAB_DISABLE_RATE_LIMIT = previousFlag;
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  });

  const guardWith = (client: Redis) => new AttendancePerUserThrottleGuard({ client } as unknown as ThrottlerRedisClientProvider);
  const newUser = () => {
    const userId = randomUUID();
    keys.push(`attendance-clock-throttle:${userId}`);
    return { userId, key: `attendance-clock-throttle:${userId}` };
  };

  it('reproduction: INCR succeeds, EXPIRE fails -> the key must still carry a TTL (it did not before X1.7)', async () => {
    const { userId, key } = newUser();
    const guard = guardWith(expireFailingClient(redis));
    // The first request of a window: the step that used to INCR, then EXPIRE separately.
    await expect(guard.canActivate(contextFor(userId))).resolves.toBe(true);
    expect(await redis.get(key)).toBe('1');
    const ttl = await redis.pttl(key);
    // -1 = the key exists with no expiry: the permanent-429 state.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('a counter already left without a TTL (by the old code) is healed on the next request, so the user is not locked out forever', async () => {
    const { userId, key } = newUser();
    await redis.set(key, String(LIMIT + 5)); // the stuck state: over the limit, no TTL
    expect(await redis.pttl(key)).toBe(-1);
    const guard = guardWith(redis);
    await expect(guard.canActivate(contextFor(userId))).rejects.toBeInstanceOf(ThrottlerException);
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    // After the window the user is admitted again (simulate the expiry instead of waiting 60 s).
    await redis.del(key);
    await expect(guard.canActivate(contextFor(userId))).resolves.toBe(true);
  });

  it('keeps the contract: 10 clock actions per user per window, the 11th gets 429; the TTL is set once, not extended', async () => {
    const { userId, key } = newUser();
    const guard = guardWith(redis);
    for (let i = 1; i <= LIMIT; i++) await expect(guard.canActivate(contextFor(userId))).resolves.toBe(true);
    const ttlAfterTen = await redis.pttl(key);
    await expect(guard.canActivate(contextFor(userId))).rejects.toBeInstanceOf(ThrottlerException);
    expect(await redis.get(key)).toBe(String(LIMIT + 1));
    // Fixed window: later requests never push the expiry back.
    expect(await redis.pttl(key)).toBeLessThanOrEqual(ttlAfterTen);
    // Per user: another staff member is unaffected.
    const other = newUser();
    await expect(guard.canActivate(contextFor(other.userId))).resolves.toBe(true);
  });

  it('keeps the CF-17 failure policy: the store unavailable -> the request is allowed (fail open), nothing written', async () => {
    const { userId, key } = newUser();
    const broken = new Proxy(redis, {
      get(target, prop, receiver) {
        if (prop === 'eval' || prop === 'evalsha' || prop === 'incr' || prop === 'expire' || prop === 'pexpire') {
          return async () => {
            throw new Error('simulated Redis outage');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(guardWith(broken).canActivate(contextFor(userId))).resolves.toBe(true);
    expect(await redis.exists(key)).toBe(0);
  });

  it('an unauthenticated request is let through to JwtAuthGuard, as before', async () => {
    await expect(guardWith(redis).canActivate(contextFor(null))).resolves.toBe(true);
  });
});
