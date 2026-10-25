import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AI_MODEL_STATE_LABEL, AI_MODEL_TIERS, type AiModelSettingsView, type AiModelTier, type AiModelView, type AiTierSettingView } from '@rab/shared';

import ModalFrame from '../../../shared/components/ModalFrame';
import { useFeedbackMutation } from '../../../shared/hooks/useFeedbackMutation';
import { getApiErrorCode } from '../../../shared/lib/apiError';
import { AI_ERROR_TEXT, aiKeys, aiSettingsApi } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { aiBlockedMessage } from '../../ai/AiStates';
import { useAiAvailability } from '../../ai/useAiAvailability';
import './ai-models.css';

/** What a tier is for, in the CEO's words. Chat uses `fast` (like Twenty). */
const TIER_TEXT: Record<AiModelTier, { title: string; body: string }> = {
  fast: { title: 'Chat model (fast)', body: 'Used for every question in the AI chat.' },
  smart: { title: 'Smart model', body: 'Reserved for heavier tasks in later releases. Nothing uses it yet.' },
};
const AUTOMATIC = '';
const REASON_MIN = 3;
const REASON_MAX = 500;

const usd = (v: number | null) => (v === null ? '—' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`);
const tokens = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toLocaleString('en-GB', { maximumFractionDigits: 2 })}M` : `${Math.round(v / 1000).toLocaleString('en-GB')}k`);
const REGION: Record<string, string> = { global: 'Global', eu: 'EU', us: 'US' };

interface PendingChange {
  tier: AiModelTier;
  /** null = "Choose automatically" (remove the pin). */
  modelId: string | null;
  label: string;
}

/**
 * Settings → AI → "AI models" (docs/ai/PHASE1_TWENTY_PLAN.md §7, owner decisions D6, D7, D10, D11). The organisation's CEO
 * picks, per tier, one of the models the PLATFORM says are available, or "Choose automatically". Everything is server
 * state: which models exist, their prices, regions and state labels, which can be chosen and what a turn would use now.
 * The browser decides nothing — the server re-validates every pin (approved in code, key configured, not disabled,
 * allowed in this environment, right tier) and skips a stale pin at every use.
 *
 * Every change asks for a reason (3–500 characters, saved to the audit log) and needs a recent step-up: the shared
 * "Confirm it's you" prompt (StepUpHost) appears on 403 STEP_UP_REQUIRED and the change is replayed once. The select
 * always shows the SAVED value; success is announced only after the server answered.
 */
export default function AiModelsPage() {
  const { scope } = useAiChat();
  const availability = useAiAvailability();
  const settings = useQuery({ queryKey: aiKeys.settings(scope), queryFn: aiSettingsApi.models, enabled: availability.eligible, retry: false });
  const [pending, setPending] = useState<PendingChange | null>(null);

  if (availability.isLoading) return <div className="settings-page"><p className="ai-models-muted" role="status">Loading AI settings…</p></div>;
  if (!availability.eligible) {
    return (
      <div className="settings-page">
        <div className="settings-section">
          <h3>AI models</h3>
          <p>The AI assistant is not available for your organisation, so there is nothing to choose here.</p>
        </div>
      </div>
    );
  }

  const view = settings.data;
  const blocked = availability.blocked && availability.data && availability.data.available === false && (availability.data.reason === 'not_configured' || availability.data.reason === 'demo_data_only')
    ? aiBlockedMessage(availability.data)
    : null;

  return (
    <div className="settings-page ai-models-page">
      <section className="settings-section" aria-labelledby="ai-models-title">
        <h3 id="ai-models-title">AI models</h3>
        <p>
          Choose the model the AI assistant uses. Only models approved for Crewflow and set up by a platform administrator can be chosen; the
          others are listed with the reason. Every change needs a reason and is saved to the audit log.
        </p>
        {blocked && <p className="ai-models-notice" role="note">{blocked}</p>}
        {settings.isLoading ? (
          <p className="ai-models-muted" role="status">Loading models…</p>
        ) : settings.isError || !view ? (
          <p className="ai-models-notice" role="alert">The AI models could not be loaded. Refresh the page to try again.</p>
        ) : (
          <>
            <div className="ai-models-tiers">
              {AI_MODEL_TIERS.map((tier) => {
                const setting = view.tiers.find((t) => t.tier === tier);
                return setting ? <TierPicker key={tier} setting={setting} models={view.models} onChange={setPending} busy={pending !== null} /> : null;
              })}
            </div>
            <ModelTable models={view.models} />
          </>
        )}
      </section>
      {pending && <ReasonDialog change={pending} onClose={() => setPending(null)} />}
    </div>
  );
}

