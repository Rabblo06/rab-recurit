import { useRef, useState, type KeyboardEvent } from 'react';
import { IconArrowDown, IconArrowUp, IconCoin, IconDatabase, IconInfoCircle, IconRefresh } from '@tabler/icons-react';
import type { AiAvailabilityLevelsView, AiLevelUnavailableReason, AiLevelView, AiModelLevel, AiModelView, AiTurnUsageView, AiUsageTotals } from '@rab/shared';

import Popover from '../../shared/components/Popover';
import type { AiAvailabilityUsage, AiResolvedModel } from './aiApi';

/** Why a level can't be picked, in the user's words (C1 `AiLevelUnavailableReason`). */
export const LEVEL_REASON_TEXT: Record<AiLevelUnavailableReason, string> = {
  no_approved_model: 'No approved model',
  effort_unverified: 'Unavailable: effort not verified yet',
  residency: 'Not available in your data region',
  not_allowed: 'Not allowed by your organisation',
};

/** C13: the 1–5 bar glyph. Decorative: the level's name is always written next to it. */
export function AiLevelGlyph({ bars }: { bars: number }) {
  return (
    <span className="ai-level-glyph" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((b) => <i key={b} data-on={b <= bars ? 'true' : 'false'} />)}
    </span>
  );
}

/**
 * Integer micro-USD → text by INTEGER division only (never float arithmetic on money): 1 234 567 → "$1.23",
 * 999 → "<$0.01", 0 → "$0.00". Estimated cost, never an invoice.
 */
export function formatMicroUsd(micros: number): string {
  const m = Math.max(0, Math.trunc(micros));
  if (m > 0 && m < 10_000) return '<$0.01';
  const cents = Math.trunc(m / 10_000);
  const dollars = Math.trunc(cents / 100);
  const rest = cents % 100;
  return `$${dollars.toLocaleString('en-US')}.${String(rest).padStart(2, '0')}`;
}

/**
 * U2: a per-message or per-conversation estimate with four decimals ("$0.0011"), by integer division of the server's
 * integer micro-USD (never a float, never another currency).
 */
export function formatMicroUsdPrecise(micros: number): string {
  const m = Math.max(0, Math.trunc(micros));
  const units = Math.trunc(m / 100); // ten-thousandths of a dollar
  if (m > 0 && units === 0) return '<$0.0001';
  return `$${Math.trunc(units / 10_000).toLocaleString('en-US')}.${String(units % 10_000).padStart(4, '0')}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toLocaleString('en-GB')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString('en-GB')}k`;
  return n.toLocaleString('en-GB');
}

/** The CEO's per-level facts from `GET /ai/settings/models` (C1): never fetched for anyone else. */
export interface AiLevelFacts {
  levels: AiLevelView[];
  models: AiModelView[];
}

/** U1 / owner rule: no intelligence or speed figure has a verified source, so none is ever shown. */
export const NO_VERIFIED_SOURCE = 'No verified source yet';

/** Short reason for the picker ("Not approved · using Extra fast"). */
const SHORT_REASON: Record<AiLevelUnavailableReason, string> = {
  no_approved_model: 'Not approved',
  effort_unverified: 'Effort not verified',
  residency: 'Not in your data region',
  not_allowed: 'Not allowed by your organisation',
};
const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High' } as const;
const REGION_LABEL: Record<string, string> = { global: 'Global', eu: 'EU', us: 'US' };

/**
 * Cost band from the catalogue's OUTPUT price per 1M tokens (the only basis allowed: catalogue prices). Thresholds are
 * stated in the tooltip next to it.
 */
export const COST_BAND_RULE = 'From the catalogue output price per 1M tokens: under $1 very low, under $5 low, under $15 medium, otherwise high.';
export function costBand(outputUsdPerMTok: number): string {
  return outputUsdPerMTok < 1 ? 'Very low' : outputUsdPerMTok < 5 ? 'Low' : outputUsdPerMTok < 15 ? 'Medium' : 'High';
}
const usdPerM = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} / 1M`;
const ctxLabel = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })}M` : `${Math.round(v / 1000)}k`);

/** "—" with the owner-mandated tooltip, for a figure that has no verified source. */
function NoSource() {
  return <b className="ai-nosource" title={NO_VERIFIED_SOURCE}>—<span className="visually-hidden"> ({NO_VERIFIED_SOURCE})</span></b>;
}

