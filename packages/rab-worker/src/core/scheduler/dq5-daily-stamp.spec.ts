import { firstRunDelayFromStamp } from './bullmq-scheduler';

/**
 * D-Q5 test preparation (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §D-Q5.3; audit §13 #9 "daily-stamp starvation").
 *
 * The three daily housekeeping scans (token-cleanup, storage-cleanup, workspace-provisioning-health) are
 * `firstRunAfterInterval`; in interval mode main.ts times their first run from the `last<Loop>At` stamp in the Redis
 * stats hash (`firstRunDelayFromStamp`, bullmq-scheduler.ts). With the stamp present the D3 fix holds: an overdue scan
 * runs at start, so deploys cannot starve it. With NO stamp (Redis wiped, or the HGETALL at boot failed and was caught
 * as `{}`), every boot waits one full interval again — so a Worker that restarts more often than once per interval
 * after a wipe never runs these scans. No data is lost (the work is idempotent and catches up on the first run), but
 * token / storage cleanup and the provisioning-health alert stop. That is a liveness defect, not a business rule.
 *
 * CHARACTERISATION tests below pass today and pin the defect. The FAILING-FIRST spec is gated behind
 * DQ45_PENDING_SPECS=1: it encodes the PROPOSED fix (a "first seen" time recorded at the first boot that found no
 * stamp, passed as a 4th argument) and fails on today's code, which ignores that argument.
 */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-03T00:00:00Z');

/** Boots every `restartEveryMs` for `spanMs`; returns the boot-relative time the daily scan first fires, or null. */
function simulateBootsAfterWipe(
  delayFor: (bootAt: number) => number,
  restartEveryMs: number,
  spanMs: number,
): number | null {
  for (let bootAt = T0; bootAt < T0 + spanMs; bootAt += restartEveryMs) {
    const firesAt = bootAt + delayFor(bootAt);
    if (firesAt < bootAt + restartEveryMs) return firesAt - T0; // fired before the next restart
  }
  return null;
}

describe('D-Q5 characterisation: daily first-run delay from the persisted stamp', () => {
  it('stamp present and overdue → runs at start (the D3 fix, unchanged)', () => {
    expect(firstRunDelayFromStamp(String(T0 - 2 * DAY), DAY, T0)).toBe(0);
  });

  it('stamp present, ran 20 h ago → waits the remaining 4 h', () => {
    expect(firstRunDelayFromStamp(String(T0 - 20 * HOUR), DAY, T0)).toBe(4 * HOUR);
  });

  it.each([[null], [undefined], [''], ['not-a-number'], [String(T0 + HOUR)]])('stamp %p → one full interval', (stamp) => {
    expect(firstRunDelayFromStamp(stamp as string | null | undefined, DAY, T0)).toBe(DAY);
  });

  it('DEFECT §13 #9 pinned: after a Redis wipe, restarts every 6 h for 3 days never run the daily scan', () => {
    const firesAt = simulateBootsAfterWipe((bootAt) => firstRunDelayFromStamp(undefined, DAY, bootAt), 6 * HOUR, 3 * DAY);
    expect(firesAt).toBeNull();
  });
});

const describePending = process.env.DQ45_PENDING_SPECS === '1' ? describe : describe.skip;

describePending('PENDING D-Q5.3 (failing-first; PROPOSED contract): a wipe can delay a daily scan by at most one interval', () => {
  // PROPOSED: main.ts records `<lastRunAt>FirstSeenAt` with HSETNX at the first boot that finds no stamp, and passes it
  // here. The delay is then measured from that first boot, not from each restart.
  const withFirstSeen = firstRunDelayFromStamp as unknown as (stamp: string | undefined, intervalMs: number, now: number, firstSeenAt?: number) => number;

  it('no stamp, first seen 23 h ago → runs in 1 h', () => {
    expect(withFirstSeen(undefined, DAY, T0, T0 - 23 * HOUR)).toBe(HOUR);
  });

  it('restarts every 6 h after a wipe: the scan fires within one interval of the first boot', () => {
    const firesAt = simulateBootsAfterWipe((bootAt) => withFirstSeen(undefined, DAY, bootAt, T0), 6 * HOUR, 3 * DAY);
    expect(firesAt).not.toBeNull();
    expect(firesAt!).toBeLessThanOrEqual(DAY);
  });

  it('a real stamp still wins over first-seen (no behaviour change when Redis kept its data)', () => {
    expect(withFirstSeen(String(T0 - 20 * HOUR), DAY, T0, T0 - 23 * HOUR)).toBe(4 * HOUR);
  });
});
