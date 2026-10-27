import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { formatMicroUsd, formatTokens } from '../../ai/AiComposerControls';
import { NotAvailableYet } from './AiReasonDialog';
import AiUsageChart, { validDaily } from './AiUsageChart';
import { aiSettingsApi, type AiUsageViewWithDaily } from './aiSettingsApi';

/** Meter tone at 80 % / 100 % (P7-D7-6, `AI_BUDGET_ALERT_PERCENT`). */
export function meterTone(pct: number): 'ok' | 'warn' | 'bad' {
  return pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
}
const pctOf = (used: number, ceiling: number) => (ceiling > 0 ? Math.min(100, Math.floor((used * 100) / ceiling)) : 0);

/** Provisional owner decision (2026-10-26): the CEO sees each person's USD cost. Labelled as provisional on screen. */
export const PER_PERSON_NOTE = 'Each person’s estimated cost is shown to the CEO only. This is a provisional owner decision (26 Oct 2026) and may change.';

/**
 * Settings → AI → Usage (Phase 7 `GET /ai/settings/usage`, 7b ledger; U7 settings mockup; rendered only when
 * `features.usage`). Real numbers only: the stat box reads today's live meters and the month's ledger totals; "Last 14
 * days" draws the S8 `daily` series and says "Not available yet" while the server doesn't send it (never a made-up
 * series). Metadata only — messages (= turns), tokens, cached share and ESTIMATED cost in integer micro-USD formatted by
 * integer division, US dollars only (AI cost is never mixed with payroll money). Per-person rows are monitoring data
 * shown to the CEO only and audited server-side (D8-5). Each fetch is audited (`ai.usage_viewed`).
 */
export default function AiUsageTab() {
  const { scope } = useAiChat();
  const [period, setPeriod] = useState<'month' | 'today'>('month');
  const month = useQuery({ queryKey: [...aiKeys.settingsArea(scope, 'usage'), 'month'], queryFn: () => aiSettingsApi.usage('month'), retry: false });
  const today = useQuery({ queryKey: [...aiKeys.settingsArea(scope, 'usage'), 'today'], queryFn: () => aiSettingsApi.usage('today'), retry: false });
  const loading = month.isLoading || today.isLoading;
  const failed = month.isError || today.isError || (!loading && (!month.data || !today.data));
  return (
    <>
      <section className="settings-section" aria-labelledby="ai-usage-title">
        <h3 id="ai-usage-title">Usage</h3>
        <p>Cost of AI in your organisation, from the per-step meter. Estimated from list prices in US dollars; not an invoice. Limits are set by the platform.</p>
        {loading ? (
          <p className="ai-set-muted" role="status">Loading usage…</p>
        ) : failed ? (
          <p className="ai-set-notice" role="alert">Usage could not be loaded. Refresh the page to try again.</p>
        ) : (
          <UsageSummary month={month.data!} today={today.data!} />
        )}
      </section>
      {!loading && !failed && (
        <>
          <section className="settings-section" aria-labelledby="ai-usage-days">
            <h3 id="ai-usage-days">Last 14 days</h3>
            <p>Daily cost against the organisation’s daily budget.</p>
            <DailySection month={month.data!} today={today.data!} />
          </section>
          <section className="settings-section" aria-labelledby="ai-usage-people">
            <div className="ai-set-headrow">
              <h3 id="ai-usage-people">By person and model</h3>
              <div className="ai-segmented" role="radiogroup" aria-label="Period">
                {(['month', 'today'] as const).map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={period === p} tabIndex={period === p ? 0 : -1} onClick={() => setPeriod(p)} onKeyDown={(e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setPeriod(period === 'month' ? 'today' : 'month'); } }}>
                    {p === 'today' ? 'Today' : 'This month'}
                  </button>
                ))}
              </div>
            </div>
            <UsageBody view={period === 'month' ? month.data! : today.data!} />
          </section>
        </>
      )}
    </>
  );
}

