import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_MODEL_STATE_LABEL, type AiModelView } from '@rab/shared';

import { toast } from '../../../shared/lib/toast';
import { pollingOptions, showsError } from '../../../shared/lib/polling';
import { formatMicroUsd } from '../../ai/AiComposerControls';
import AdminActionDialog from './AdminActionDialog';
import { ADMIN_ERROR_TEXT, adminApi, formatDateTime, type AiAdminOverview, type AiAdminUsageRow } from './adminPanelApi';

/**
 * Admin panel × AI Phase 1 (owner brief §13). METADATA only: switches, configuration facts, queue counts and usage
 * counters from `/rest/v1/admin/ai/*` (`AiAdminService.overview` / `usageSummary`). There is deliberately no admin
 * route for a conversation or a message, so nothing here can show a question, an answer, a prompt or a tool result;
 * each provider key is reported only as "Configured" / "Not configured" — never a value, a prefix or a length.
 *
 * AI Phase 1 "real models only": there is no platform-wide model any more. Each organisation's CEO picks a model in
 * Settings → AI from the models this list shows as Available; the list itself is read-only here.
 */

export const AI_OVERVIEW_KEY = ['admin', 'ai', 'overview'] as const;
const PERMISSION_LABEL: Record<string, string> = { 'schedule.view': 'Shifts (view)', 'attendance.view': 'Attendance (view)', 'payroll.view': 'Payroll (view)', 'venue.view': 'Venues (view)' };
const TOOL_LABEL: Record<string, string> = {
  list_unfilled_shifts: 'Unfilled shifts',
  get_fill_rate: 'Fill rate',
  get_attendance_summary: 'Attendance summary',
  get_offer_status: 'Offer status',
  compare_payroll_runs: 'Payroll run comparison',
};

const utcDay = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
const RANGES = [
  { id: 'today', label: 'Today', days: 0 },
  { id: '7d', label: '7 days', days: 6 },
  { id: '30d', label: '30 days', days: 29 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];
const n = (v: number | undefined) => (typeof v === 'number' ? v.toLocaleString('en-GB') : '—');
/** 7b cost: integer micro-USD by integer division (one formatter for all AI cost); absent → "—", never an estimate. */
const micros = (v: number | undefined) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? formatMicroUsd(v) : '—');
const ALERT_TEXT: Record<'cost' | 'tokens', string> = { cost: 'Cost 80 %', tokens: 'Tokens 80 %' };

/**
 * Phase C1: polled (15 s ±20 %) only by the Health tab (`{ poll: true }`); Config, Security and the organisation cards
 * read it when they mount (re-read on a later visit once the app's 30 s staleTime has passed), never on a timer.
 */
export function useAiOverview({ poll = false }: { poll?: boolean } = {}) {
  return useQuery({ queryKey: AI_OVERVIEW_KEY, queryFn: adminApi.aiOverview, ...(poll ? pollingOptions(15_000) : {}) });
}

