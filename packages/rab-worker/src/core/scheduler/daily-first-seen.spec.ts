import { DAILY_FIRST_SEEN_KEY_PREFIX, dailyScansMissingStamp, recordDailyFirstSeen } from './daily-first-seen';
import { SCAN_JOBS, ScanJobDefinition } from './scan-jobs';

/**
 * D-Q5a (§5.3, audit §13 #9): the boot-time "first seen without a stamp" record for the daily (`firstRunAfterInterval`)
 * scans. Unit level with a scripted Redis; the real-Redis race / TTL / wipe cases are in
 * dq5-daily-first-seen.integration.spec.ts.
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const DAILY = SCAN_JOBS.filter((def) => def.firstRunAfterInterval);

type Reply = [Error | null, unknown];
function fakeRedis(script: (commands: unknown[][]) => Promise<Reply[] | null>) {
  const calls: unknown[][][] = [];
  return {
    calls,
    redis: {
      multi() {
        const commands: unknown[][] = [];
        const chain = {
          set: (...args: unknown[]) => (commands.push(['set', ...args]), chain),
          get: (...args: unknown[]) => (commands.push(['get', ...args]), chain),
          exec: () => {
            calls.push(commands);
            return script(commands);
          },
        };
        return chain;
      },
    },
  };
}

describe('dailyScansMissingStamp', () => {
  const intervalOf = () => DAY;
  const enabled = () => true;

  it('the registry has exactly the three daily housekeeping scans (the set this fix applies to)', () => {
    expect(DAILY.map((def) => def.jobName).sort()).toEqual(['storage-cleanup', 'token-cleanup', 'workspace-provisioning-health']);
  });

  it('lists every enabled daily scan whose stamp is missing, with its interval', () => {
    expect(dailyScansMissingStamp(SCAN_JOBS, {}, intervalOf, enabled)).toEqual(DAILY.map((def) => ({ statKey: def.statKeys.lastRunAt, intervalMs: DAY })));
  });

  it('a scan WITH a stamp (valid, empty-string excluded) is not listed — a real stamp always wins, so no first-seen is needed', () => {
    const [first, ...rest] = DAILY;
    const stamps = { [first!.statKeys.lastRunAt]: String(NOW - 1000) };
    expect(dailyScansMissingStamp(SCAN_JOBS, stamps, intervalOf, enabled).map((s) => s.statKey)).toEqual(rest.map((def) => def.statKeys.lastRunAt));
    // An empty-string stamp is "missing" (firstRunDelayFromStamp treats it the same).
    expect(dailyScansMissingStamp(SCAN_JOBS, { [first!.statKeys.lastRunAt]: '' }, intervalOf, enabled)).toHaveLength(DAILY.length);
  });

  it('NEGATIVE: an unparsable stamp is present, so the scan is NOT listed (old behaviour: one full interval)', () => {
    const [first] = DAILY;
    const listed = dailyScansMissingStamp(SCAN_JOBS, { [first!.statKeys.lastRunAt]: 'garbage' }, intervalOf, enabled);
    expect(listed.map((s) => s.statKey)).not.toContain(first!.statKeys.lastRunAt);
  });

  it('NEGATIVE: a disabled daily scan and every non-daily scan are never listed', () => {
    const [first] = DAILY;
    const listed = dailyScansMissingStamp(SCAN_JOBS, {}, intervalOf, (def: ScanJobDefinition) => def !== first);
    expect(listed.map((s) => s.statKey)).not.toContain(first!.statKeys.lastRunAt);
    for (const s of listed) expect(DAILY.map((def) => def.statKeys.lastRunAt)).toContain(s.statKey);
  });

  it('NEGATIVE: a scan whose interval cannot be resolved is skipped here (registerIntervalScans then refuses, as before)', () => {
    const [first] = DAILY;
    const listed = dailyScansMissingStamp(SCAN_JOBS, {}, (def) => {
      if (def === first) throw new Error('bad interval');
      return DAY;
    }, enabled);
    expect(listed).toHaveLength(DAILY.length - 1);
  });
});

describe('recordDailyFirstSeen', () => {
  const scans = [
    { statKey: 'lastTokenCleanupAt', intervalMs: DAY },
    { statKey: 'lastStorageCleanupAt', intervalMs: 2 * DAY },
  ];

  it('one MULTI: SET <prefix><statKey> <now> PX <2 × interval> NX, then GET, per scan; returns the stored values', async () => {
    const earlier = NOW - 5 * 60 * 60 * 1000;
    const { redis, calls } = fakeRedis(async () => [[null, 'OK'], [null, String(NOW)], [null, null], [null, String(earlier)]]);
    const seen = await recordDailyFirstSeen(redis, scans, NOW);
    expect(calls).toEqual([
      [
        ['set', `${DAILY_FIRST_SEEN_KEY_PREFIX}lastTokenCleanupAt`, String(NOW), 'PX', 2 * DAY, 'NX'],
        ['get', `${DAILY_FIRST_SEEN_KEY_PREFIX}lastTokenCleanupAt`],
        ['set', `${DAILY_FIRST_SEEN_KEY_PREFIX}lastStorageCleanupAt`, String(NOW), 'PX', 4 * DAY, 'NX'],
        ['get', `${DAILY_FIRST_SEEN_KEY_PREFIX}lastStorageCleanupAt`],
      ],
    ]);
    // The second key already existed (an earlier boot, or another replica): ITS value is used, not this boot's.
    expect(seen).toEqual(new Map([['lastTokenCleanupAt', NOW], ['lastStorageCleanupAt', earlier]]));
  });

  it('the key is never the stats hash (Admin Health lists every last…At field there as a last run)', () => {
    expect(DAILY_FIRST_SEEN_KEY_PREFIX.startsWith('rab:worker:stats')).toBe(false);
    expect(`${DAILY_FIRST_SEEN_KEY_PREFIX}lastTokenCleanupAt`).not.toMatch(/^last[A-Z][A-Za-z0-9]{0,62}At$/);
  });

  it('no scan is missing its stamp → no Redis call at all (the normal case: behaviour byte-identical)', async () => {
    const { redis, calls } = fakeRedis(async () => []);
    expect(await recordDailyFirstSeen(redis, [], NOW)).toEqual(new Map());
    expect(calls).toEqual([]);
  });

  it('NEGATIVE: Redis rejects → empty map (each scan falls back to one full interval)', async () => {
    const { redis } = fakeRedis(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await recordDailyFirstSeen(redis, scans, NOW)).toEqual(new Map());
  });

  it('NEGATIVE: Redis hangs → empty map after the timeout; boot is never blocked', async () => {
    const { redis } = fakeRedis(() => new Promise(() => undefined));
    const started = Date.now();
    expect(await recordDailyFirstSeen(redis, scans, NOW, 50)).toEqual(new Map());
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('NEGATIVE: a discarded transaction (exec → null) → empty map', async () => {
    const { redis } = fakeRedis(async () => null);
    expect(await recordDailyFirstSeen(redis, scans, NOW)).toEqual(new Map());
  });

  it.each([
    ['a per-command error', [[null, 'OK'], [new Error('WRONGTYPE'), null]]],
    ['a missing value (key evicted between SET and GET)', [[null, 'OK'], [null, null]]],
    ['an unparsable value', [[null, null], [null, 'not-a-number']]],
  ] as Array<[string, Reply[]]>)('NEGATIVE: %s for a scan → that scan is omitted (full interval), the others kept', async (_label, firstReplies) => {
    const { redis } = fakeRedis(async () => [...firstReplies, [null, 'OK'], [null, String(NOW)]]);
    expect(await recordDailyFirstSeen(redis, scans, NOW)).toEqual(new Map([['lastStorageCleanupAt', NOW]]));
  });
});
