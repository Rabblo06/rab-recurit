import type { ScanJobDefinition } from './scan-jobs';

/**
 * D-Q5a (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.3; audit §13 #9 "daily-stamp starvation after a Redis wipe").
 *
 * Interval mode times the first run of each daily (`firstRunAfterInterval`) scan from its persisted `last<Loop>At` stamp
 * (`firstRunDelayFromStamp`). When that stamp is MISSING — Redis lost its data — every boot used to wait one full
 * interval again, so a Worker that restarts more often than once per interval never ran token cleanup, storage cleanup or
 * the provisioning-health alert. This module records, once, WHEN a boot first found the stamp missing, so the delay is
 * measured from that first boot instead of from every restart.
 *
 * - One string key per scan, `rab:worker:daily-first-seen:<statKey>`, written with `SET … NX PX <2 × interval>`, then read
 *   back in the same MULTI: the first boot (of any replica) wins and every later boot, on any replica, reads the same
 *   time — so replicas agree exactly as they do on a shared stamp.
 * - NOT a field of the stats hash (`rab:worker:stats`): Admin Health lists every `last…At` field there as a "last run"
 *   (admin-queues.service.ts STAT_LAST_KEY), and a first-seen time is not a run.
 * - The TTL (two intervals) bounds it: the record only matters until the scan's first successful run writes the real
 *   stamp (which always wins); if that never happens, a stale record expires and the next boot starts a fresh one.
 * - Only scans that are enabled, daily, and have NO stamp at all are recorded. A present stamp — even an unparsable or
 *   future one — keeps today's behaviour exactly.
 * - Fail closed to today's behaviour: Redis rejecting, hanging past `timeoutMs`, or returning anything unexpected → no
 *   first-seen time for that scan → one full interval, as before. Never an earlier run than the record justifies.
 * - Contains no tenant data: a stat-key name and an epoch-ms number.
 */
export const DAILY_FIRST_SEEN_KEY_PREFIX = 'rab:worker:daily-first-seen:';
export const DAILY_FIRST_SEEN_TIMEOUT_MS = 2_000;

export interface MissingStampScan {
  /** The scan's `statKeys.lastRunAt` (e.g. `lastTokenCleanupAt`). */
  statKey: string;
  intervalMs: number;
}

/** The enabled daily scans whose persisted stamp is missing (absent or empty), with their resolved interval. */
export function dailyScansMissingStamp(
  jobs: readonly ScanJobDefinition[],
  stamps: Readonly<Record<string, string>>,
  intervalOf: (def: ScanJobDefinition) => number,
  isEnabled: (def: ScanJobDefinition) => boolean,
): MissingStampScan[] {
  const missing: MissingStampScan[] = [];
  for (const def of jobs) {
    if (!def.firstRunAfterInterval || !isEnabled(def)) continue;
    const stamp = stamps[def.statKeys.lastRunAt];
    if (stamp !== undefined && stamp !== '') continue;
    let intervalMs: number;
    try {
      intervalMs = intervalOf(def);
    } catch {
      continue; // registerIntervalScans resolves every interval itself and refuses to start, exactly as before
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) continue;
    missing.push({ statKey: def.statKeys.lastRunAt, intervalMs });
  }
  return missing;
}

/** The two commands this module issues inside one MULTI (structurally satisfied by an ioredis client). */
export interface FirstSeenMulti {
  set(key: string, value: string, millisecondsToken: 'PX', milliseconds: number, nx: 'NX'): FirstSeenMulti;
  get(key: string): FirstSeenMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}
export interface FirstSeenRedis {
  multi(): FirstSeenMulti;
}

/**
 * For each scan: `SET <prefix><statKey> <now> PX <2 × interval> NX`, then `GET` it, all in one MULTI. Returns statKey →
 * the stored first-seen time (this boot's `now`, or an earlier boot's). A scan missing from the map gets one full interval.
 */
export async function recordDailyFirstSeen(
  redis: FirstSeenRedis,
  scans: readonly MissingStampScan[],
  now: number,
  timeoutMs: number = DAILY_FIRST_SEEN_TIMEOUT_MS,
): Promise<Map<string, number>> {
  const seen = new Map<string, number>();
  if (scans.length === 0) return seen;
  let timer: NodeJS.Timeout | undefined;
  try {
    const multi = redis.multi();
    for (const scan of scans) {
      const key = `${DAILY_FIRST_SEEN_KEY_PREFIX}${scan.statKey}`;
      multi.set(key, String(now), 'PX', 2 * scan.intervalMs, 'NX').get(key);
    }
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const replies = await Promise.race([multi.exec(), timeout]);
    if (!replies) return seen;
    scans.forEach((scan, i) => {
      const reply = replies[2 * i + 1];
      if (!reply || reply[0]) return;
      const value = reply[1];
      if (typeof value !== 'string' || value === '') return;
      const at = Number(value);
      if (Number.isFinite(at)) seen.set(scan.statKey, at);
    });
    return seen;
  } catch {
    return new Map();
  } finally {
    if (timer) clearTimeout(timer);
  }
}
