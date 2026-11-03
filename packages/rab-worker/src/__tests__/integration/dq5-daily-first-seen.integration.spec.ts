import Redis from 'ioredis';

import { WORKER_STATS_KEY } from '@rab/server/engine/worker-shared/heartbeat.constants';
import { firstRunDelayFromStamp } from '../../core/scheduler/bullmq-scheduler';
import { DAILY_FIRST_SEEN_KEY_PREFIX, recordDailyFirstSeen } from '../../core/scheduler/daily-first-seen';

/**
 * D-Q5a (§5.3, audit §13 #9) against a REAL Redis (REDIS_URL = the disposable test Redis): the "first seen without a
 * stamp" record two replicas agree on, its TTL, and what a wipe does to it. No PostgreSQL involved: the daily-scan timing
 * is Redis-only and touches no tenant data.
 */
const REDIS_URL = process.env.REDIS_URL;
const describeIf = REDIS_URL ? describe : describe.skip;
jest.setTimeout(30_000);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describeIf('D-Q5a daily first-seen record (real Redis)', () => {
  let a: Redis;
  let b: Redis;
  // Test-unique stat keys: the record lives under DAILY_FIRST_SEEN_KEY_PREFIX + statKey, so nothing else is touched.
  const tag = `dq5a${process.pid}${Date.now()}`;
  const statKey = (name: string) => `last${tag}${name}At`;
  const keyOf = (name: string) => `${DAILY_FIRST_SEEN_KEY_PREFIX}${statKey(name)}`;

  beforeAll(() => {
    a = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1 });
    b = new Redis(REDIS_URL!, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    const keys = await a.keys(`${DAILY_FIRST_SEEN_KEY_PREFIX}last${tag}*`);
    if (keys.length) await a.del(...keys);
    await a.quit();
    await b.quit();
  });

  it('two replicas booting at once agree on ONE first-seen time (SET NX), so their timers agree', async () => {
    const t = Date.now();
    const scans = [{ statKey: statKey('Race'), intervalMs: DAY }];
    const [fromA, fromB] = await Promise.all([recordDailyFirstSeen(a, scans, t), recordDailyFirstSeen(b, scans, t + 5_000)]);
    expect(fromA.get(statKey('Race'))).toBeDefined();
    expect(fromA.get(statKey('Race'))).toBe(fromB.get(statKey('Race')));
    expect([t, t + 5_000]).toContain(fromA.get(statKey('Race')));
  });

  it('a later boot keeps the FIRST boot\'s time (never pushed forward by restarts — the starvation this fixes)', async () => {
    const first = Date.now() - 20 * HOUR;
    const scans = [{ statKey: statKey('Restart'), intervalMs: DAY }];
    expect((await recordDailyFirstSeen(a, scans, first)).get(statKey('Restart'))).toBe(first);
    const now = Date.now();
    const seen = await recordDailyFirstSeen(b, scans, now);
    expect(seen.get(statKey('Restart'))).toBe(first);
    const delay = firstRunDelayFromStamp(undefined, DAY, now, seen.get(statKey('Restart')));
    expect(delay).toBeLessThanOrEqual(4 * HOUR + 1_000);
    expect(delay).toBeGreaterThan(4 * HOUR - 60_000);
  });

  it('the record expires after two intervals (bounded: a stale record can never apply for longer)', async () => {
    const scans = [{ statKey: statKey('Ttl'), intervalMs: 60_000 }];
    await recordDailyFirstSeen(a, scans, Date.now());
    const pttl = await a.pttl(keyOf('Ttl'));
    expect(pttl).toBeGreaterThan(110_000);
    expect(pttl).toBeLessThanOrEqual(120_000);
  });

  it('after the record is wiped (Redis data loss) the next boot records a fresh time → one full interval, as before', async () => {
    const scans = [{ statKey: statKey('Wipe'), intervalMs: DAY }];
    await recordDailyFirstSeen(a, scans, Date.now() - 10 * HOUR);
    await a.del(keyOf('Wipe')); // stands in for FLUSHALL without disturbing other suites on this Redis
    const now = Date.now();
    const seen = await recordDailyFirstSeen(b, scans, now);
    expect(seen.get(statKey('Wipe'))).toBe(now);
    expect(firstRunDelayFromStamp(undefined, DAY, now, seen.get(statKey('Wipe')))).toBe(DAY);
  });

  it('the Worker stats hash (Admin Health) is never written by the record', async () => {
    const before = await a.hgetall(WORKER_STATS_KEY);
    await recordDailyFirstSeen(a, [{ statKey: statKey('Stats'), intervalMs: DAY }], Date.now());
    expect(await a.hgetall(WORKER_STATS_KEY)).toEqual(before);
    expect(await a.type(keyOf('Stats'))).toBe('string');
  });

  it('NEGATIVE: Redis unreachable → empty map, quickly (boot falls back to one full interval)', async () => {
    const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    dead.on('error', () => undefined);
    const started = Date.now();
    expect(await recordDailyFirstSeen(dead, [{ statKey: statKey('Dead'), intervalMs: DAY }], Date.now(), 1_000)).toEqual(new Map());
    expect(Date.now() - started).toBeLessThan(5_000);
    dead.disconnect();
  });
});
