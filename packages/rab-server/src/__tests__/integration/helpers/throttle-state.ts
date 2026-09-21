import { ThrottlerRedisClientProvider } from '../../../engine/core-modules/throttler/throttler-redis-client.provider';

/**
 * Throttle counters live in the SAME Redis the whole suite shares and outlive
 * a test for the whole window (60s). A suite that turns real rate limiting on
 * (RAB_DISABLE_RATE_LIMIT=false) therefore leaks counters to whichever suite
 * runs next from the same IP — the cause of a `429` where `rate-limiting`
 * expected `401` in a full serial run. Suites that exercise real throttling
 * clear the buckets before they assert and after they finish.
 *
 * Only throttle keys are touched: `{<hash>:default}:hits|blocked` (global
 * per-IP tier) and `attendance-clock-throttle:*` (per-user clock guard).
 */
export async function clearThrottleState(redis: ThrottlerRedisClientProvider): Promise<number> {
  let deleted = 0;
  for (const pattern of ['{*:default}:*', 'attendance-clock-throttle:*']) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) deleted += await redis.client.del(...keys);
    } while (cursor !== '0');
  }
  return deleted;
}