/**
 * G1–G3, H10 (U1 chat mockup "tier picker", "model card", "model details"): the composer's level picker. A button with the
 * level glyph opens one popover with the level slider over the levels the SERVER offered (`availability.levels`), the
 * model card and, behind ⓘ, the model details. Unavailable levels are greyed with the server's reason and what is used
 * instead (the level the question would still go out on). `readOnly` (the server does not accept `level` on submit yet):
 * the slider shows the resolved chat level and cannot move. No intelligence or speed figure exists (no verified source);
 * the cost index is computed only from catalogue prices, by the server. Esc closes; focus returns to the button.
 */
export function AiLevelPicker({ levels, value, onChange, model, disabled, readOnly = false, facts }: {
  levels: AiAvailabilityLevelsView;
  value: AiModelLevel;
  onChange: (level: AiModelLevel) => void;
  model?: AiResolvedModel;
  disabled?: boolean;
  readOnly?: boolean;
  facts?: AiLevelFacts | null;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const [viewed, setViewed] = useState<AiModelLevel>(value);
  const anchor = useRef<HTMLButtonElement>(null);
  const options = levels.options;
  const index = Math.max(0, options.findIndex((o) => o.level === value));
  const current = options[index];
  const viewedIndex = Math.max(0, options.findIndex((o) => o.level === viewed));
  const shown = options[viewedIndex]!;
  const chatLabel = options.find((o) => o.level === levels.chatLevel)?.label ?? '';
  const valueLabel = current?.label ?? '';
  const fact = facts?.levels.find((l) => l.level === shown.level) ?? null;
  const factModel = fact?.resolved ? facts?.models.find((m) => m.id === fact.resolved!.id) ?? null : null;
  const modelLabel = fact?.resolved?.label ?? (shown.level === levels.chatLevel && model ? model.label : null);

  const close = () => {
    setOpen(false);
    setDetails(false);
    anchor.current?.focus();
  };
  const view = (i: number) => {
    const o = options[i];
    if (!o) return;
    setViewed(o.level);
    if (!readOnly && o.available) onChange(o.level);
  };
  const move = (dir: 1 | -1 | 'home' | 'end') => {
    const next = dir === 'home' ? 0 : dir === 'end' ? options.length - 1 : Math.min(options.length - 1, Math.max(0, viewedIndex + dir));
    view(next);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const map: Record<string, 1 | -1 | 'home' | 'end'> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, Home: 'home', End: 'end' };
    const dir = map[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    move(dir);
  };
  const stateLine = shown.available ? null : `${SHORT_REASON[shown.unavailableReason ?? 'no_approved_model']} · using ${valueLabel}`;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ai-composer-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setViewed(value);
          setOpen((v) => !v);
        }}
        title={`Level: ${valueLabel}`}
      >
        <AiLevelGlyph bars={current?.bars ?? 1} />
        <span className="visually-hidden">Level: {valueLabel}</span>
      </button>
      <Popover open={open} onClose={close} anchorRef={anchor} align="end" minWidth={300} className="ai-popover ai-tier-popover">
        <div
          className="ai-tier-pop"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
          {details && (
            <section className="ai-popover-body ai-model-details" aria-label="Model details">
              <dl className="ai-facts">
                <div><dt>Intelligence</dt><dd><NoSource /></dd></div>
                <div><dt>Speed</dt><dd><NoSource /></dd></div>
                <div><dt title={COST_BAND_RULE}>Cost index</dt><dd>{factModel ? <b title={COST_BAND_RULE}>{costBand(factModel.priceUsdPerMTok.output)}</b> : <b>—</b>}</dd></div>
                <div><dt>Input cost</dt><dd><b>{factModel ? usdPerM(factModel.priceUsdPerMTok.input) : '—'}</b></dd></div>
                <div><dt>Cached input</dt><dd><b>{factModel ? usdPerM(factModel.priceUsdPerMTok.cachedInput) : '—'}</b></dd></div>
                <div><dt>Output cost</dt><dd><b>{factModel ? usdPerM(factModel.priceUsdPerMTok.output) : '—'}</b></dd></div>
              </dl>
              <div className="ai-facts-sep" />
              <dl className="ai-facts">
                <div><dt>Server location</dt><dd><b title={factModel?.dataRegion}>{factModel ? REGION_LABEL[factModel.region] ?? factModel.region : '—'}</b></dd></div>
                <div><dt>Context window</dt><dd><b>{factModel ? ctxLabel(factModel.contextWindowTokens) : '—'}</b></dd></div>
                <div><dt>Input</dt><dd><b>Text only</b></dd></div>
                <div><dt>Output</dt><dd><b>Text</b></dd></div>
              </dl>
              <p className="ai-facts-note">From Crewflow’s model catalogue (ai-models.json). Prices in US dollars, estimates only.</p>
            </section>
          )}
          <div className="ai-tier-col">
            <section className="ai-popover-body ai-model-card" aria-label="Model">
              <dl className="ai-facts">
                <div>
                  <dt>Model</dt>
                  <dd>
                    <b>{modelLabel ?? (shown.available ? 'Chosen by Crewflow' : '—')}</b>
                    <button type="button" className="btn-icon ai-info-btn" aria-label="Model details" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
                      <IconInfoCircle size={14} aria-hidden="true" />
                    </button>
                  </dd>
                </div>
                <div><dt>Effort</dt><dd><b>{fact?.resolved ? EFFORT_LABEL[fact.effort] : '—'}</b></dd></div>
              </dl>
              <div className="ai-facts-sep" />
              <h4 className="ai-facts-heading">{`Vs ${chatLabel}`}</h4>
              <dl className="ai-facts">
                <div><dt>Intelligence</dt><dd><NoSource /></dd></div>
                <div><dt>Speed</dt><dd><NoSource /></dd></div>
                <div><dt title="Blended catalogue price (3 × input + output) / 4, compared with your organisation’s chat level">Cost index</dt><dd><b>{fact?.priceRatio != null ? `×${fact.priceRatio.toLocaleString('en-GB', { maximumFractionDigits: 2 })}` : '—'}</b></dd></div>
              </dl>
              {stateLine && <p className="ai-tier-state" role="note">{stateLine}</p>}
            </section>
            <section className="ai-popover-body ai-tier-box" aria-label="Choose a level">
              <div className="ai-level-slider-head">
                <strong>{shown.label}</strong>
                <span className="ai-muted" title={`Organisation default: ${chatLabel}`}><IconInfoCircle size={14} aria-hidden="true" /><span className="visually-hidden">Organisation default: {chatLabel}</span></span>
              </div>
              <div
                className="ai-level-slider"
                role="slider"
                tabIndex={0}
                aria-label="Answer level"
                aria-readonly={readOnly || undefined}
                aria-valuemin={1}
                aria-valuemax={options.length}
                aria-valuenow={viewedIndex + 1}
                aria-valuetext={`${shown.label}${shown.available ? '' : ` (${SHORT_REASON[shown.unavailableReason ?? 'no_approved_model']})`}`}
                onKeyDown={onKey}
              >
                <span className="ai-level-fill" style={{ width: `${((index + 1) / options.length) * 100}%` }} />
                {options.map((o, i) => (
                  <button
                    key={o.level}
                    type="button"
                    tabIndex={-1}
                    className="ai-level-stop"
                    data-active={i === index ? 'true' : 'false'}
                    data-available={o.available ? 'true' : 'false'}
                    aria-disabled={!o.available || readOnly || undefined}
                    title={o.available ? o.label : `${o.label}: ${SHORT_REASON[o.unavailableReason ?? 'no_approved_model']}`}
                    aria-label={o.available ? o.label : `${o.label}, ${LEVEL_REASON_TEXT[o.unavailableReason ?? 'no_approved_model']}`}
                    onClick={() => view(i)}
                  />
                ))}
              </div>
              {readOnly && <p className="ai-facts-note">Questions use your organisation’s level ({valueLabel}) for now.</p>}
            </section>
          </div>
        </div>
      </Popover>
    </>
  );
}

