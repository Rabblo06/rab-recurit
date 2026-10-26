import { useRef, useState, type KeyboardEvent } from 'react';
import { IconArrowDown, IconArrowUp, IconCoin, IconDatabase, IconInfoCircle, IconRefresh } from '@tabler/icons-react';
import type { AiAvailabilityLevelsView, AiLevelUnavailableReason, AiModelLevel, AiTurnUsageView, AiUsageTotals } from '@rab/shared';

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

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toLocaleString('en-GB')}M`;
  if (n >= 10_000) return `${Math.round(n / 1000).toLocaleString('en-GB')}k`;
  return n.toLocaleString('en-GB');
}

/**
 * G1–G3, H10: the composer's level picker — a button with the level glyph that opens a popover with a 5-stop slider over
 * the levels the SERVER offered (`availability.levels`). Unavailable stops are disabled with their reason; the choice is
 * an enum sent with the next question only (the server refuses a level it does not allow — 409, never a silent switch).
 */
export function AiLevelPicker({ levels, value, onChange, model, disabled }: { levels: AiAvailabilityLevelsView; value: AiModelLevel; onChange: (level: AiModelLevel) => void; model?: AiResolvedModel; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const options = levels.options;
  const index = Math.max(0, options.findIndex((o) => o.level === value));
  const current = options[index];
  const move = (dir: 1 | -1 | 'home' | 'end') => {
    const usable = options.map((o, i) => (o.available ? i : -1)).filter((i) => i >= 0);
    if (!usable.length) return;
    let next = index;
    if (dir === 'home') next = usable[0]!;
    else if (dir === 'end') next = usable[usable.length - 1]!;
    else {
      for (let i = index + dir; i >= 0 && i < options.length; i += dir) {
        if (options[i]!.available) {
          next = i;
          break;
        }
      }
    }
    if (next !== index) onChange(options[next]!.level);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const map: Record<string, 1 | -1 | 'home' | 'end'> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, Home: 'home', End: 'end' };
    const dir = map[e.key];
    if (dir === undefined) return;
    e.preventDefault();
    move(dir);
  };
  return (
    <>
      <button ref={anchor} type="button" className="ai-composer-chip" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)} title={`Level: ${current?.label ?? ''}`}>
        <AiLevelGlyph bars={current?.bars ?? 1} />
        <span className="visually-hidden">Level: {current?.label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="end" minWidth={280} className="ai-popover">
        <div className="ai-popover-body" aria-label="Choose a level">
          <dl className="ai-facts">
            <div><dt>Model</dt><dd>{value === levels.chatLevel && model ? model.label : current?.available ? 'Chosen by Crewflow when you send' : '—'}</dd></div>
            {current && !current.available && current.unavailableReason && <div><dt>State</dt><dd>{LEVEL_REASON_TEXT[current.unavailableReason]}</dd></div>}
          </dl>
          <div className="ai-level-slider-head">
            <strong>{current?.label}</strong>
            <span className="ai-muted" title="Levels trade speed for depth. Your organisation's CEO decides which levels can be used.">
              <IconInfoCircle size={14} aria-hidden="true" />
            </span>
          </div>
          <div
            className="ai-level-slider"
            role="slider"
            tabIndex={0}
            aria-label="Answer level"
            aria-valuemin={1}
            aria-valuemax={options.length}
            aria-valuenow={index + 1}
            aria-valuetext={current ? `${current.label}${current.available ? '' : ` (${LEVEL_REASON_TEXT[current.unavailableReason ?? 'no_approved_model']})`}` : ''}
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
                disabled={!o.available}
                title={o.available ? o.label : `${o.label}: ${LEVEL_REASON_TEXT[o.unavailableReason ?? 'no_approved_model']}`}
                aria-label={o.available ? o.label : `${o.label}, ${LEVEL_REASON_TEXT[o.unavailableReason ?? 'no_approved_model']}`}
                onClick={() => onChange(o.level)}
              />
            ))}
          </div>
          <ul className="ai-level-list">
            {options.map((o) => (
              <li key={o.level} data-available={o.available ? 'true' : 'false'}>
                <AiLevelGlyph bars={o.bars} />
                <span>{o.label}</span>
                {!o.available && <span className="ai-muted">{LEVEL_REASON_TEXT[o.unavailableReason ?? 'no_approved_model']}</span>}
              </li>
            ))}
          </ul>
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
              <dd>{ctxPct !== null && lastTurn ? <>{`${formatTokens(lastTurn.contextUsedTokens)} of ${formatTokens(lastTurn.contextLimitTokens)} (${ctxPct}%)`} <AiRing percent={ctxPct} tone={tone(ctxPct)} /></> : <span className="ai-muted">Not available yet</span>}</dd>
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
  if (!usage) return <p className="ai-muted ai-facts-empty">Not available yet</p>;
  return (
    <dl className="ai-facts">
      <div><dt><IconArrowUp size={13} aria-hidden="true" />Input tokens</dt><dd>{formatTokens(usage.inputTokens)}</dd></div>
      <div><dt><IconRefresh size={13} aria-hidden="true" />Cached input</dt><dd>{formatTokens(usage.cachedInputTokens)}</dd></div>
      <div><dt><IconArrowDown size={13} aria-hidden="true" />Output tokens</dt><dd>{formatTokens(usage.outputTokens)}</dd></div>
      <div><dt><IconCoin size={13} aria-hidden="true" />Estimated cost</dt><dd>{formatMicroUsd(usage.costUsdMicros)}</dd></div>
    </dl>
  );
}
