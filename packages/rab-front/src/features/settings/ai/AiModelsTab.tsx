import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFlag, IconMessageCircle, IconRefresh, IconRobot } from '@tabler/icons-react';
import {
  AI_DATA_RESIDENCIES,
  AI_MODEL_STATE_LABEL,
  AI_MODEL_TIERS,
  type AiDataResidency,
  type AiLevelView,
  type AiModelLevel,
  type AiModelPolicyView,
  type AiModelTier,
  type AiModelView,
  type AiSettingsOverview,
  type AiTierSettingView,
} from '@rab/shared';

import { AI_ERROR_TEXT, aiKeys } from '../../ai/aiApi';
import { useAiChat } from '../../ai/AiChatProvider';
import { AiLevelGlyph, LEVEL_REASON_TEXT, NO_VERIFIED_SOURCE } from '../../ai/AiComposerControls';
import { aiBlockedMessage } from '../../ai/AiStates';
import { useAiAvailability } from '../../ai/useAiAvailability';
import AiReasonDialog, { NotAvailableYet } from './AiReasonDialog';
import { aiSettingsApi, type AiModelSettingsAny } from './aiSettingsApi';
import './ai-models.css';

/** What a tier is for, in the CEO's words (Phase 1 card, kept while the server serves tiers only). */
const TIER_TEXT: Record<AiModelTier, { title: string; body: string }> = {
  fast: { title: 'Chat model (fast)', body: 'Used for every question in the AI chat.' },
  smart: { title: 'Smart model', body: 'Reserved for heavier tasks in later releases. Nothing uses it yet.' },
};
const AUTOMATIC = '';
/** U1: the server's two values. 'Any region' still means demo data only (EX-1); real data needs the EU filter. */
const RESIDENCY_TEXT: Record<AiDataResidency, string> = { global: 'Any region', eu: 'EU' };
const EFFORT_TEXT = { low: 'Low', medium: 'Medium', high: 'High' } as const;
/** C3 / J22: agents cannot run until the owner approves EX-3 — shown disabled with the reason, never hidden. */
export const AGENTS_DISABLED_REASON = 'Agents can’t run yet: this is waiting for the owner’s approval (EX-3).';

const REGION: Record<string, string> = { global: 'Global', eu: 'EU', us: 'US' };

type Pending =
  | { kind: 'pin'; key: AiModelLevel | AiModelTier; modelId: string | null; label: string; title: string }
  | { kind: 'policy'; change: { chatLevel?: AiModelLevel; dataResidency?: AiDataResidency }; title: string; body: string }
  | { kind: 'auto'; levels: AiModelLevel[] };

/**
 * Settings → AI → Models (TWENTY_UI_INVENTORY C1–C18; Phase 1 card moved here from `AiModelsPage`). Everything is server
 * state: which models exist, their prices, regions and states, which can be chosen, what a question would use now. The
 * browser decides nothing — the server re-validates every pin and every policy change; each change asks a reason and a
 * recent step-up and is audited.
 *
 * With the C1 levels API (`features.levels`, `levels` + `policy` in the response): chat level, the agents row (disabled,
 * EX-3), data residency, "Choose automatically", the five-level tree and the preview table with REAL catalogue prices
 * only (no speed or intelligence scores: no verified source, TW-D9). Without it: the Phase 1 tier pickers.
 */