/** A small progress ring (decorative; the value is always written beside it). */
export function AiRing({ percent, tone = 'ok', size = 14 }: { percent: number; tone?: 'ok' | 'warn' | 'bad'; size?: number }) {
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  return (
    <svg className="ai-ring" data-tone={tone} width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} className="ai-ring-track" />
      <circle cx="7" cy="7" r={r} className="ai-ring-value" strokeDasharray={`${(p / 100) * c} ${c}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}

const tone = (pct: number): 'ok' | 'warn' | 'bad' => (pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok');

function resetText(iso: string | undefined): string {
  if (!iso) return 'resets at 00:00 UTC';
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'resets at 00:00 UTC';
  const h = Math.floor(ms / 3_600_000);
  return h >= 1 ? `resets 00:00 UTC (in ${h} h)` : `resets 00:00 UTC (in ${Math.max(1, Math.round(ms / 60_000))} min)`;
}

/**
 * H9 + G7–G14: the context/usage ring and its popover (real server figures only). The allowance shows the TIGHTER of the
 * user's and the organisation's daily ceilings when Phase 7 provides them, otherwise the organisation's token allowance.
 * Context, per-message and per-conversation tokens and estimated cost appear only when the server sends them (CD-6);
 * there are no "credits".
 */
export function AiUsageButton({ usage, tokenBudget, lastTurn, totals }: { usage: AiAvailabilityUsage; tokenBudget: number; lastTurn?: AiTurnUsageView | null; totals?: AiUsageTotals | null }) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const costPct = usage.userCostCeilingMicros && usage.userCostMicros !== undefined && usage.limitingBudget === 'user'
    ? Math.round((usage.userCostMicros / usage.userCostCeilingMicros) * 100)
    : usage.orgCostCeilingMicros && usage.orgCostMicros !== undefined
      ? Math.round((usage.orgCostMicros / usage.orgCostCeilingMicros) * 100)
      : null;
  const pct = Math.min(100, costPct ?? (tokenBudget ? Math.round((usage.tokensUsedOrReserved / tokenBudget) * 100) : 0));
  const allowanceLabel = costPct !== null ? (usage.limitingBudget === 'user' ? 'Your allowance today' : 'Organisation allowance today') : 'Organisation AI use today';
  const ctxPct = lastTurn && lastTurn.contextLimitTokens > 0 ? Math.round((lastTurn.contextUsedTokens / lastTurn.contextLimitTokens) * 100) : null;
  return (
    <>
      <button ref={anchor} type="button" className="ai-composer-chip" aria-label="Context and usage" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <AiRing percent={ctxPct ?? pct} tone={tone(ctxPct ?? pct)} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="start" minWidth={260} className="ai-popover">
        <div className="ai-popover-body" aria-label="Context and usage">
          <dl className="ai-facts">
            <div>
              <dt><IconDatabase size={13} aria-hidden="true" />Context used</dt>
              <dd>{ctxPct !== null && lastTurn ? <>{`${formatTokens(lastTurn.contextUsedTokens)} of ${formatTokens(lastTurn.contextLimitTokens)} (${ctxPct}%)`} <AiRing percent={ctxPct} tone={tone(ctxPct)} /></> : <span className="ai-muted" title="Not recorded">—</span>}</dd>
            </div>
            <div>
              <dt><IconRefresh size={13} aria-hidden="true" />{allowanceLabel}</dt>
              <dd>{`${pct}% used · ${resetText(usage.resetsAt)}`} <AiRing percent={pct} tone={tone(pct)} /></dd>
            </div>
          </dl>
          {more && (
            <>
              <h4 className="ai-facts-heading">Last message</h4>
              <TurnFacts usage={lastTurn ?? null} />
              <h4 className="ai-facts-heading">Conversation</h4>
              <TurnFacts usage={totals ?? null} />
              <p className="ai-facts-note">Estimated from list prices; not an invoice.</p>
            </>
          )}
          <div className="ai-popover-actions">
            <button type="button" className="btn btn-outline btn-sm" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? 'Less' : 'More'}</button>
          </div>
        </div>
      </Popover>
    </>
  );
}

function TurnFacts({ usage }: { usage: Pick<AiUsageTotals, 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'costUsdMicros'> | null }) {
  // S1: absent = no ledger row for this (own) turn — shown as "—", never estimated.
  if (!usage) return <p className="ai-muted ai-facts-empty" title="Not recorded">—</p>;
  return (
    <dl className="ai-facts">
      <div><dt><IconArrowUp size={13} aria-hidden="true" />Input tokens</dt><dd>{formatTokens(usage.inputTokens)}</dd></div>
      <div><dt><IconRefresh size={13} aria-hidden="true" />Cached input</dt><dd>{formatTokens(usage.cachedInputTokens)}</dd></div>
      <div><dt><IconArrowDown size={13} aria-hidden="true" />Output tokens</dt><dd>{formatTokens(usage.outputTokens)}</dd></div>
      <div><dt><IconCoin size={13} aria-hidden="true" />Estimated cost</dt><dd>{formatMicroUsdPrecise(usage.costUsdMicros)}</dd></div>
    </dl>
  );
}
