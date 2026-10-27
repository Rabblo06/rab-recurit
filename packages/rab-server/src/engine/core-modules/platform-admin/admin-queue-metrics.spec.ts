import { Metrics } from 'bullmq';

import { bucketQueueMetrics, METRICS_RANGE_SPEC } from './admin-queues.service';

/**
 * Admin panel follow-up — Health chart bucketing of BullMQ metrics (pure function; the Redis path is covered by
 * admin-panel-followup.integration.spec.ts with a real Worker). BullMQ's layout (collectMetrics.lua): jobs finished since
 * the last flush are in `meta.count - meta.prevCount` (prevTS's minute); `data[i]` is the minute `i + 1` before it.
 */
const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 12, 34, 56); // 12:34:56Z
const metrics = (prevTS: number, count: number, prevCount: number, data: number[]): Metrics => ({ meta: { count, prevTS, prevCount }, data, count: data.length });

describe('bucketQueueMetrics', () => {
  it('ranges have fixed bucket counts (1H per minute; 4H/12H/1D/7D per hour) ending with the current bucket', () => {
    const counts = Object.fromEntries(Object.keys(METRICS_RANGE_SPEC).map((r) => [r, bucketQueueMetrics('q', r as never, null, null, NOW).buckets.length]));
    expect(counts).toEqual({ '1H': 60, '4H': 4, '12H': 12, '1D': 24, '7D': 168 });
    const day = bucketQueueMetrics('q', '1D', null, null, NOW);
    expect(day.buckets[23]!.at).toBe('2026-10-25T12:00:00.000Z');
    expect(day.buckets[0]!.at).toBe('2026-10-24T13:00:00.000Z');
    expect(day.to).toBe('2026-10-25T13:00:00.000Z');
    const hour = bucketQueueMetrics('q', '1H', null, null, NOW);
    expect(hour.buckets[59]!.at).toBe('2026-10-25T12:34:00.000Z');
    expect(hour.bucketMinutes).toBe(1);
  });

  it('never recorded → available false / NO_DATA, all zeros (never synthesised)', () => {
    const none = bucketQueueMetrics('q', '1D', metrics(0, 0, 0, []), metrics(0, 0, 0, []), NOW);
    expect(none).toMatchObject({ available: false, reason: 'NO_DATA', totals: { completed: 0, failed: 0 } });
    expect(none.buckets.every((b) => b.completed === 0 && b.failed === 0)).toBe(true);
  });

  it('places pending (meta) and list points by minute; per-hour sums; outside the range dropped', () => {
    const prevTS = NOW - 2 * MIN; // flushed at 12:32:56
    // pending 4 → 12:32; data[0] = 12:31 (5), data[1] = 12:30 (0), data[2] = 12:29 (7); data[60] = 11:31 (2)
    const data = Array.from({ length: 61 }, (_, i) => (i === 0 ? 5 : i === 2 ? 7 : i === 60 ? 2 : 0));
    const completed = metrics(prevTS, 20, 16, data);
    const failed = metrics(prevTS, 3, 1, [1]); // pending 2 → 12:32, data[0] = 12:31 (1)
    const hour = bucketQueueMetrics('rab-email', '1H', completed, failed, NOW);
    const at = (iso: string) => hour.buckets.find((b) => b.at === iso)!;
    expect(at('2026-10-25T12:32:00.000Z')).toEqual({ at: '2026-10-25T12:32:00.000Z', completed: 4, failed: 2 });
    expect(at('2026-10-25T12:31:00.000Z')).toMatchObject({ completed: 5, failed: 1 });
    expect(at('2026-10-25T12:29:00.000Z')).toMatchObject({ completed: 7, failed: 0 });
    expect(hour.buckets.find((b) => b.at === '2026-10-25T11:31:00.000Z')).toBeUndefined(); // 11:31 is outside the last 60 minutes
    expect(hour.totals).toEqual({ completed: 16, failed: 3 });
    expect(hour).toMatchObject({ available: true, reason: null });
    const day = bucketQueueMetrics('rab-email', '1D', completed, failed, NOW);
    expect(day.buckets[23]).toMatchObject({ completed: 16, failed: 3 }); // 12:xx
    expect(day.buckets[22]).toMatchObject({ completed: 2, failed: 0 }); // 11:31
    expect(day.totals).toEqual({ completed: 18, failed: 3 });
  });

  it('ignores negative / non-numeric points and a negative pending delta', () => {
    const odd = metrics(NOW - MIN, 1, 5, [-3, Number.NaN as unknown as number, 2]);
    const r = bucketQueueMetrics('q', '1H', odd, null, NOW);
    expect(r.totals).toEqual({ completed: 2, failed: 0 });
  });
});
