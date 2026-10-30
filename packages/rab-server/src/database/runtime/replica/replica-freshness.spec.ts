import { parseLsn, ReplicaFreshness } from './replica-freshness';

describe('replica freshness (B4, WAL positions)', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('parses pg_lsn text and orders positions across the 32-bit boundary; garbage is unknown', () => {
    expect(parseLsn('0/16B3748')).toBe(0x16b3748n);
    expect(parseLsn('1/0')! > parseLsn('0/FFFFFFFF')!).toBe(true);
    expect(parseLsn('16/B374D848')).toBe((0x16n << 32n) | 0xb374d848n);
    expect(parseLsn(null)).toBeNull();
    expect(parseLsn('nope')).toBeNull();
  });

  it('a replica that has replayed the sampled primary position is fresh for maxLag after the sample', () => {
    const f = new ReplicaFreshness(5_000, clock);
    expect(f.isFresh()).toBe(false); // nothing measured yet
    f.recordPrimarySample(100n, now);
    f.recordReplay(100n);
    expect(f.isFresh()).toBe(true);
    expect(f.lagEstimateMs()).toBe(0);
    now += 4_999;
    expect(f.isFresh()).toBe(true);
    now += 1;
    expect(f.isFresh()).toBe(false);
  });

  it('an IDLE caught-up replica stays fresh: equal LSNs on every probe, however old the last replayed transaction is', () => {
    const f = new ReplicaFreshness(5_000, clock);
    for (let i = 0; i < 100; i += 1) {
      f.recordPrimarySample(500n, now); // the primary wrote nothing for 100 probes
      f.recordReplay(500n);
      expect(f.isFresh()).toBe(true);
      now += 1_250;
    }
  });

  it('a paused/lagging replica turns stale maxLag after the newest sample it reached, and the lag estimate grows', () => {
    const f = new ReplicaFreshness(5_000, clock);
    f.recordPrimarySample(100n, now);
    f.recordReplay(100n);
    const reachedAt = now;
    for (let lsn = 200n; lsn <= 1_000n; lsn += 100n) {
      now += 1_000;
      f.recordPrimarySample(lsn, now);
      f.recordReplay(100n); // replay paused at 100
    }
    expect(now - reachedAt).toBe(9_000);
    expect(f.isFresh()).toBe(false);
    expect(f.lagEstimateMs()).toBe(8_000); // oldest unreached sample (200) is 8 s old
    now += 1_000;
    f.recordPrimarySample(1_100n, now);
    f.recordReplay(1_100n); // caught up again
    expect(f.isFresh()).toBe(true);
    expect(f.lagEstimateMs()).toBe(0);
  });

  it('a replica slightly behind is still fresh when it reached a sample taken within maxLag', () => {
    const f = new ReplicaFreshness(5_000, clock);
    f.recordPrimarySample(100n, now);
    now += 1_000;
    f.recordPrimarySample(200n, now);
    f.recordReplay(150n); // reached the first sample (1 s ago) but not the second
    expect(f.isFresh()).toBe(true);
    now += 4_000; // first sample is now exactly maxLag old
    expect(f.isFresh()).toBe(false);
  });

  it('unknown replay or a failed measurement is never fresh', () => {
    const f = new ReplicaFreshness(5_000, clock);
    f.recordPrimarySample(100n, now);
    f.recordReplay(null);
    expect(f.isFresh()).toBe(false);
    f.recordReplay(100n);
    expect(f.isFresh()).toBe(true);
    f.markUnknown();
    expect(f.isFresh()).toBe(false);
    expect(f.lagEstimateMs()).toBeNull();
  });
});
