import { IconInfoCircle, IconLock, IconPlugConnectedX, IconSparkles } from '@tabler/icons-react';
import type { AiUnavailableReasonType } from '@rab/shared';

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
};

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

export function AiNotice() {
  return (
    <p className="ai-notice"><IconInfoCircle size={13} aria-hidden="true" />AI answers can be inaccurate. Check important figures; decisions stay with authorised people.</p>
  );
}