function TierPicker({ setting, models, onChange, busy }: { setting: AiTierSettingView; models: AiModelView[]; onChange: (c: PendingChange) => void; busy: boolean }) {
  const selectId = useId();
  const tier = setting.tier;
  const choices = models.filter((m) => m.tier === tier && m.selectable);
  const pinned = setting.pinnedModelId ? models.find((m) => m.id === setting.pinnedModelId) : undefined;
  const pinnedOffered = pinned ? choices.some((m) => m.id === pinned.id) : false;
  const value = setting.pinnedModelId ?? AUTOMATIC;
  const text = TIER_TEXT[tier];
  const using = setting.resolved
    ? setting.resolved.source === 'pin'
      ? `Using: ${setting.resolved.label}`
      : `Using: ${setting.resolved.label} (automatic)`
    : 'No model is available for this tier.';
  return (
    <div className="ai-models-tier">
      <label htmlFor={selectId} className="ai-models-tier-title">{text.title}</label>
      <p className="ai-models-muted">{text.body}</p>
      <div className="field">
        <select
          id={selectId}
          value={value}
          disabled={busy}
          onChange={(e) => {
            const id = e.target.value;
            if (id === value) return;
            const model = models.find((m) => m.id === id);
            onChange({ tier, modelId: id === AUTOMATIC ? null : id, label: id === AUTOMATIC ? 'Choose automatically' : model?.label ?? id });
          }}
        >
          <option value={AUTOMATIC}>Choose automatically</option>
          {/* A stored pin that is no longer offered stays visible (disabled) so the select never claims a value it does not have. */}
          {setting.pinnedModelId && !pinnedOffered && (
            <option value={setting.pinnedModelId} disabled>
              {(pinned?.label ?? setting.pinnedModelId) + ' (not available)'}
            </option>
          )}
          {choices.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
      <p className="ai-models-using" role="status">{using}</p>
      {setting.pinUnusable && (
        <p className="ai-models-notice" role="note">
          The chosen model can’t be used right now (it was disabled, lost its approval or its key), so it is skipped and the next available model is used. Choose another model or “Choose automatically”.
        </p>
      )}
    </div>
  );
}

function ModelTable({ models }: { models: AiModelView[] }) {
  return (
    <div className="table-container ai-models-table">
      <table className="table">
        <caption className="visually-hidden">AI model catalogue</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Provider</th>
            <th scope="col">Tier</th>
            <th scope="col">Input / 1M</th>
            <th scope="col">Cached input / 1M</th>
            <th scope="col">Output / 1M</th>
            <th scope="col">Context</th>
            <th scope="col">Region</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id} data-model={m.id}>
              <td>{m.label}</td>
              <td>{m.provider}</td>
              <td>{m.tier === 'fast' ? 'Fast' : 'Smart'}</td>
              <td>{usd(m.priceUsdPerMTok.input)}</td>
              <td>{usd(m.priceUsdPerMTok.cachedInput)}</td>
              <td>{usd(m.priceUsdPerMTok.output)}</td>
              <td>{tokens(m.contextWindowTokens)}</td>
              <td title={m.dataRegion}>{REGION[m.region] ?? m.region}</td>
              <td><span className={`badge ai-models-state ai-models-state--${m.state}`}>{m.stateLabel || AI_MODEL_STATE_LABEL[m.state]}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="ai-models-muted ai-models-footnote">Prices are the providers’ list prices in US dollars, used for the daily cost limit. They are estimates, not an invoice.</p>
    </div>
  );
}

/** Reason (3–500 characters) for one pin change; step-up is asked by the shared StepUpHost if the server requires it. */
function ReasonDialog({ change, onClose }: { change: PendingChange; onClose: () => void }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const titleId = useId();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const save = useFeedbackMutation<AiModelSettingsView, { reason: string }>({
    mutationFn: ({ reason: r }) => (change.modelId ? aiSettingsApi.pin(change.tier, change.modelId, r) : aiSettingsApi.unpin(change.tier, r)),
    successMessage: change.modelId ? `${TIER_TEXT[change.tier].title}: ${change.label}` : `${TIER_TEXT[change.tier].title}: chosen automatically`,
    // A cancelled "Confirm it's you" prompt is the user's choice (no toast); a refused model is shown inside the dialog.
    errorFeedback: (err) => {
      const code = getApiErrorCode(err);
      if (code === 'STEP_UP_REQUIRED' || code === 'AI_MODEL_NOT_AVAILABLE') return false;
      return { fallback: 'Could not change the AI model. Please try again.' };
    },
    onSuccess: (view) => {
      qc.setQueryData(aiKeys.settings(scope), view);
      // What the chat uses may have changed (and whether it is set up at all).
      void qc.invalidateQueries({ queryKey: aiKeys.availability(scope) });
      onClose();
    },
    onError: (err) => {
      const code = getApiErrorCode(err);
      if (code === 'AI_MODEL_NOT_AVAILABLE') {
        setError(AI_ERROR_TEXT.AI_MODEL_NOT_AVAILABLE!);
        void qc.invalidateQueries({ queryKey: aiKeys.settings(scope) });
      } else if (code === 'STEP_UP_REQUIRED') {
        setError('The change was not saved because your identity was not confirmed.');
      }
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !save.busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [save.busy, onClose]);

  const submit = () => {
    const trimmed = reason.trim();
    if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) {
      setFieldError(`Give a reason of ${REASON_MIN} to ${REASON_MAX} characters. It is saved to the audit log.`);
      inputRef.current?.focus();
      return;
    }
    setFieldError('');
    setError('');
    save.submit({ reason: trimmed });
  };

  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !save.busy) onClose(); }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }}
    >
      <form noValidate aria-busy={save.busy || undefined} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <h3 id={titleId}>{change.modelId ? `Use ${change.label} for the ${change.tier} tier?` : `Choose the ${change.tier} model automatically?`}</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>
          {change.modelId
            ? 'Every new question on this tier will use this model. You may be asked to confirm it’s you.'
            : 'Crewflow will use the first available model for this tier. You may be asked to confirm it’s you.'}
        </p>
        <div className="field">
          <label htmlFor={reasonId}>Reason (saved to the audit log)</label>
          <textarea
            id={reasonId}
            ref={inputRef}
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? `${reasonId}-error` : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {fieldError && <span id={`${reasonId}-error`} className="ai-models-field-error" role="alert">{fieldError}</span>}
        </div>
        {error && <p className="ai-models-notice" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={save.busy}>Cancel</button>
          <button type="submit" className="btn btn-dark" disabled={save.busy}>{save.busy ? 'Please wait…' : 'Save'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
