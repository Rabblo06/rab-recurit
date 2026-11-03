import { firstRunDelayFromStamp } from './bullmq-scheduler';

/**
 * D-Q5a (docs/PHASE_DQ4_DQ5_PLAN_2026-11-03.md §5.3; audit §13 #9 "daily-stamp starvation").
 *
 * The three daily housekeeping scans (token-cleanup, storage-cleanup, workspace-provisioning-health) are
 * `firstRunAfterInterval`; in interval mode main.ts times their first run from the `last<Loop>At` stamp in the Redis stats
 * hash (`firstRunDelayFromStamp`). With the stamp present the D3 fix holds: an overdue scan runs at start. With NO stamp
 * (Redis wiped) every boot used to wait one full interval again, so a Worker restarting more often than once per interval
 * never ran these scans. The fix: main.ts records a "first seen without a stamp" time once (SET NX, see daily-first-seen.ts)
 * and passes it as a 4th argument; the delay is then measured from that first boot, never from each restart.
 *
 * Copied from the test-prep branch (phase-d/dq45-test-prep); the PROPOSED block is no longer gated.
 */
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-03T00:00:00Z');

/** Boots every `restartEveryMs` for `spanMs`; returns the boot-relative time the daily scan first fires, or null. */
function simulateBootsAfterWipe(delayFor: (bootAt: number) => number, restartEveryMs: number, spanMs: number): number | null {
  for (let bootAt = T0; bootAt < T0 + spanMs; bootAt += restartEveryMs) {
    const firesAt = bootAt + delayFor(bootAt);
    if (firesAt < bootAt + restartEveryMs) return firesAt - T0; // fired before the next restart
  }
  return null;
}

describe('D-Q5a: daily first-run delay — unchanged whenever a stamp exists or no first-seen time is given', () => {
  it('stamp present and overdue → runs at start (the D3 fix, unchanged)', () => {
    expect(firstRunDelayFromStamp(String(T0 - 2 * DAY), DAY, T0)).toBe(0);
  });

  it('stamp present, ran 20 h ago → waits the remaining 4 h', () => {
    expect(firstRunDelayFromStamp(String(T0 - 20 * HOUR), DAY, T0)).toBe(4 * HOUR);
  });

  it.each([[null], [undefined], [''], ['not-a-number'], [String(T0 + HOUR)]])('stamp %p and no first-seen → one full interval', (stamp) => {
    expect(firstRunDelayFromStamp(stamp as string | null | undefined, DAY, T0)).toBe(DAY);
  });

  it('without a first-seen time (Redis unreadable at boot) the pre-fix behaviour is kept: 6-hourly restarts never fire', () => {
    const firesAt = simulateBootsAfterWipe((bootAt) => firstRunDelayFromStamp(undefined, DAY, bootAt), 6 * HOUR, 3 * DAY);
    expect(firesAt).toBeNull();
  });
});

describe('D-Q5a: after a stamp is lost, a daily scan is delayed at most one interval from the first boot that saw it missing', () => {
  it('no stamp, first seen 23 h ago → runs in 1 h', () => {
    expect(firstRunDelayFromStamp(undefined, DAY, T0, T0 - 23 * HOUR)).toBe(HOUR);
  });

  it('no stamp, first seen 3 days ago → runs at start (clamped to 0)', () => {
    expect(firstRunDelayFromStamp(undefined, DAY, T0, T0 - 3 * DAY)).toBe(0);
  });

  it('no stamp, first seen just now (the first boot after the wipe) → one full interval, exactly as before', () => {
    expect(firstRunDelayFromStamp(undefined, DAY, T0, T0)).toBe(DAY);
  });

  it('restarts every 6 h after a wipe: the scan fires within one interval of the first boot', () => {
    const firesAt = simulateBootsAfterWipe((bootAt) => firstRunDelayFromStamp(undefined, DAY, bootAt, T0), 6 * HOUR, 3 * DAY);
    expect(firesAt).not.toBeNull();
    expect(firesAt!).toBeLessThanOrEqual(DAY);
  });

  it('restarts every 5 min after a wipe: still fires by first boot + one interval', () => {
    const firesAt = simulateBootsAfterWipe((bootAt) => firstRunDelayFromStamp(undefined, DAY, bootAt, T0), 5 * 60_000, 3 * DAY);
    expect(firesAt).not.toBeNull();
    expect(firesAt!).toBeLessThanOrEqual(DAY);
  });

  it.each([
    ['a real stamp (20 h ago) wins over an older first-seen', String(T0 - 20 * HOUR), T0 - 23 * HOUR, 4 * HOUR],
    ['a real stamp (overdue) wins over a recent first-seen', String(T0 - 2 * DAY), T0 - HOUR, 0],
    ['an unparsable stamp is NOT replaced by first-seen (only a missing stamp is) → one full interval', 'garbage', T0 - 23 * HOUR, DAY],
    ['a stamp in the future is NOT replaced by first-seen → one full interval', String(T0 + HOUR), T0 - 23 * HOUR, DAY],
  ])('%s', (_label, stamp, firstSeen, expected) => {
    expect(firstRunDelayFromStamp(stamp, DAY, T0, firstSeen)).toBe(expected);
  });

  it.each([
    ['in the future (another replica\'s clock ahead)', T0 + HOUR],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('NEGATIVE: a first-seen time %s is ignored → one full interval (never an early run)', (_label, firstSeen) => {
    expect(firstRunDelayFromStamp(undefined, DAY, T0, firstSeen)).toBe(DAY);
  });
});
