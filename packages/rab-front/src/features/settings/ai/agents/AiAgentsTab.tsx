import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconArrowLeft, IconChevronRight, IconRobot } from '@tabler/icons-react';
import { AI_AGENT_LIMITS, AI_MODEL_TIERS, type AiAgentView, type AiModelTier, type AiSettingsOverview } from '@rab/shared';

import { useFeedbackMutation } from '../../../../shared/hooks/useFeedbackMutation';
import { aiKeys } from '../../../ai/aiApi';
import { useAiChat } from '../../../ai/AiChatProvider';
import { NotAvailableYet } from '../AiReasonDialog';
import { agentList, aiSettingsApi } from '../aiSettingsApi';

/** EX-3 is not approved (owner decision 2026-10-25): agents are stored only; nothing can run. Shown wherever a run would be. */
export const AGENT_EXECUTION_REASON = 'Agents can’t run until the owner approves agent execution (EX-3). You can set them up now; nothing will run.';

const SHORTCUT = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
const TIER_LABEL: Record<AiModelTier, string> = { fast: 'Fast', smart: 'Smart' };

/**
 * Settings → AI → Agents (Phase 6a storage; rendered only when `features.agents`; TWENTY_UI_INVENTORY J1–J22). Storage
 * only: an agent's settings can be edited, but no trigger can be enabled, nothing is scheduled and nothing runs —
 * "Test" and "Runs" are visible and disabled with the reason (TW-D10). No prompt variables, no typed outputs (TW-D11),
 * and the role picker offers only the P6-D4 view/suggest flags (never delete, settings, roles, users or AI flags).
 */
