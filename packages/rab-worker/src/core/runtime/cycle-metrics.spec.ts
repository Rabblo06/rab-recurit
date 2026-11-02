import { CycleMetrics } from './cycle-metrics';

/**
 * Phase D wave 2 — OD-1: per-loop counters in the existing cycle metrics (the summary written to
 * rab:worker:cycle-durations and logged every 15 min). Counter names are fixed in code; values are counts only.
 */
describe('CycleMetrics counters (OD-1 repeated-claim visibility)', () => {
  it('increment adds a cumulative counter to the loop summary and marks it dirty for the next flush', () => {
    const metrics = new CycleMetrics();
    metrics.record('email-dispatch', 'succeeded', 5);
    metrics.takeDirty();
    metrics.increment('email-dispatch', 'claimsRepeated', 3);
    metrics.increment('email-dispatch', 'claimsRepeated', 2);
    metrics.increment('email-dispatch', 'claimsOver20', 1);
    const dirty = metrics.takeDirty();
    expect(dirty.map(([k]) => k)).toEqual(['email-dispatch']);
    expect(metrics.summary('email-dispatch')).toMatchObject({ succeeded: 1, counters: { claimsRepeated: 5, claimsOver20: 1 } });
  });

  it('a loop that never counted anything has NO counters key (the existing summary shape is unchanged)', () => {
    const metrics = new CycleMetrics();
    metrics.record('shift-monitor', 'idle', 3);
    expect(Object.keys(metrics.summary('shift-monitor')!)).not.toContain('counters');
  });

  it('a zero / negative / non-finite increment is ignored', () => {
    const metrics = new CycleMetrics();
    metrics.increment('push-dispatch', 'claimsRepeated', 0);
    metrics.increment('push-dispatch', 'claimsRepeated', -1);
    metrics.increment('push-dispatch', 'claimsRepeated', Number.NaN);
    expect(metrics.summary('push-dispatch')).toBeNull();
  });
});
