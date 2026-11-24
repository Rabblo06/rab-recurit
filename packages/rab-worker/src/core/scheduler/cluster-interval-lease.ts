import type { Redis } from 'ioredis';

/**
 * XR-12 (Phase X audit; WRK-03/WRK-07 residual): one run per interval for the WHOLE cluster, for the in-process daily
 * loops that are not BullMQ scans (workspace schema drift, workspace core orphans).
 *
 * Before: each was a plain `runtime.every` timer that ran at every Worker start and then once per interval on EVERY
 * replica, so each deploy and each extra replica repeated a full walk of every workspace schema.
 *
 * Now: the loop ticks often (at most hourly) and each tick first claims a Redis lease, `SET <key> <holder> PX <ttl> NX`.
 * Only the tick that wins the lease runs; every other tick, on any replica and after any restart, returns idle (not
 * stamped, not a failure). The lease is the cluster's "ran recently" record:
 * - a restart within the interval finds the lease held and does not repeat the walk (it ran at every start before);
 * - two replicas never both run it in one interval (SET NX is atomic);
 * - when the replica that ran it dies, another one picks it up within one tick of the lease expiring (≤ 1 h late);
 * - a failed run keeps its lease, so it is retried after one interval, as before (no hourly retry storm of an alert).
 * - Redis failing → the claim throws → the tick counts as a failure of the loop (visible in Admin Health) and nothing
 *   runs. These loops are read-only, alert-only checks; skipping one while Redis is down loses nothing durable.
 * - The key holds the holder's `host:pid` and an expiry only: no tenant data.
 *
 * Idempotent by construction: the work itself is read-only (drift fingerprint compare, orphan counts), so the rare
 * double run (a lease expiring while a slow run is still going) only repeats a report.
 */
export const CLUSTER_LEASE_KEY_PREFIX = 'rab:worker:lease:';
/** The longest gap between two claim attempts of a daily loop (so a dead lease holder is replaced within this). */
export const CLUSTER_LEASE_MAX_TICK_MS = 60 * 60 * 1000;

export interface ClusterIntervalLease {
  /** True when this caller now holds the lease `name` for `ttlMs`; false when another holder has it. Throws on Redis errors. */
  claim(name: string, ttlMs: number): Promise<boolean>;
}

export function redisClusterIntervalLease(redis: Pick<Redis, 'set'>, holder: string): ClusterIntervalLease {
  return {
    async claim(name, ttlMs) {
      const result = await redis.set(`${CLUSTER_LEASE_KEY_PREFIX}${name}`, holder, 'PX', Math.max(1, Math.floor(ttlMs)), 'NX');
      return result === 'OK';
    },
  };
}

/**
 * The tick and the lease length of a loop with interval `intervalMs`: tick = min(interval, 1 h); lease = the interval less a
 * small margin (≤ 60 s, ≤ 10 %), so the holder's own next tick, which a timer may fire a little early, can claim again.
 */
export function clusterLeaseTiming(intervalMs: number, maxTickMs: number = CLUSTER_LEASE_MAX_TICK_MS): { tickMs: number; ttlMs: number } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`cluster lease: invalid interval ${intervalMs}`);
  const tickMs = Math.min(intervalMs, maxTickMs);
  const ttlMs = Math.max(1, intervalMs - Math.min(60_000, Math.floor(intervalMs / 10)));
  return { tickMs, ttlMs };
}

export interface ClusterLeasedLoop {
  /** The `runtime.every` interval: how often a claim is attempted. */
  intervalMs: number;
  /** One tick: claim, then run only when claimed. `false` (idle, not stamped) when another tick holds the lease. */
  run: () => Promise<boolean | void>;
}

/**
 * Wraps a loop body so it runs once per `intervalMs` across the cluster. Without a `lease` (unit and integration tests
 * that drive the loops by hand) the body runs on every tick at `intervalMs`, exactly as before.
 */
export function clusterLeasedLoop(options: {
  leaseName: string;
  intervalMs: number;
  lease?: ClusterIntervalLease;
  run: () => Promise<boolean | void>;
}): ClusterLeasedLoop {
  const { lease, run } = options;
  if (!lease) return { intervalMs: options.intervalMs, run };
  const { tickMs, ttlMs } = clusterLeaseTiming(options.intervalMs);
  return {
    intervalMs: tickMs,
    run: async () => {
      if (!(await lease.claim(options.leaseName, ttlMs))) return false;
      return run();
    },
  };
}