export default function AiAgentsTab({ features }: { features: AiSettingsOverview['features'] }) {
  const { scope } = useAiChat();
  const [params, setParams] = useSearchParams();
  const agents = useQuery({ queryKey: aiKeys.settingsArea(scope, 'agents'), queryFn: aiSettingsApi.agents, enabled: features.agents, retry: false });
  const selected = params.get('agent');
  const list = agentList(agents.data);
  const go = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('agent', id);
    else next.delete('agent');
    setParams(next);
  };
  if (!features.agents) return <NotAvailableYet>Agents are switched off on this server.</NotAvailableYet>;
  if (agents.isLoading) return <p className="ai-set-muted" role="status">Loading agents…</p>;
  if (agents.isError) return <p className="ai-set-notice" role="alert">Agents could not be loaded. Refresh the page to try again.</p>;
  const agent = selected ? list.find((a) => a.id === selected) : undefined;
  if (agent) return <AiAgentDetail agent={agent} onBack={() => go(null)} />;
  return (
    <section className="settings-section" aria-labelledby="ai-agents-title">
      <h3 id="ai-agents-title">Agents</h3>
      <p>Assistants that will work on their own once agent execution is approved.</p>
      <p className="ai-set-notice" role="note">{AGENT_EXECUTION_REASON}</p>
      {list.length ? (
        <ul className="ai-agent-list">
          {list.map((a) => (
            <li key={a.id}>
              <button type="button" className="ai-set-row-link" onClick={() => go(a.id)}>
                <IconRobot size={15} aria-hidden="true" />
                <span><strong>{a.label}</strong>{a.description ? ` — ${a.description}` : ''}</span>
                <IconChevronRight size={15} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ai-set-muted">No agents yet.</p>
      )}
    </section>
  );
}

type AgentTab = 'settings' | 'role' | 'triggers' | 'runs' | 'test';
const AGENT_TABS: Array<{ id: AgentTab; label: string; disabled?: boolean }> = [
  { id: 'settings', label: 'Settings' },
  { id: 'role', label: 'Role' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'runs', label: 'Runs', disabled: true },
  { id: 'test', label: 'Test', disabled: true },
];

/** J1–J21: one agent. Runs and Test are disabled with the EX-3 reason; nothing here can start a run. */
export function AiAgentDetail({ agent, onBack }: { agent: AiAgentView; onBack: () => void }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const [tab, setTab] = useState<AgentTab>('settings');
  const refs = useRef<Partial<Record<AgentTab, HTMLButtonElement | null>>>({});
  const ids = { label: useId(), description: useId(), prompt: useId(), tier: useId() };
  const [label, setLabel] = useState(agent.label);
  const [description, setDescription] = useState(agent.description ?? '');
  const [prompt, setPrompt] = useState(agent.prompt);
  const [tier, setTier] = useState<AiModelTier>(agent.model.tier);
  const tooLong = prompt.length > AI_AGENT_LIMITS.promptMaxChars;
  const save = useFeedbackMutation<AiAgentView, void>({
    // The prompt is stored and sent VERBATIM: no `{{variables}}` are ever interpolated (rule 5.2, CD-11).
    mutationFn: () => aiSettingsApi.updateAgent(agent.id, { label: label.trim(), description: description.trim() || undefined, prompt, model: { tier, modelId: null } }),
    successMessage: 'Agent saved',
    errorFeedback: { fallback: 'The agent could not be saved. Please try again.' },
    onSuccess: () => void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'agents') }),
  });
  const enabledTabs = AGENT_TABS.filter((t) => !t.disabled);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = enabledTabs.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % enabledTabs.length : e.key === 'ArrowLeft' ? (i - 1 + enabledTabs.length) % enabledTabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(enabledTabs[next]!.id);
    refs.current[enabledTabs[next]!.id]?.focus();
  };
  return (
    <>
      <button type="button" className="ai-set-back" onClick={onBack}><IconArrowLeft size={14} aria-hidden="true" />All agents</button>
      <section className="settings-section" aria-labelledby="ai-agent-title">
        <h3 id="ai-agent-title">Agent · {agent.label}</h3>
        <div className="ai-set-tabs ai-set-tabs--inner" role="tablist" aria-label="Agent">
          {AGENT_TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              className="ai-set-tab"
              aria-selected={tab === t.id}
              aria-disabled={t.disabled || undefined}
              disabled={t.disabled}
              title={t.disabled ? AGENT_EXECUTION_REASON : undefined}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => !t.disabled && setTab(t.id)}
              onKeyDown={onKey}
            >
              {t.label}
            </button>
          ))}
        </div>
        <p className="ai-set-reason">Runs and Test: {AGENT_EXECUTION_REASON}</p>
        <div role="tabpanel" aria-label={AGENT_TABS.find((t) => t.id === tab)?.label}>
          {tab === 'settings' && (
            <form
              className="ai-skill-form"
              onSubmit={(e) => { e.preventDefault(); if (!tooLong && label.trim()) save.submit(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !tooLong && label.trim()) { e.preventDefault(); save.submit(); } }}
            >
              <div className="field"><label htmlFor={ids.label}>Name</label><input id={ids.label} value={label} maxLength={AI_AGENT_LIMITS.labelMaxChars} onChange={(e) => setLabel(e.target.value)} /></div>
              <div className="field"><label htmlFor={ids.description}>Description</label><input id={ids.description} value={description} maxLength={AI_AGENT_LIMITS.descriptionMaxChars} onChange={(e) => setDescription(e.target.value)} /></div>
              <div className="field">
                <label htmlFor={ids.tier}>Model</label>
                <select id={ids.tier} value={tier} onChange={(e) => setTier(e.target.value as AiModelTier)}>
                  {AI_MODEL_TIERS.map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor={ids.prompt}>Instructions</label>
                <textarea id={ids.prompt} rows={8} value={prompt} aria-invalid={tooLong || undefined} aria-describedby={`${ids.prompt}-count`} onChange={(e) => setPrompt(e.target.value)} />
                <span id={`${ids.prompt}-count`} className={tooLong ? 'ai-set-field-error' : 'ai-set-muted'}>{`${prompt.length.toLocaleString('en-GB')} / ${AI_AGENT_LIMITS.promptMaxChars.toLocaleString('en-GB')}`}</span>
                <span className="ai-set-muted">Added after Crewflow’s rules. They can’t give the agent permissions or tools. Answers are text only.</span>
              </div>
              <div className="ai-set-actions">
                <span className="ai-set-muted">{`${SHORTCUT} + Enter to save`}</span>
                <button type="submit" className="btn btn-dark btn-sm" disabled={save.busy || tooLong || !label.trim()}>{save.busy ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          )}
          {tab === 'role' && (
            <>
              <p>The agent acts with this role, intersected with the permissions of the person who enables it. No role = no tools.</p>
              <dl className="ai-set-facts"><div><dt>Role</dt><dd>{agent.roleId ? 'Assigned' : 'No role'}</dd></div></dl>
              <NotAvailableYet>Choosing what the agent may see and suggest arrives with the agent role editor.</NotAvailableYet>
            </>
          )}
          {tab === 'triggers' && (
            <>
              <p>When the agent would run. Triggers are stored switched off.</p>
              {agent.triggers.length ? (
                <ul className="ai-agent-list">
                  {agent.triggers.map((t) => (
                    <li key={t.id} className="ai-agent-trigger">
                      <span>{t.kind === 'schedule' && t.schedule ? `Every ${t.schedule.every} at ${t.schedule.at}` : `On ${t.eventTypes.join(', ')}`}</span>
                      <button type="button" className="btn btn-outline btn-sm" disabled title={AGENT_EXECUTION_REASON}>Turn on</button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ai-set-muted">No triggers.</p>
              )}
              <p className="ai-set-reason">{AGENT_EXECUTION_REASON}</p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
