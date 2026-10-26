import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { IconCpu, IconFlask, IconInfoCircle, IconLock, IconPlugConnectedX, IconSettings, IconSparkles } from '@tabler/icons-react';
import { AI_STATE_MESSAGE, type AiUnavailableReasonType } from '@rab/shared';

import type { AiAvailability } from './aiApi';

export function AiLoadingState({ label = 'Loading the AI assistant…' }: { label?: string }) {
  return (
    <div className="ai-state" role="status" aria-busy="true">
      <div className="ai-pending"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>{label}</span></div>
    </div>
  );
}

export function AiErrorState({ message, onRetry, busy = false }: { message: string; onRetry?: () => void; busy?: boolean }) {
  return (
    <div className="ai-state" role="alert">
      <IconPlugConnectedX size={22} aria-hidden="true" />
      <p>{message}</p>
      {onRetry && <button type="button" className="btn btn-outline" onClick={onRetry} disabled={busy}>{busy ? 'Trying…' : 'Try again'}</button>}
    </div>
  );
}

const UNAVAILABLE_TEXT: Record<AiUnavailableReasonType, { title: string; body: string }> = {
  platform_disabled: { title: 'The AI assistant is turned off', body: 'Crewflow AI is not switched on for this service at the moment.' },
  organisation_disabled: { title: 'The AI assistant is off for your organisation', body: 'A Crewflow platform administrator can turn it on for your organisation.' },
  not_permitted: { title: 'The AI assistant is not available to you', body: 'Only your organisation’s CEO and its current Initial Manager can use the AI assistant.' },
  no_workspace: { title: 'The AI assistant needs a workspace', body: 'Open Crewflow from your organisation’s workspace to use the AI assistant.' },
  // Normally shown as the disabled composer (AiChatPanel); kept here so every reason has text.
  not_configured: { title: 'The AI assistant is not set up yet', body: AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER },
  demo_data_only: { title: 'The AI assistant is limited to demo data', body: AI_STATE_MESSAGE.DEMO_DATA_ONLY },
};

/**
 * The fixed text for an eligible caller whose AI is not set up or limited to demo data. The server's own `message` wins
 * (it is one of AI_STATE_MESSAGE); the constant is only the fallback for an older server.
 */
export function aiBlockedMessage(a: { reason: 'not_configured' | 'demo_data_only'; message?: string; setup?: 'provider' | 'model' }): string {
  if (a.message) return a.message;
  if (a.reason === 'demo_data_only') return AI_STATE_MESSAGE.DEMO_DATA_ONLY;
  return a.setup === 'model' ? AI_STATE_MESSAGE.NOT_CONFIGURED_MODEL : AI_STATE_MESSAGE.NOT_CONFIGURED_PROVIDER;
}

/** AI disabled / permission denied. Says why in the user's own terms — the API itself only ever answers 404. */
export function AiUnavailableState({ reason }: { reason: AiUnavailableReasonType }) {
  const text = UNAVAILABLE_TEXT[reason] ?? UNAVAILABLE_TEXT.not_permitted;
  const Icon = reason === 'not_permitted' ? IconLock : IconSparkles;
  return (
    <div className="ai-state" role="status" data-reason={reason}>
      <Icon size={22} aria-hidden="true" />
      <h2>{text.title}</h2>
      <p>{text.body}</p>
    </div>
  );
}

/** The organisation's AI use today against its daily allowance (server figures only; tokens include reservations). */
export function AiUsageIndicator({ availability }: { availability: Extract<AiAvailability, { available: true }> }) {
  const budget = availability.limits.orgDailyTokenBudget;
  const used = availability.usage.tokensUsedOrReserved;
  if (!budget) return null;
  const pct = Math.min(100, Math.round((used / budget) * 100));
  const tone = pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className="ai-usage" data-tone={tone} title={`${used.toLocaleString('en-GB')} of ${budget.toLocaleString('en-GB')} tokens used or reserved today (UTC)`}>
      <span>Organisation AI use today</span>
      <span className="ai-usage-bar" role="meter" aria-label="Organisation AI use today" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${pct}% of today’s allowance`}>
        <i style={{ width: `${pct}%` }} />
      </span>
      <span>{pct}%</span>
    </div>
  );
}

/** D8-2: the ONE footer line on every AI surface (page, side panel, blocked view). */
export const AI_NOTICE_TEXT = 'AI suggests, a person decides. AI can make mistakes and can’t change anything without your approval.';

export function AiNotice() {
  return (
    <p className="ai-notice"><IconInfoCircle size={13} aria-hidden="true" />{AI_NOTICE_TEXT}</p>
  );
}

/**
 * U1 "Unavailable states" (owner mockup state 6): one banner per state an ELIGIBLE user can be in, with the fixed text in
 * a bold first sentence and the rest. `model` links to Settings → AI for the CEO only (the page is CEO-only; anyone else
 * would get a 404). Nothing here decides availability: the server's reason picks the banner.
 */
export type AiBannerKind = 'provider' | 'model' | 'demo' | 'failed';

const BANNER_TEXT: Record<Exclude<AiBannerKind, 'failed'>, { title: string; body: string }> = {
  provider: { title: 'AI isn’t set up yet.', body: 'A platform admin needs to add a provider key.' },
  model: { title: 'Choose a model in Settings → AI.', body: '' },
  demo: { title: 'AI is available for demo data only', body: 'until the provider checklist is complete.' },
};

export function bannerKindOf(a: { reason: 'not_configured' | 'demo_data_only'; setup?: string }): Exclude<AiBannerKind, 'failed'> {
  return a.reason === 'demo_data_only' ? 'demo' : a.setup === 'model' ? 'model' : 'provider';
}

export function AiBanner({ kind, icon, settingsLink = false, detail, onRetry }: { kind: AiBannerKind; icon?: ReactNode; settingsLink?: boolean; detail?: string; onRetry?: () => void }) {
  const Icon = kind === 'provider' ? IconSettings : kind === 'model' ? IconCpu : kind === 'demo' ? IconFlask : null;
  return (
    <div className="ai-banner" role={kind === 'failed' ? 'alert' : 'status'} data-kind={kind}>
      <span className="ai-banner-icon" aria-hidden="true">{icon ?? (Icon ? <Icon size={15} /> : null)}</span>
      <p>
        {kind === 'failed' ? (
          <>
            <strong>Something went wrong.</strong> Nothing was changed.{detail ? ` ${detail}` : ''}{' '}
            {onRetry && <button type="button" className="ai-link-btn" onClick={onRetry}>Try again</button>}
          </>
        ) : (
          <>
            <strong>{BANNER_TEXT[kind].title}</strong>
            {BANNER_TEXT[kind].body && <><br />{BANNER_TEXT[kind].body}</>}
            {kind === 'model' && settingsLink && <><br /><Link className="ai-link-btn" to="/settings/ai?tab=models">Open AI settings</Link></>}
          </>
        )}
      </p>
    </div>
  );
}