export default function AiModelsTab({ features }: { features: AiSettingsOverview['features'] }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const availability = useAiAvailability();
  const settings = useQuery({ queryKey: aiKeys.settings(scope), queryFn: aiSettingsApi.models, retry: false });
  const [pending, setPending] = useState<Pending | null>(null);
  const [manual, setManual] = useState(false);

  const view = settings.data;
  const blocked = availability.blocked && availability.data && availability.data.available === false && (availability.data.reason === 'not_configured' || availability.data.reason === 'demo_data_only') ? aiBlockedMessage(availability.data) : null;
  const levels = features.levels && view?.levels && view.policy ? { levels: view.levels, policy: view.policy } : null;
  const applied = (next: AiModelSettingsAny) => {
    qc.setQueryData(aiKeys.settings(scope), next);
    void qc.invalidateQueries({ queryKey: aiKeys.availability(scope) });
    setPending(null);
  };

  return (
    <div className="ai-models-page">
      <section className="settings-section" aria-labelledby="ai-models-title">
        <h3 id="ai-models-title">Models</h3>
        <p>Only models approved for Crewflow and set up by a platform administrator can be used. The others are listed with the reason. Every change needs a reason and is saved to the audit log.</p>
        {blocked && <p className="ai-models-notice" role="note">{blocked}</p>}
        {settings.isLoading ? (
          <p className="ai-models-muted" role="status">Loading models…</p>
        ) : settings.isError || !view ? (
          <p className="ai-models-notice" role="alert">The AI models could not be loaded. Refresh the page to try again.</p>
        ) : (
          <>
            <div className="ai-set-rows">
              {levels ? (
                <ChatLevelRow levels={levels.levels} policy={levels.policy} onChange={(chatLevel) => setPending({ kind: 'policy', change: { chatLevel }, title: `Use ${levelLabel(levels.levels, chatLevel)} for chat?`, body: 'Every new question uses this level unless the person asking picks another allowed level. You may be asked to confirm it’s you.' })} />
              ) : null}
              <div className="ai-set-row" data-disabled="true">
                <span className="ai-set-row-icon" aria-hidden="true"><IconRobot size={16} /></span>
                <div className="ai-set-row-text">
                  <strong>Agents</strong>
                  <span>Models agents use when they run on their own</span>
                </div>
                <div className="ai-set-row-control">
                  <select aria-label="Agent level" disabled aria-describedby="ai-agents-disabled"><option>{levels ? levelLabel(levels.levels, levels.policy.agentLevel) : 'Not available'}</option></select>
                  <span id="ai-agents-disabled" className="ai-set-reason">{AGENTS_DISABLED_REASON}</span>
                </div>
              </div>
              <ResidencyRow policy={levels?.policy ?? null} onChange={(dataResidency) => setPending({ kind: 'policy', change: { dataResidency }, title: `Process data in: ${RESIDENCY_TEXT[dataResidency]}?`, body: dataResidency === 'eu' ? 'Only models that process data in the EU can be used. If none is approved, the assistant is not available until one is.' : 'Global routing is allowed for demo data only. Real data always needs an EU model.' })} />
              {levels ? (
                <AutoRow
                  on={!manual && levels.levels.every((l) => !l.pinnedModelId)}
                  onToggle={(on) => {
                    if (!on) return setManual(true);
                    const pinned = levels.levels.filter((l) => l.pinnedModelId).map((l) => l.level);
                    if (pinned.length) setPending({ kind: 'auto', levels: pinned });
                    else setManual(false);
                  }}
                />
              ) : null}
              {levels && (manual || levels.levels.some((l) => l.pinnedModelId)) && (
                <ul className="ai-level-tree" aria-label="Model for each level">
                  {levels.levels.map((l) => <LevelRow key={l.level} level={l} models={view.models} busy={pending !== null} onPin={(modelId, label) => setPending({ kind: 'pin', key: l.level, modelId, label, title: modelId ? `Use ${label} for ${l.label}?` : `Choose the ${l.label} model automatically?` })} />)}
                </ul>
              )}
            </div>
            {!levels && (
              <>
                <NotAvailableYet>The five answer levels, data residency and the level preview arrive with the levels setting. Until then, choose a model per tier below.</NotAvailableYet>
                <div className="ai-models-tiers">
                  {AI_MODEL_TIERS.map((tier) => {
                    const setting = view.tiers.find((t) => t.tier === tier);
                    return setting ? <TierPicker key={tier} setting={setting} models={view.models} busy={pending !== null} onChange={(modelId, label) => setPending({ kind: 'pin', key: tier, modelId, label, title: modelId ? `Use ${label} for the ${tier} tier?` : `Choose the ${tier} model automatically?` })} /> : null;
                  })}
                </div>
              </>
            )}
          </>
        )}
      </section>
      {levels && <AiLevelPreviewTable levels={levels.levels} />}
      {view && <ModelTable models={view.models} />}
      {pending?.kind === 'pin' && (
        <AiReasonDialog
          title={pending.title}
          body={pending.modelId ? 'Every new question at this level will use this model. You may be asked to confirm it’s you.' : 'Crewflow will use the first available approved model. You may be asked to confirm it’s you.'}
          run={(reason) => (pending.modelId ? aiSettingsApi.pin(pending.key, pending.modelId, reason) : aiSettingsApi.unpin(pending.key, reason))}
          successMessage={pending.modelId ? `Model changed: ${pending.label}` : 'Model chosen automatically'}
          inlineErrors={{ AI_MODEL_NOT_AVAILABLE: AI_ERROR_TEXT.AI_MODEL_NOT_AVAILABLE!, AI_LEVEL_UNAVAILABLE: AI_ERROR_TEXT.AI_LEVEL_UNAVAILABLE! }}
          onRefused={(code) => {
            // The model or level stopped being available: re-read what the server offers now.
            if (code === 'AI_MODEL_NOT_AVAILABLE' || code === 'AI_LEVEL_UNAVAILABLE') void qc.invalidateQueries({ queryKey: aiKeys.settings(scope) });
          }}
          onDone={applied}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'policy' && (
        <AiReasonDialog
          title={pending.title}
          body={pending.body}
          run={(reason) => aiSettingsApi.policy({ ...pending.change, reason })}
          successMessage="AI model settings saved"
          inlineErrors={{ AI_LEVEL_UNAVAILABLE: AI_ERROR_TEXT.AI_LEVEL_UNAVAILABLE! }}
          onDone={applied}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'auto' && (
        <AiReasonDialog
          title="Choose every model automatically?"
          body="The model you chose for each level is removed and Crewflow picks the approved model for each level. You may be asked to confirm it’s you."
          run={async (reason) => {
            let last: AiModelSettingsAny | null = null;
            for (const key of pending.levels) last = await aiSettingsApi.unpin(key, reason);
            return last!;
          }}
          successMessage="Models chosen automatically"
          onDone={(next) => {
            setManual(false);
            applied(next);
          }}
          onClose={() => setPending(null)}
        />
      )}
    </div>
  );
}

const levelLabel = (levels: AiLevelView[], key: AiModelLevel) => levels.find((l) => l.level === key)?.label ?? key;

function ChatLevelRow({ levels, policy, onChange }: { levels: AiLevelView[]; policy: AiModelPolicyView; onChange: (level: AiModelLevel) => void }) {
  const id = useId();
  return (
    <div className="ai-set-row">
      <span className="ai-set-row-icon" aria-hidden="true"><IconMessageCircle size={16} /></span>
      <div className="ai-set-row-text">
        <label htmlFor={id}><strong>AI chat</strong></label>
        <span>Models used when your team chats with the assistant</span>
      </div>
      <div className="ai-set-row-control">
        <AiLevelGlyph bars={levels.find((l) => l.level === policy.chatLevel)?.bars ?? 1} />
        <select id={id} value={policy.chatLevel} onChange={(e) => e.target.value !== policy.chatLevel && onChange(e.target.value as AiModelLevel)}>
          {levels.map((l) => (
            <option key={l.level} value={l.level} disabled={!l.resolved || !l.allowed}>
              {l.label}{l.resolved && l.allowed ? '' : ` — ${LEVEL_REASON_TEXT[l.unavailableReason ?? 'no_approved_model']}`}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function ResidencyRow({ policy, onChange }: { policy: AiModelPolicyView | null; onChange: (r: AiDataResidency) => void }) {
  const id = useId();
  return (
    <div className="ai-set-row" data-disabled={policy ? undefined : 'true'}>
      <span className="ai-set-row-icon" aria-hidden="true"><IconFlag size={16} /></span>
      <div className="ai-set-row-text">
        <label htmlFor={id}><strong>Data residency</strong></label>
        <span>Where your data is processed. It can only narrow the models that can be used; any region is for demo data only.</span>
      </div>
      <div className="ai-set-row-control">
        {policy ? (
          <select id={id} value={policy.dataResidency} onChange={(e) => e.target.value !== policy.dataResidency && onChange(e.target.value as AiDataResidency)}>
            {AI_DATA_RESIDENCIES.map((r) => <option key={r} value={r}>{RESIDENCY_TEXT[r]}</option>)}
            {/* Shown so the choice is visible, but no approved model is hosted in the UK: the server has no 'uk' value. */}
            <option value="uk" disabled>UK — No approved UK-hosted model</option>
          </select>
        ) : (
          <span className="ai-set-reason">Not available yet</span>
        )}
      </div>
    </div>
  );
}

function AutoRow({ on, onToggle }: { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <div className="ai-set-row">
      <span className="ai-set-row-icon" aria-hidden="true"><IconRefresh size={16} /></span>
      <div className="ai-set-row-text">
        <strong id="ai-auto-label">Choose automatically</strong>
        <span>Crewflow fills each level with the best approved model that meets your requirements</span>
      </div>
      <div className="ai-set-row-control">
        <button type="button" role="switch" aria-checked={on} aria-labelledby="ai-auto-label" className="ai-switch-btn" onClick={() => onToggle(!on)}>
          <span className="ai-switch" data-on={on ? 'true' : 'false'} aria-hidden="true"><i /></span>
        </button>
      </div>
    </div>
  );
}

function LevelRow({ level, models, busy, onPin }: { level: AiLevelView; models: AiModelView[]; busy: boolean; onPin: (modelId: string | null, label: string) => void }) {
  const id = useId();
  const choices = models.filter((m) => m.tier === level.tier && m.selectable);
  const pinnedOffered = level.pinnedModelId ? choices.some((m) => m.id === level.pinnedModelId) : false;
  const detail = level.resolved
    ? `${level.resolved.label} · ${EFFORT_TEXT[level.effort]}${level.resolved.source === 'pin' ? '' : ' (Auto)'}${level.resolved.source === 'nearest' ? `, ${level.label} unavailable` : ''}`
    : LEVEL_REASON_TEXT[level.unavailableReason ?? 'no_approved_model'];
  return (
    <li className="ai-level-row" data-available={level.resolved ? 'true' : 'false'}>
      <span className="ai-level-row-glyph"><AiLevelGlyph bars={level.bars} /></span>
      <div className="ai-set-row-text">
        <label htmlFor={id}><strong>{level.label}</strong></label>
        <span>{detail}</span>
        {level.pinUnusable && <span className="ai-set-field-error">The chosen model can’t be used right now, so it is skipped.</span>}
      </div>
      <div className="ai-set-row-control">
        <select
          id={id}
          value={level.pinnedModelId ?? AUTOMATIC}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            if (v === (level.pinnedModelId ?? AUTOMATIC)) return;
            onPin(v === AUTOMATIC ? null : v, v === AUTOMATIC ? 'Automatic' : models.find((m) => m.id === v)?.label ?? v);
          }}
        >
          <option value={AUTOMATIC}>Automatic</option>
          {level.pinnedModelId && !pinnedOffered && <option value={level.pinnedModelId} disabled>{`${models.find((m) => m.id === level.pinnedModelId)?.label ?? level.pinnedModelId} (not available)`}</option>}
          {choices.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
      </div>
    </li>
  );
}

/** "—" with the owner-mandated tooltip, for a figure with no verified source (speed, intelligence). */
function NoSourceCell() {
  return <span className="ai-set-muted" title={NO_VERIFIED_SOURCE}>—<span className="visually-hidden"> ({NO_VERIFIED_SOURCE})</span></span>;
}

/**
 * C17 (U1 settings mockup "Preview"): the levels people choose between. REAL facts only: the server's resolved model per
 * level (a fallback marked as such), and the cost index the server computes from catalogue prices. Speed and intelligence
 * have no verified source, so they show "—" (owner rule, TW-D9); there is no "100 questions" estimate column.
 */
export function AiLevelPreviewTable({ levels }: { levels: AiLevelView[] }) {
  return (
    <section className="settings-section" aria-labelledby="ai-preview-title">
      <h3 id="ai-preview-title">Preview</h3>
      <p>The levels people and agents choose between.</p>
      <div className="table-container ai-models-table">
        <table className="table">
          <caption className="visually-hidden">Answer levels</caption>
          <thead>
            <tr>
              <th scope="col">Mode</th>
              <th scope="col">Model</th>
              <th scope="col" className="ai-num">Speed</th>
              <th scope="col" className="ai-num">Intelligence</th>
              <th scope="col" className="ai-num" title="Blended catalogue price (3 × input + output) / 4, compared with your chat level">Cost index</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((l) => (
              <tr key={l.level} data-level={l.level}>
                <td><span className="ai-level-cell"><AiLevelGlyph bars={l.bars} />{l.label}</span></td>
                <td>
                  {l.resolved ? (
                    <>{l.resolved.label}{l.resolved.source === 'nearest' && <span className="badge ai-pill-fallback">fallback</span>}</>
                  ) : (
                    <span className="ai-set-muted">{LEVEL_REASON_TEXT[l.unavailableReason ?? 'no_approved_model']}</span>
                  )}
                </td>
                <td className="ai-num"><NoSourceCell /></td>
                <td className="ai-num"><NoSourceCell /></td>
                <td className="ai-num">{l.priceRatio != null ? `×${l.priceRatio.toLocaleString('en-GB', { maximumFractionDigits: 2 })}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="ai-models-muted ai-models-footnote">Speed and intelligence: no verified source yet, so none is shown. Prices are list prices in US dollars.</p>
    </section>
  );
}

function TierPicker({ setting, models, onChange, busy }: { setting: AiTierSettingView; models: AiModelView[]; onChange: (modelId: string | null, label: string) => void; busy: boolean }) {
  const selectId = useId();
  const tier = setting.tier;
  const choices = models.filter((m) => m.tier === tier && m.selectable);
  const pinned = setting.pinnedModelId ? models.find((m) => m.id === setting.pinnedModelId) : undefined;
  const pinnedOffered = pinned ? choices.some((m) => m.id === pinned.id) : false;
  const value = setting.pinnedModelId ?? AUTOMATIC;
  const text = TIER_TEXT[tier];
  const using = setting.resolved ? (setting.resolved.source === 'pin' ? `Using: ${setting.resolved.label}` : `Using: ${setting.resolved.label} (automatic)`) : 'No model is available for this tier.';
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
            onChange(id === AUTOMATIC ? null : id, id === AUTOMATIC ? 'Choose automatically' : model?.label ?? id);
          }}
        >
          <option value={AUTOMATIC}>Choose automatically</option>
          {setting.pinnedModelId && !pinnedOffered && <option value={setting.pinnedModelId} disabled>{(pinned?.label ?? setting.pinnedModelId) + ' (not available)'}</option>}
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
  const p = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }));
  return (
    <section className="settings-section" aria-labelledby="ai-catalogue-title">
      <h3 id="ai-catalogue-title">Model catalogue</h3>
      <p>From Crewflow’s model catalogue (ai-models.json). Approval is a reviewed code change; this screen can’t approve a model.</p>
      <div className="table-container ai-models-table">
        <table className="table">
          <caption className="visually-hidden">AI model catalogue</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Tier</th>
              <th scope="col" className="ai-num">In / cached / out ($/1M)</th>
              <th scope="col">Region</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} data-model={m.id}>
                <td><span className="ai-model-name">{m.label}</span><span className="ai-model-id">{m.id}</span></td>
                <td>{m.tier === 'fast' ? 'Fast' : 'Smart'}</td>
                <td className="ai-num">{`${p(m.priceUsdPerMTok.input)} / ${p(m.priceUsdPerMTok.cachedInput)} / ${p(m.priceUsdPerMTok.output)}`}</td>
                <td title={m.dataRegion}>{REGION[m.region] ?? m.region}</td>
                <td><span className={`badge ai-models-state ai-models-state--${m.state}`}>{m.stateLabel || AI_MODEL_STATE_LABEL[m.state]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="ai-models-muted ai-models-footnote">Prices are the providers’ list prices in US dollars, used for the daily cost limit. They are estimates, not an invoice.</p>
      </div>
    </section>
  );
}