/** The mockup's stat box: Today (live meter vs the org's daily budget) · This month (ledger) · Messages today. */
export function UsageSummary({ month, today }: { month: AiUsageViewWithDaily; today: AiUsageViewWithDaily }) {
  const live = today.today;
  const b = today.budgets;
  const costPct = pctOf(live.orgCostMicros, b.orgDailyCostCeilingMicros);
  const tokenPct = pctOf(live.orgTokensUsedOrReserved, b.orgDailyTokenBudget);
  return (
    <>
      <dl className="ai-usage-stat">
        <div data-tone={meterTone(costPct)}>
          <dt>Today</dt>
          <dd>{`${formatMicroUsd(live.orgCostMicros)} / ${formatMicroUsd(b.orgDailyCostCeilingMicros)}`}</dd>
          <span className="ai-usage-bar" role="meter" aria-label="Estimated cost today" aria-valuemin={0} aria-valuemax={100} aria-valuenow={costPct} aria-valuetext={`${costPct}% of today’s budget`}><i style={{ width: `${costPct}%` }} /></span>
        </div>
        <div>
          <dt>This month</dt>
          <dd>{formatMicroUsd(month.totals.costUsdMicros)}</dd>
        </div>
        <div>
          <dt>Messages today</dt>
          <dd>{today.totals.turns.toLocaleString('en-GB')}</dd>
        </div>
      </dl>
      <p className="ai-set-muted ai-usage-tokens" data-tone={meterTone(tokenPct)}>
        {`Tokens today: ${formatTokens(live.orgTokensUsedOrReserved)} of ${formatTokens(b.orgDailyTokenBudget)} (${tokenPct}%) · cached input this month: ${month.totals.inputTokens > 0 ? Math.floor((month.totals.cachedInputTokens * 100) / month.totals.inputTokens) : 0}%`}
      </p>
      {live.alerts.length > 0 && <p className="ai-set-notice" role="note">Today’s use has passed 80% of the {live.alerts.map((a) => (a === 'cost' ? 'cost' : 'token')).join(' and ')} limit.</p>}
    </>
  );
}

function DailySection({ month, today }: { month: AiUsageViewWithDaily; today: AiUsageViewWithDaily }) {
  const points = validDaily(month.daily) ?? validDaily(today.daily);
  if (!points) return <NotAvailableYet>The daily series arrives with the next server update; no estimate is drawn in its place.</NotAvailableYet>;
  return <AiUsageChart points={points} budgetMicros={month.budgets.orgDailyCostCeilingMicros} />;
}

export function UsageBody({ view }: { view: AiUsageViewWithDaily }) {
  const ceiling = view.budgets.userDailyCostCeilingMicros;
  const costLabel = view.period === 'today' ? 'Cost (today)' : 'Cost (month)';
  return (
    <>
      <h4 className="ai-set-subhead">By person</h4>
      <p className="ai-set-muted">Counts and estimated cost only. The content of questions is never shown here. {PER_PERSON_NOTE}</p>
      {view.byUser.length ? (
        <div className="table-container">
          <table className="table ai-set-table">
            <caption className="visually-hidden">Usage by person</caption>
            <thead><tr><th scope="col">Person</th><th scope="col" className="ai-num">Messages</th><th scope="col" className="ai-num">Tokens</th><th scope="col" className="ai-num">{costLabel}</th><th scope="col" className="ai-num">Today vs limit</th></tr></thead>
            <tbody>
              {view.byUser.map((u) => {
                const pct = pctOf(u.userCostTodayMicros, ceiling);
                return (
                  <tr key={u.userId}>
                    <td>{u.displayName}</td>
                    <td className="ai-num">{u.turns.toLocaleString('en-GB')}</td>
                    <td className="ai-num">{formatTokens(u.inputTokens + u.outputTokens)}</td>
                    <td className="ai-num">{formatMicroUsd(u.costUsdMicros)}</td>
                    <td className="ai-num">
                      <span className="ai-usage-pct" data-tone={meterTone(pct)} title={`${pct}% of today’s per-person limit`}>
                        {`${formatMicroUsd(u.userCostTodayMicros)} / ${formatMicroUsd(ceiling)}`}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ai-set-muted">No questions in this period.</p>
      )}
      <h4 className="ai-set-subhead">By model</h4>
      {view.byModel.length ? (
        <div className="table-container">
          <table className="table ai-set-table">
            <caption className="visually-hidden">Usage by model</caption>
            <thead><tr><th scope="col">Model</th><th scope="col" className="ai-num">Messages</th><th scope="col" className="ai-num">Input</th><th scope="col" className="ai-num">Cached input</th><th scope="col" className="ai-num">Output</th><th scope="col" className="ai-num">Cost</th></tr></thead>
            <tbody>
              {view.byModel.map((m) => (
                <tr key={m.modelId}>
                  <td>{m.label}</td>
                  <td className="ai-num">{m.turns.toLocaleString('en-GB')}</td>
                  <td className="ai-num">{formatTokens(m.inputTokens)}</td>
                  <td className="ai-num">{formatTokens(m.cachedInputTokens)}</td>
                  <td className="ai-num">{formatTokens(m.outputTokens)}</td>
                  <td className="ai-num">{formatMicroUsd(m.costUsdMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ai-set-muted">No questions in this period.</p>
      )}
      <p className="ai-set-pending" role="note">Budgets: a daily budget per organisation and a daily limit per person. When a budget runs out the answer stops cleanly with a message. If the meter fails, AI is refused.</p>
    </>
  );
}
