import { CLUSTER_LEASE_KEY_PREFIX, clusterLeasedLoop, clusterLeaseTiming, redisClusterIntervalLease } from './cluster-interval-lease';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An in-memory stand-in for Redis `SET key value PX ms NX` with a controllable clock (one shared "cluster"). */
function fakeRedis(clock: { now: number }) {
  const keys = new Map<string, { value: string; expiresAt: number }>();
  const calls: unknown[][] = [];
  return {
    keys,
    calls,
    set: jest.fn(async (key: string, value: string, px: string, ms: number, nx: string) => {
      calls.push([key, value, px, ms, nx]);
      const current = keys.get(key);
      if (current && current.expiresAt > clock.now) return null;
      keys.set(key, { value, expiresAt: clock.now + ms });
      return 'OK';
    }),
  };
}

describe('XR-12 cluster interval lease', () => {
  it('claims with an atomic SET NX PX on rab:worker:lease:<name>, holding host:pid only', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    const lease = redisClusterIntervalLease(redis as never, 'host-a:101');
    await expect(lease.claim('workspace-schema-drift', DAY - 60_000)).resolves.toBe(true);
    expect(redis.calls[0]).toEqual([`${CLUSTER_LEASE_KEY_PREFIX}workspace-schema-drift`, 'host-a:101', 'PX', DAY - 60_000, 'NX']);
    await expect(redisClusterIntervalLease(redis as never, 'host-b:202').claim('workspace-schema-drift', DAY - 60_000)).resolves.toBe(false);
  });

  it('a Redis error is not swallowed (the tick fails visibly, nothing runs)', async () => {
    const lease = redisClusterIntervalLease({ set: async () => Promise.reject(new Error('READONLY')) } as never, 'h:1');
    const body = jest.fn(async () => undefined);
    const loop = clusterLeasedLoop({ leaseName: 'x', intervalMs: DAY, lease, run: body });
    await expect(loop.run()).rejects.toThrow('READONLY');
    expect(body).not.toHaveBeenCalled();
  });

  it('timing: a daily loop ticks hourly with a lease one minute short of a day; short intervals scale the margin', () => {
    expect(clusterLeaseTiming(DAY)).toEqual({ tickMs: HOUR, ttlMs: DAY - 60_000 });
    expect(clusterLeaseTiming(10 * 60_000)).toEqual({ tickMs: 10 * 60_000, ttlMs: 9 * 60_000 });
    expect(clusterLeaseTiming(5)).toEqual({ tickMs: 5, ttlMs: 5 });
    for (const bad of [0, -1, NaN, Infinity]) expect(() => clusterLeaseTiming(bad)).toThrow(/invalid interval/);
  });

  it('without a lease (tests driving the loops by hand) the body runs on every tick at the full interval, as before', async () => {
    const body = jest.fn(async () => undefined);
    const loop = clusterLeasedLoop({ leaseName: 'x', intervalMs: DAY, run: body });
    expect(loop.intervalMs).toBe(DAY);
    await loop.run();
    await loop.run();
    expect(body).toHaveBeenCalledTimes(2);
  });

  /**
   * The regression the audit found: the daily drift walk ran at EVERY Worker start and on EVERY replica. Simulated: two
   * replicas, a restart of each every 3 hours, for three days, on the hourly tick. The body must run about once a day for
   * the whole cluster, never twice inside one interval, and never be skipped for longer than a day plus one tick.
   */
  it('two replicas restarting every 3 h: the daily body runs once per day for the whole cluster', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    const runs: number[] = [];
    const replica = (name: string, pid: number) =>
      clusterLeasedLoop({
        leaseName: 'workspace-schema-drift',
        intervalMs: DAY,
        lease: redisClusterIntervalLease(redis as never, `${name}:${pid}`),
        run: async () => {
          runs.push(clock.now);
        },
      });
    // Each (re)start ticks at once (runtime.every without firstRunAfterInterval), then every tickMs until the next restart.
    const ticks: Array<{ at: number; run: () => Promise<boolean | void> }> = [];
    let pid = 1;
    for (const [name, offset] of [['a', 0], ['b', 20 * 60_000]] as const) {
      for (let start = offset; start < 3 * DAY; start += 3 * HOUR) {
        const loop = replica(name, pid++);
        for (let at = start; at < Math.min(start + 3 * HOUR, 3 * DAY); at += loop.intervalMs) ticks.push({ at, run: loop.run });
      }
    }
    ticks.sort((x, y) => x.at - y.at);
    for (const t of ticks) {
      clock.now = t.at;
      await t.run();
    }
    expect(runs.length).toBe(3); // day 0, day 1, day 2 (before: 2 replicas × 8 restarts × 3 days = 48 runs)
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i]! - runs[i - 1]!).toBeGreaterThanOrEqual(DAY - 60_000);
      expect(runs[i]! - runs[i - 1]!).toBeLessThanOrEqual(DAY + HOUR);
    }
  });

  it('the holder dying: another replica takes over within one tick of the lease expiring', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    const runs: string[] = [];
    const make = (holder: string) =>
      clusterLeasedLoop({ leaseName: 'workspace-core-orphans', intervalMs: DAY, lease: redisClusterIntervalLease(redis as never, holder), run: async () => void runs.push(holder) });
    const a = make('a:1');
    const b = make('b:2');
    await a.run(); // a runs at t=0, then dies
    for (clock.now = HOUR; clock.now <= DAY + HOUR; clock.now += HOUR) await b.run();
    expect(runs).toEqual(['a:1', 'b:2']);
    expect(redis.keys.get(`${CLUSTER_LEASE_KEY_PREFIX}workspace-core-orphans`)?.value).toBe('b:2');
  });

  it('a failed run keeps its lease: retried after one interval, not on the next hourly tick', async () => {
    const clock = { now: 0 };
    const redis = fakeRedis(clock);
    let attempts = 0;
    const loop = clusterLeasedLoop({
      leaseName: 'workspace-schema-drift',
      intervalMs: DAY,
      lease: redisClusterIntervalLease(redis as never, 'a:1'),
      run: async () => {
        attempts += 1;
        throw new Error('database unavailable');
      },
    });
    await expect(loop.run()).rejects.toThrow('database unavailable');
    for (clock.now = HOUR; clock.now < DAY - 60_000; clock.now += HOUR) await expect(loop.run()).resolves.toBe(false);
    expect(attempts).toBe(1);
    clock.now = DAY;
    await expect(loop.run()).rejects.toThrow('database unavailable');
    expect(attempts).toBe(2);
  });
});
