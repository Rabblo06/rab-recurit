import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AiUsageView } from '@rab/shared';

import { aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { formatMicroUsd, formatTokens } from '../../ai/AiComposerControls';
import { aiSettingsApi } from './aiSettingsApi';

/** Meter tone at 80 % / 100 % (P7-D7-6, `AI_BUDGET_ALERT_PERCENT`). */
export function meterTone(pct: number): 'ok' | 'warn' | 'bad' {
  return pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
}

function Meter({ label, used, ceiling, text }: { label: string; used: number; ceiling: number; text: string }) {
  const pct = ceiling > 0 ? Math.min(100, Math.floor((used * 100) / ceiling)) : 0;
  return (
    <div className="ai-usage-card" data-tone={meterTone(pct)}>
      <span className="ai-usage-card-label">{label}</span>
      <strong>{text}</strong>
      <span className="ai-usage-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% of today’s limit`}><i style={{ width: `${pct}%` }} /></span>
    </div>
  );
}

/**
 * Settings → AI → Usage (Phase 7 API `AiUsageView`; rendered only when `features.usage`). Metadata only — turns, tokens,
 * cached share, ESTIMATED cost in integer micro-USD (formatted by integer division) — never a question or an answer.
 * Per-person rows are workplace monitoring data shown to the CEO only and audited server-side (D8-5).
 */
export default function AiUsageTab() {
  const { scope } = useAiChat();
  const [period, setPeriod] = useState<'today' | 'month'>('today');
  const usage = useQuery({ queryKey: [...aiKeys.settingsArea(scope, 'usage'), period], queryFn: () => aiSettingsApi.usage(period), retry: false });
  return (
    <>
      <section className="settings-section" aria-labelledby="ai-usage-title">
        <div className="ai-set-headrow">
          <div>
            <h3 id="ai-usage-title">Usage</h3>
            <p>How much your organisation used the assistant. Estimated from list prices; not an invoice. Limits are set by the platform.</p>
          </div>
          <div className="ai-segmented" role="radiogroup" aria-label="Period">
            {(['today', 'month'] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>{p === 'today' ? 'Today' : 'This month'}</button>
            ))}
          </div>
        </div>
        {usage.isLoading ? <p className="ai-set-muted" role="status">Loading usage…</p> : usage.isError || !usage.data ? <p className="ai-set-notice" role="alert">Usage could not be loaded. Refresh the page to try again.</p> : <UsageBody view={usage.data} />}
      </section>
    </>
  );
}

export function UsageBody({ view }: { view: AiUsageView }) {
  const cachedShare = view.totals.inputTokens > 0 ? Math.floor((view.totals.cachedInputTokens * 100) / view.totals.inputTokens) : 0;
  return (
    <>
      <div className="ai-usage-cards">
        <Meter label="Estimated cost today" used={view.today.orgCostMicros} ceiling={view.budgets.orgDailyCostCeilingMicros} text={`${formatMicroUsd(view.today.orgCostMicros)} of ${formatMicroUsd(view.budgets.orgDailyCostCeilingMicros)}`} />
        <Meter label="Tokens today" used={view.today.orgTokensUsedOrReserved} ceiling={view.budgets.orgDailyTokenBudget} text={`${formatTokens(view.today.orgTokensUsedOrReserved)} of ${formatTokens(view.budgets.orgDailyTokenBudget)}`} />
        <div className="ai-usage-card">
          <span className="ai-usage-card-label">{view.period === 'today' ? 'Today' : 'This month'}</span>
          <strong>{`${view.totals.turns.toLocaleString('en-GB')} questions · ${formatMicroUsd(view.totals.costUsdMicros)}`}</strong>
          <span className="ai-set-muted">{`Cached input ${cachedShare}%`}</span>
        </div>
      </div>
      {view.today.alerts.length > 0 && <p className="ai-set-notice" role="note">Today’s use has passed 80% of the {view.today.alerts.map((a) => (a === 'cost' ? 'cost' : 'token')).join(' and ')} limit.</p>}
      <h4 className="ai-set-subhead">By person</h4>
      <p className="ai-set-muted">Counts and estimated cost only. The content of questions is never shown here.</p>
      {view.byUser.length ? (
        <div className="table-container">
          <table className="table ai-set-table">
            <caption className="visually-hidden">Usage by person</caption>
            <thead><tr><th scope="col">Person</th><th scope="col">Questions</th><th scope="col">Tokens</th><th scope="col">Cached</th><th scope="col">Est. cost</th><th scope="col">Today’s allowance</th></tr></thead>
            <tbody>
              {view.byUser.map((u) => {
                const pct = view.budgets.userDailyCostCeilingMicros > 0 ? Math.min(100, Math.floor((u.userCostTodayMicros * 100) / view.budgets.userDailyCostCeilingMicros)) : 0;
                return (
                  <tr key={u.userId}>
                    <td>{u.displayName}</td>
                    <td>{u.turns.toLocaleString('en-GB')}</td>
                    <td>{formatTokens(u.inputTokens + u.outputTokens)}</td>
                    <td>{formatTokens(u.cachedInputTokens)}</td>
                    <td>{formatMicroUsd(u.costUsdMicros)}</td>
                    <td><span className="ai-usage-pct" data-tone={meterTone(pct)}>{`${pct}%`}</span></td>
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
            <thead><tr><th scope="col">Model</th><th scope="col">Questions</th><th scope="col">Input</th><th scope="col">Cached</th><th scope="col">Output</th><th scope="col">Est. cost</th></tr></thead>
            <tbody>
              {view.byModel.map((m) => (
                <tr key={m.modelId}>
                  <td>{m.label}</td>
                  <td>{m.turns.toLocaleString('en-GB')}</td>
                  <td>{formatTokens(m.inputTokens)}</td>
                  <td>{formatTokens(m.cachedInputTokens)}</td>
                  <td>{formatTokens(m.outputTokens)}</td>
                  <td>{formatMicroUsd(m.costUsdMicros)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ai-set-muted">No questions in this period.</p>
      )}
    </>
  );
}
