import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { metricsSummary, type MetricsRange, type QueueMetrics } from './adminPanelApi';

const TICK = { fontSize: 11, fill: 'var(--font-tertiary)' };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Axis label for one bucket start (local time, like the mockup's "09:00"). */
export function bucketLabel(iso: string, range: MetricsRange): string {
  const d = new Date(iso);
  if (range === '7D') return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Every n-th bucket gets a label (the mockup labels every 4th hour of a day). */
const TICK_EVERY: Record<MetricsRange, number> = { '1H': 10, '4H': 1, '12H': 2, '1D': 4, '7D': 24 };

/**
 * Completed vs failed jobs per bucket (mockup v2 `drawChart`: stacked bars, completed `--chart-3`, failed
 * `--feedback-error`, grid `--chart-4`, axis text `--font-tertiary`). Data = the server's buckets from BullMQ metrics,
 * drawn as they are — this component never computes or fills in numbers. The accessible name carries the summary.
 * Loaded lazily by HealthTab (recharts stays out of the Admin panel's first chunk).
 */
export default function QueueMetricsChart({ metrics }: { metrics: QueueMetrics }) {
  const every = TICK_EVERY[metrics.range];
  const data = metrics.buckets.map((b, i) => ({ ...b, label: bucketLabel(b.at, metrics.range), i }));
  return (
    <div className="ap-chart" role="img" aria-label={`${metrics.queue} completed and failed jobs, ${metricsSummary(metrics)}`}>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }} barCategoryGap="30%">
          <CartesianGrid vertical={false} stroke="var(--chart-4)" />
          <XAxis
            dataKey="i"
            tickLine={false}
            axisLine={false}
            tick={TICK}
            interval={0}
            tickFormatter={(i: number) => (i % every === 0 ? data[i]?.label ?? '' : '')}
          />
          <YAxis width={44} tickLine={false} axisLine={false} tick={TICK} allowDecimals={false} tickFormatter={(v: number) => v.toLocaleString('en-GB')} />
          <Tooltip
            cursor={{ fill: 'var(--bg-transparent-light)' }}
            labelFormatter={(i: number) => data[i]?.label ?? ''}
            formatter={(value: number, name: string) => [value.toLocaleString('en-GB'), name === 'completed' ? 'Completed' : 'Failed']}
            contentStyle={{ background: 'var(--bg-primary)', border: '1px solid var(--border-light)', borderRadius: 6, font: 'var(--text-small)' }}
          />
          <Bar dataKey="completed" stackId="jobs" fill="var(--chart-3)" isAnimationActive={false} />
          <Bar dataKey="failed" stackId="jobs" fill="var(--feedback-error)" radius={[1, 1, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