// Tolerant of an older server that does not send these lists yet (the dev front can be ahead of the API): shown as empty.
const modelsOf = (o: AiAdminOverview): AiModelView[] => (Array.isArray(o.models) ? o.models : []);
const keysOf = (o: AiAdminOverview) => (Array.isArray(o.providerKeys) ? o.providerKeys : []);
const availableCount = (models: AiModelView[]) => models.filter((m) => m.state === 'available').length;
const configuredKeys = (o: AiAdminOverview) => keysOf(o).filter((k) => k.configured).length;
const usd = (v: number | null) => (v === null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`);

function OnOff({ on, onText = 'On', offText = 'Off', tone = 'ok' }: { on: boolean; onText?: string; offText?: string; tone?: 'ok' | 'warn' }) {
  return on ? <span className={`ap-pill ap-${tone}`}>{onText}</span> : <span className="ap-pill">{offText}</span>;
}

/** Health → AI: switch, available models, rab-ai queue, turns and per-organisation usage against the daily budget. */
export function AiHealthSection() {
  const overview = useAiOverview({ poll: true });
  const [range, setRange] = useState<RangeId>('today');
  const days = RANGES.find((r) => r.id === range)!.days;
  const from = utcDay(days);
  const to = utcDay();
  const usage = useQuery({ queryKey: ['admin', 'ai', 'usage', from, to], queryFn: () => adminApi.aiUsage(from, to), ...pollingOptions(30_000) });
  const o = overview.data;
  const rows = usage.data?.organisations ?? [];
  const totals = rows.reduce(
    (t, r) => ({ turns: t.turns + r.turns, failed: t.failed + r.failedTurns, cancelled: t.cancelled + r.cancelledTurns, tokens: t.tokens + r.inputTokens + r.outputTokens, cost: typeof r.costUsdMicros === 'number' && t.cost !== null ? t.cost + r.costUsdMicros : null }),
    { turns: 0, failed: 0, cancelled: 0, tokens: 0, cost: 0 as number | null },
  );
  const budget = o?.limits.orgDailyTokenBudget ?? 0;

  return (
    <section className="ap-block" aria-label="AI assistant health">
      <div className="ap-block-head">
        <h2 className="ap-h2">AI assistant</h2>
        <p className="ap-sub">Counts and settings only. Questions, answers and tool results are never shown here.</p>
      </div>
      {showsError(overview) ? (
        <p className="ap-callout ap-warn">The AI status could not be loaded.</p>
      ) : (
        <div className="ap-grid-3">
          <div className="ap-card ap-indicator">
            <b>AI (platform switch)</b>
            {o ? <OnOff on={o.platformEnabled} onText="Enabled" offText="Disabled" /> : <span className="ap-pill">Checking</span>}
            <p>{o ? (o.platformEnabled ? 'AI_ENABLED=true. Each organisation still needs its own switch on.' : 'AI_ENABLED=false: every AI route answers 404 and the Worker refuses turns.') : 'Loading…'}</p>
          </div>
          <div className="ap-card ap-indicator">
            <b>Models</b>
            {o ? (
              availableCount(modelsOf(o)) > 0 ? <span className="ap-pill ap-ok">{`${availableCount(modelsOf(o))} available`}</span> : <span className="ap-pill ap-bad">None available</span>
            ) : <span className="ap-pill">Checking</span>}
            <p>{o ? `${configuredKeys(o)} of ${keysOf(o).length} provider keys configured · ${modelsOf(o).length} models in the catalogue` : 'Loading…'}</p>
          </div>
          <div className="ap-card ap-indicator">
            <b>rab-ai queue</b>
            {o ? (o.queue.available ? <span className={`ap-pill ${o.queue.failed ? 'ap-warn' : 'ap-ok'}`}>{o.queue.failed ? `${o.queue.failed} failed` : 'Healthy'}</span> : <span className="ap-pill ap-bad">Unavailable</span>) : <span className="ap-pill">Checking</span>}
            <p>
              {o?.queue.available
                ? `Queued ${n(o.queue.waiting)} · running ${n(o.queue.active)} · delayed ${n(o.queue.delayed)} · completed ${n(o.queue.completed)}`
                : o ? 'The queue could not be reached (Redis).' : 'Loading…'}
            </p>
          </div>
        </div>
      )}

      <div className="ap-block-head" style={{ marginTop: 8 }}>
        <h3 className="ap-h3">Usage by organisation</h3>
        <div className="ap-seg" role="group" aria-label="AI usage range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
      </div>
      <p className="ap-sub" style={{ margin: 0 }}>
        UTC days {from === to ? from : `${from} to ${to}`} · {n(totals.turns)} turns · {n(totals.failed)} failed (model error, timeout, revoked access or interruption) · {n(totals.cancelled)} cancelled · {n(totals.tokens)} tokens
        {rows.length > 0 && totals.cost !== null ? ` · ${micros(totals.cost)} estimated cost` : ''}.
        {budget ? ` Daily budget per organisation: ${n(budget)} tokens${o?.limits.dailyBudgetUsd !== undefined ? ` and $${o.limits.dailyBudgetUsd} estimated cost` : ''}; amber from 80 %.` : ''}
        {o?.limits.userDailyBudgetUsd !== undefined ? ` Per-person daily limit: $${o.limits.userDailyBudgetUsd} estimated cost.` : ''}
      </p>
      <div className="ap-tablewrap">
        <table className="ap-table">
          <thead>
            <tr>
              <th>Organisation</th><th>AI</th><th className="ap-num">Turns</th><th className="ap-num">Failed</th><th className="ap-num">Cancelled</th><th className="ap-num">Tool calls</th><th className="ap-num">Input tokens</th><th className="ap-num">Cached input</th><th className="ap-num">Cache writes</th><th className="ap-num">Output tokens</th>
              <th className="ap-num">Est. cost (USD)</th>
              <th className="ap-num">{range === 'today' ? 'Of daily budget' : 'Avg / day'}</th>
              <th>Budget alerts today</th>
            </tr>
          </thead>
          <tbody>
            {usage.isLoading ? (
              <tr><td colSpan={13} className="ap-empty">Loading usage…</td></tr>
            ) : showsError(usage) ? (
              <tr><td colSpan={13} className="ap-empty">Usage could not be loaded.</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={13} className="ap-empty">No organisation has AI turned on or any AI usage in this range.</td></tr>
            ) : (
              rows.map((r) => <UsageRow key={r.organisationId} row={r} budget={budget} days={days + 1} today={range === 'today'} />)
            )}
          </tbody>
        </table>
      </div>
      <p className="ap-callout">
        Tokens are the provider-reported (or, for the test model, estimated) totals of finished turns. The live budget also counts reservations of answers in progress, so an organisation can be refused slightly before this table shows 100 %. A per-cause breakdown of failed turns is not recorded yet.
      </p>
    </section>
  );
}

function UsageRow({ row, budget, days, today }: { row: AiAdminUsageRow; budget: number; days: number; today: boolean }) {
  const tokens = row.inputTokens + row.outputTokens;
  const pct = budget ? Math.round((tokens / budget) * 100) : null;
  return (
    <tr>
      <td>{row.organisationName ?? '—'}</td>
      <td><OnOff on={row.aiEnabled} /></td>
      <td className="ap-num">{n(row.turns)}</td>
      <td className="ap-num">{row.failedTurns ? <span className="ap-pill ap-warn">{n(row.failedTurns)}</span> : '0'}</td>
      <td className="ap-num">{n(row.cancelledTurns)}</td>
      <td className="ap-num">{n(row.toolCalls)}</td>
      <td className="ap-num">{n(row.inputTokens)}</td>
      <td className="ap-num">{n(row.cachedInputTokens)}</td>
      <td className="ap-num">{n(row.cacheWriteTokens)}</td>
      <td className="ap-num">{n(row.outputTokens)}</td>
      <td className="ap-num">{micros(row.costUsdMicros)}</td>
      <td className="ap-num">
        {today ? (pct === null ? '—' : <span className={`ap-pill ${pct >= 100 ? 'ap-bad' : pct >= 80 ? 'ap-warn' : ''}`}>{pct} %</span>) : n(Math.round(tokens / days))}
      </td>
      <td>
        {row.budgetAlerts === undefined ? '—' : row.budgetAlerts.length ? row.budgetAlerts.filter((a) => a in ALERT_TEXT).map((a) => <span key={a} className="ap-pill ap-warn" style={{ marginRight: 4 }}>{ALERT_TEXT[a]}</span>) : <span className="ap-muted">None</span>}
      </td>
    </tr>
  );
}

/** Config → AI: readiness, default/disabled model lists, provider keys (configured yes/no), the model catalogue with states, limits and the tool catalogue. */
export function AiConfigSection() {
  const overview = useAiOverview();
  const { isLoading } = overview;
  const o = showsError(overview) ? undefined : overview.data;
  return (
    <section className="ap-block" aria-label="AI configuration">
      <div className="ap-block-head">
        <h2 className="ap-h2">AI assistant</h2>
        <p className="ap-sub">Read-only, from the server’s AI_* settings. Change them in OpenShip and redeploy.</p>
      </div>
      <div className="ap-card">
        {isLoading ? (
          <p className="ap-muted" style={{ margin: 0 }}>Loading…</p>
        ) : !o ? ( // a failed refresh keeps the last overview; a permanent refusal drops it (Phase C1)
          <p className="ap-muted" style={{ margin: 0 }}>The AI configuration is not available.</p>
        ) : (
          <div className="ap-grid-2">
            <dl className="ap-kv">
              <dt>Platform switch</dt><dd><OnOff on={o.platformEnabled} onText="Enabled" offText="Disabled" /></dd>
              {o.readiness ? (
                <>
                  <dt>AI readiness</dt>
                  <dd>
                    {o.readiness.ready ? <span className="ap-pill ap-ok">Ready</span> : <span className="ap-pill ap-bad">Unavailable</span>}
                    {o.readiness.problems.length > 0 ? (
                      <ul className="ap-muted" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {o.readiness.problems.map((p) => (
                          <li key={p.code}>{p.message}</li>
                        ))}
                      </ul>
                    ) : null}
                  </dd>
                  <dt>Real providers in this environment</dt>
                  <dd>{o.readiness.realProvidersPermitted ? <span className="ap-pill ap-info">Permitted</span> : <span className="ap-pill">Not permitted</span>}</dd>
                </>
              ) : null}
              {o.defaults ? (
                <>
                  <dt>Default fast models</dt><dd className="ap-mono">{o.defaults.fast.length ? o.defaults.fast.join(', ') : 'None (automatic)'}</dd>
                  <dt>Default smart models</dt><dd className="ap-mono">{o.defaults.smart.length ? o.defaults.smart.join(', ') : 'None (automatic)'}</dd>
                  <dt>Disabled models</dt><dd className="ap-mono">{o.defaults.disabled.length ? o.defaults.disabled.join(', ') : 'None'}</dd>
                </>
              ) : null}
            </dl>
            <dl className="ap-kv">
              <dt>Output tokens per step</dt><dd>{n(o.limits.maxOutputTokens)}</dd>
              <dt>Tool steps per answer</dt><dd>{n(o.limits.maxSteps)}</dd>
              <dt>Question length</dt><dd>{n(o.limits.maxInputChars)} characters</dd>
              <dt>Reservation per answer</dt><dd>{n(o.limits.turnTokenReservation)} tokens</dd>
              <dt>Daily budget per organisation</dt><dd>{n(o.limits.orgDailyTokenBudget)} tokens{o.limits.dailyBudgetUsd !== undefined ? ` · $${o.limits.dailyBudgetUsd} estimated cost` : ''}</dd>
              <dt>Daily limit per person</dt><dd>{o.limits.userDailyBudgetUsd !== undefined ? `$${o.limits.userDailyBudgetUsd} estimated cost` : '—'}</dd>
              <dt>Rate limit per user</dt><dd>{n(o.limits.userRatePerMinute)} questions / minute</dd>
              <dt>Answers in progress per organisation</dt><dd>{n(o.limits.orgMaxActiveTurns)}</dd>
              <dt>Answer timeout</dt><dd>{n(o.limits.turnTimeoutSeconds)} s</dd>
            </dl>
          </div>
        )}
      </div>
      {o && (
        <div className="ap-tablewrap">
          <table className="ap-table" aria-label="AI provider keys">
            <thead><tr><th>Provider</th><th>Key variable</th><th>Key</th><th>SDK in this build</th></tr></thead>
            <tbody>
              {keysOf(o).map((k) => (
                <tr key={k.provider}>
                  <td>{k.provider}</td>
                  <td className="ap-mono">{k.envName}</td>
                  <td>{k.configured ? <span className="ap-pill ap-ok">Configured</span> : <span className="ap-pill">Not configured</span>}</td>
                  <td>{k.sdkInstalled ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="ap-muted" style={{ margin: '6px 0 0' }}>A key is never shown, only whether it is set.</p>
        </div>
      )}
      {o && (
        <div className="ap-tablewrap">
          <table className="ap-table" aria-label="AI models">
            <thead><tr><th>Model</th><th>Provider</th><th>Tier</th><th className="ap-num">Input / 1M</th><th className="ap-num">Cached / 1M</th><th className="ap-num">Output / 1M</th><th>Region</th><th>State</th></tr></thead>
            <tbody>
              {modelsOf(o).map((m) => (
                <tr key={m.id}>
                  <td>{m.label} <span className="ap-muted ap-mono">{m.id}</span></td>
                  <td>{m.provider}</td>
                  <td>{m.tier}</td>
                  <td className="ap-num">{usd(m.priceUsdPerMTok.input)}</td>
                  <td className="ap-num">{usd(m.priceUsdPerMTok.cachedInput)}</td>
                  <td className="ap-num">{usd(m.priceUsdPerMTok.output)}</td>
                  <td title={m.dataRegion}>{m.region}</td>
                  <td><span className={`ap-pill ${m.state === 'available' ? 'ap-ok' : m.state === 'deprecated' ? 'ap-warn' : ''}`}>{m.stateLabel || AI_MODEL_STATE_LABEL[m.state]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {o && (
        <div className="ap-tablewrap">
          <table className="ap-table">
            <thead><tr><th>Read-only tool</th><th>Name</th><th>Needs permission</th><th className="ap-num">Max rows</th></tr></thead>
            <tbody>
              {o.tools.map((t) => (
                <tr key={t.name}>
                  <td>{TOOL_LABEL[t.name] ?? t.name}</td>
                  <td className="ap-mono">{t.name}</td>
                  <td>{PERMISSION_LABEL[t.permission] ?? <span className="ap-mono">{t.permission}</span>}</td>
                  <td className="ap-num">{n(t.maxRows)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const RETENTION_MODE: Record<string, string> = { off: 'Off: nothing is deleted or counted', report: 'Report: expired conversations are counted, not deleted', purge: 'Purge: expired conversations are deleted' };

/** Security → AI privacy: telemetry, retention, what administrators can and cannot see. */
export function AiPrivacySection() {
  const overview = useAiOverview();
  const { isLoading } = overview;
  const o = showsError(overview) ? undefined : overview.data;
  return (
    <section className="ap-block" aria-label="AI privacy">
      <div className="ap-block-head">
        <h2 className="ap-h2">AI privacy</h2>
        <p className="ap-sub">How the AI assistant handles data. Read-only.</p>
      </div>
      <div className="ap-tablewrap">
        <table className="ap-table">
          <thead><tr><th>Control</th><th>State</th><th>Detail</th></tr></thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={3} className="ap-empty">Loading…</td></tr>
            ) : !o ? ( // a failed refresh keeps the last overview; a permanent refusal drops it (Phase C1)
              <tr><td colSpan={3} className="ap-empty">The AI privacy settings could not be loaded.</td></tr>
            ) : (
              <>
                <tr><td>Prompt and answer telemetry</td><td><span className="ap-pill ap-ok">Disabled</span></td><td>AI SDK telemetry is off; prompts, answers and tool results are not logged or sent to Sentry.</td></tr>
                <tr><td>Conversation retention</td><td><span className={`ap-pill ${o.retention.mode === 'purge' ? 'ap-ok' : 'ap-warn'}`}>{o.retention.mode}</span></td><td>{RETENTION_MODE[o.retention.mode] ?? o.retention.mode}. Retention period {n(o.retention.days)} days; checked every {n(o.retention.intervalMinutes)} min. Audit history is kept.</td></tr>
                <tr><td>Administrator access to conversations</td><td><span className="ap-pill ap-ok">None</span></td><td>Platform administrators see usage counts only. No admin route and no database policy can read a conversation.</td></tr>
                <tr><td>Data sent to the model</td><td><span className="ap-pill ap-ok">Aggregates</span></td><td>Read-only tools return counts, totals and shift facts; never pay rates, bank, NI, right-to-work, contact details or payslips.</td></tr>
                <tr><td>External provider</td><td>{availableCount(modelsOf(o)) > 0 ? <span className="ap-pill ap-warn">Available</span> : <span className="ap-pill">None</span>}</td><td>{availableCount(modelsOf(o)) > 0 ? 'A real model is available, for synthetic demo data only until the provider checklist (DPA, zero retention, UK/EU processing) is complete.' : 'No model is available, so no data leaves the server.'}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Organisation card → the per-organisation AI switch (default OFF). Every change goes through the shared dialog: a
 * reason (saved to the audit log) and a recent step-up (`organisation.ai.update`). The switch shows the value the
 * server SAVED, never the one that was asked for.
 */
export function OrganisationAiSwitch({ organisationId, organisationName }: { organisationId: string; organisationName: string }) {
  const qc = useQueryClient();
  const key = ['admin', 'ai', 'org-setting', organisationId];
  const setting = useQuery({ queryKey: key, queryFn: () => adminApi.aiOrganisationSetting(organisationId), staleTime: 15_000 });
  const overview = useAiOverview();
  const [target, setTarget] = useState<boolean | null>(null);
  const enabled = setting.data?.enabled ?? false;
  return (
    <>
      <div className="ap-flagrow ap-ai-flag" style={{ marginTop: 14 }}>
        <div>
          AI assistant {setting.isLoading ? <span className="ap-muted">· loading…</span> : setting.isError ? <span className="ap-muted">· not available</span> : <OnOff on={enabled} />}
          <small>
            Read-only assistant for this organisation’s CEO and current Initial Manager. Off by default; every change needs a reason and is audited.
            {overview.data && !overview.data.platformEnabled ? ' The platform switch (AI_ENABLED) is off, so turning this on has no effect yet.' : ''}
            {setting.data?.updatedAt ? ` Last changed ${formatDateTime(setting.data.updatedAt)}.` : ''}
          </small>
        </div>
        <label className="ap-toggle">
          <input type="checkbox" aria-label={`AI assistant for ${organisationName}`} checked={enabled} disabled={!setting.data} onChange={(e) => setTarget(e.target.checked)} />
          <span />
        </label>
      </div>
      {target !== null && (
        <AdminActionDialog
          title={target ? `Turn on the AI assistant for ${organisationName}` : `Turn off the AI assistant for ${organisationName}`}
          body={
            target
              ? 'The CEO and the current Initial Manager can then ask the read-only AI assistant about their own workspace. No other organisation is affected.'
              : 'Nobody in this organisation can use the AI assistant afterwards; answers in progress stop. Their saved conversations are kept and they can still delete them.'
          }
          confirmLabel={target ? 'Turn on AI' : 'Turn off AI'}
          tone={target ? 'primary' : 'danger'}
          errorText={ADMIN_ERROR_TEXT}
          failureText="Could not change the AI switch. Please try again."
          onConfirm={async ({ reason, currentPassword, code }) => {
            await adminApi.stepUpIfGiven({ currentPassword, code });
            const saved = await adminApi.setAiOrganisationSetting(organisationId, target, reason);
            qc.setQueryData(key, saved);
            toast.success(saved.enabled ? `AI assistant is on for ${organisationName}` : `AI assistant is off for ${organisationName}`);
            setTarget(null);
            void qc.invalidateQueries({ queryKey: ['admin', 'ai', 'usage'] });
          }}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}

export type { AiAdminOverview };
