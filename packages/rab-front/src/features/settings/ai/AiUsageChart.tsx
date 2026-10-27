import { useId, useState, type KeyboardEvent } from 'react';

import { formatMicroUsd, formatTokens } from '../../ai/AiComposerControls';
import type { AiUsageDailyPoint } from './aiSettingsApi';

const dayDate = (day: string) => new Date(`${day}T00:00:00Z`);
/** "26 Oct" (UTC: the series is UTC days, like the budget meters). */
export const shortDay = (day: string) => dayDate(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = (day: string) => dayDate(day).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Only well-formed points are drawn (a malformed server value is skipped, never guessed). */
export function validDaily(value: unknown): AiUsageDailyPoint[] | null {
  if (!Array.isArray(value)) return null;
  const ok = value.filter(
    (p): p is AiUsageDailyPoint =>
      !!p && typeof p === 'object' && typeof (p as AiUsageDailyPoint).day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test((p as AiUsageDailyPoint).day) &&
      [(p as AiUsageDailyPoint).turns, (p as AiUsageDailyPoint).inputTokens, (p as AiUsageDailyPoint).outputTokens, (p as AiUsageDailyPoint).costUsdMicros].every((n) => Number.isSafeInteger(n) && n >= 0),
  );
  return ok.length ? ok : null;
}

/**
 * U7 "Last 14 days" (settings mockup; S8 contract `AiUsageView.daily`): the organisation's daily ESTIMATED cost (USD,
 * integer micro-USD, formatted by integer division) as one bar series against the organisation's daily budget (a dashed
 * reference line). Organisation totals only — the server sends no per-person series. One series, so no legend box: the
 * heading names it. Hover a bar, or focus the chart and use ←/→ (Home/End), to read a day; Esc closes the reading. A
 * table view carries the same numbers for screen readers and for anyone who prefers it.
 */
export default function AiUsageChart({ points, budgetMicros }: { points: AiUsageDailyPoint[]; budgetMicros: number }) {
  const [active, setActive] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const tipId = useId();
  const tableId = useId();
  const top = Math.max(budgetMicros, ...points.map((p) => p.costUsdMicros), 1);
  const pct = (micros: number) => (micros * 100) / top;
  const total = points.reduce((t, p) => t + p.costUsdMicros, 0);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = points.length;
    const cur = active ?? n - 1;
    const next = e.key === 'ArrowRight' ? Math.min(n - 1, active === null ? n - 1 : cur + 1) : e.key === 'ArrowLeft' ? Math.max(0, active === null ? n - 1 : cur - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (e.key === 'Escape' && active !== null) {
      e.preventDefault();
      setActive(null);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };
  const a = active !== null ? points[active] : null;
  return (
    <div className="ai-usage-chart-wrap">
      <div
        className="ai-usage-chart"
        tabIndex={0}
        role="group"
        aria-label={`Daily estimated cost, ${shortDay(first.day)} to ${shortDay(last.day)}: ${formatMicroUsd(total)} in total. Use the left and right arrow keys to read each day.`}
        aria-describedby={a ? tipId : undefined}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        onMouseLeave={() => setActive(null)}
      >
        <div className="ai-usage-plot">
          {budgetMicros > 0 && (
            <div className="ai-usage-limit" style={{ bottom: `${pct(budgetMicros)}%` }} aria-hidden="true">
              <span>{`${formatMicroUsd(budgetMicros)} daily budget`}</span>
            </div>
          )}
          {points.map((p, i) => (
            <div key={p.day} className="ai-usage-col" data-active={active === i || undefined} onMouseEnter={() => setActive(i)} aria-hidden="true">
              <i className="ai-usage-barv" style={{ height: `${pct(p.costUsdMicros)}%` }} data-zero={p.costUsdMicros === 0 || undefined} />
            </div>
          ))}
          {a && (
            <div id={tipId} className="ai-usage-tip" role="status" style={{ left: `${((active! + 0.5) * 100) / points.length}%` }}>
              <strong>{longDay(a.day)}</strong>
              <span>{`${formatMicroUsd(a.costUsdMicros)} · ${a.turns.toLocaleString('en-GB')} messages · ${formatTokens(a.inputTokens + a.outputTokens)} tokens`}</span>
            </div>
          )}
        </div>
        <div className="ai-usage-axis" aria-hidden="true"><span>{shortDay(first.day)}</span><span>{shortDay(last.day)}</span></div>
      </div>
      <div className="ai-set-actions">
        <button type="button" className="btn btn-outline btn-sm" aria-expanded={table} aria-controls={tableId} onClick={() => setTable((v) => !v)}>{table ? 'Hide table' : 'Show as table'}</button>
        <span className="ai-set-muted">UTC days · estimated from list prices; not an invoice</span>
      </div>
      <div id={tableId} hidden={!table} className="table-container">
        <table className="table ai-set-table">
          <caption className="visually-hidden">Daily usage, last 14 days</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">Messages</th><th scope="col">Tokens</th><th scope="col">Est. cost</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day}><td>{longDay(p.day)}</td><td>{p.turns.toLocaleString('en-GB')}</td><td>{formatTokens(p.inputTokens + p.outputTokens)}</td><td>{formatMicroUsd(p.costUsdMicros)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
