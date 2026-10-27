import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { IconChevronRight, IconPlus } from '@tabler/icons-react';
import { AI_AGENT_LIMITS, AI_AGENT_NAME_PATTERN, AI_MODEL_TIERS, type AiModelTier, type AiSettingsOverview } from '@rab/shared';

import { aiKeys } from '../../../ai/aiApi';
import { useAiChat } from '../../../ai/AiChatProvider';
import { AiLevelGlyph } from '../../../ai/AiComposerControls';
import AiAssistantAvatar from '../../../ai/avatar/AiAssistantAvatar';
import AiReasonDialog, { NotAvailableYet } from '../AiReasonDialog';
import AiSetCrumb from '../AiSetCrumb';
import { countText } from '../AiSkillsTab';
import { agentIsReadOnly, agentList, aiSettingsApi, type AiAgentRow } from '../aiSettingsApi';
import AiAgentPage, { AGENT_REFUSAL_TEXT } from './AiAgentPage';
import { AGENT_EXECUTION_REASON, AGENT_EXECUTION_SHORT, AGENT_TIER, runsSummary } from './agentText';

export { AGENT_EXECUTION_REASON } from './agentText';

/** Same words for an unknown id and an agent the caller may not open: the server answers both 404 (never a 403). */
export const AGENT_NOT_FOUND = 'This agent doesn’t exist, or you can’t open it.';

/**
 * Settings → AI → Agents (Phase 6a STORAGE; U6 agents mockup views 1–2; rendered only when `features.agents`, which
 * follows AI_AGENTS_ENABLED and is false today). Agents and triggers can be stored and edited; NOTHING can run:
 * `features.agentExecution` is the literal false until EX-3, so "Turn on", Test and Runs are disabled with the EX-3
 * reason and there is no "Run now". Every route answers a uniform 404 to anyone who isn't eligible, which this screen
 * shows as one neutral message. Every write: reason + recent step-up (`organisation.ai.agent.update`) + audit.
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
  const atLimit = list.length >= AI_AGENT_LIMITS.agentsPerWorkspace;
  if (selected === 'new' && !atLimit) return <AiAgentNew onBack={() => go(null)} onCreated={(id) => go(id)} />;
  if (selected) {
    const agent = list.find((a) => a.id === selected);
    if (agent) return <AiAgentPage agent={agent} onBack={() => go(null)} />;
    return (
      <>
        <AiSetCrumb parent="Agents" current="Not found" onParent={() => go(null)} />
        <p className="ai-set-notice" role="alert">{AGENT_NOT_FOUND}</p>
      </>
    );
  }
  return (
    <section className="settings-section" aria-labelledby="ai-agents-title">
      <div className="ai-set-headrow">
        <div>
          <h3 id="ai-agents-title">Agents</h3>
          <p>Agents will work on their own, on a schedule or when records change. Their changes will wait for a manager to approve.</p>
        </div>
        <button type="button" className="btn btn-outline btn-sm" disabled={atLimit} title={atLimit ? AGENT_REFUSAL_TEXT.AI_AGENT_LIMIT_REACHED : undefined} onClick={() => go('new')}>
          <IconPlus size={14} aria-hidden="true" />New agent
        </button>
      </div>
      <p className="ai-set-notice" role="note">{AGENT_EXECUTION_REASON}</p>
      {list.length ? (
        <div className="table-container">
          <table className="table ai-set-table ai-set-table--links">
            <caption className="visually-hidden">Agents</caption>
            <thead>
              <tr><th scope="col">Name</th><th scope="col">Runs</th><th scope="col">Role</th><th scope="col">Model</th><th scope="col">Last run</th><th scope="col"><span className="visually-hidden">Open</span></th></tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <AgentRow key={a.id} agent={a} onOpen={() => go(a.id)} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ai-set-muted">No agents yet.</p>
      )}
    </section>
  );
}

function AgentRow({ agent, onOpen }: { agent: AiAgentRow; onOpen: () => void }) {
  const tier = AGENT_TIER[agent.model.tier];
  const readOnly = agentIsReadOnly(agent);
  return (
    <tr data-agent={agent.id} onClick={onOpen}>
      <td>
        <span className="ai-agent-name">
          <AiAssistantAvatar size="md" state="sleepy" />
          <strong>{agent.label}</strong>
        </span>
      </td>
      <td>{runsSummary(agent.triggers)}</td>
      <td>{agent.roleId ? 'Agent role' : <span className="ai-set-muted">No role (no data access)</span>}</td>
      <td><span className="ai-level-cell"><AiLevelGlyph bars={tier.bars} />{tier.label}</span></td>
      <td><span className="ai-set-muted" title={AGENT_EXECUTION_SHORT}>—<span className="visually-hidden">{AGENT_EXECUTION_SHORT}</span></span></td>
      <td className="ai-set-cell-end">
        {readOnly && <span className="ai-pill" data-tone="neutral">Standard</span>}
        <button type="button" className="btn-icon" aria-label={`Open ${agent.label}`} onClick={(e) => { e.stopPropagation(); onOpen(); }}><IconChevronRight size={15} /></button>
      </td>
    </tr>
  );
}

/** "New agent": stored with no trigger and no role (= no data access). Nothing runs (EX-3). */
function AiAgentNew({ onBack, onCreated }: { onBack: () => void; onCreated: (id: string) => void }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const ids = { name: useId(), label: useId(), description: useId(), prompt: useId(), tier: useId() };
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [tier, setTier] = useState<AiModelTier>('fast');
  const [confirm, setConfirm] = useState(false);
  const nameOk = AI_AGENT_NAME_PATTERN.test(name);
  const tooLong = prompt.length > AI_AGENT_LIMITS.promptMaxChars;
  const valid = nameOk && label.trim().length > 0 && prompt.trim().length > 0 && !tooLong;
  return (
    <>
      <AiSetCrumb parent="Agents" current="New agent" onParent={onBack} headingId="ai-agent-new-title" />
      <section className="settings-section" aria-labelledby="ai-agent-new-title">
        <h3 id="ai-agent-new-title">New agent</h3>
        <p>It is stored switched off, with no trigger and no role. {AGENT_EXECUTION_REASON}</p>
        <form className="ai-skill-form" noValidate onSubmit={(e) => { e.preventDefault(); if (valid) setConfirm(true); }}>
          <div className="field">
            <label htmlFor={ids.name}>Identifier</label>
            <input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={name && !nameOk ? true : undefined} aria-describedby={`${ids.name}-hint`} />
            <span id={`${ids.name}-hint`} className="ai-set-muted">Lower-case letters, numbers and hyphens, e.g. weekend-cover. It can’t change later.</span>
          </div>
          <div className="field"><label htmlFor={ids.label}>Name</label><input id={ids.label} value={label} maxLength={AI_AGENT_LIMITS.labelMaxChars} onChange={(e) => setLabel(e.target.value)} /></div>
          <div className="field"><label htmlFor={ids.description}>Description</label><input id={ids.description} value={description} maxLength={AI_AGENT_LIMITS.descriptionMaxChars} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="field">
            <label htmlFor={ids.prompt}>Instructions</label>
            <textarea id={ids.prompt} className="ai-set-textarea" rows={6} value={prompt} aria-invalid={tooLong || undefined} aria-describedby={`${ids.prompt}-count`} onChange={(e) => setPrompt(e.target.value)} />
            <span id={`${ids.prompt}-count`} className={`ai-set-count${tooLong ? ' ai-set-field-error' : ''}`}>{countText(prompt.length, AI_AGENT_LIMITS.promptMaxChars)}</span>
          </div>
          <div className="field">
            <label htmlFor={ids.tier}>Model</label>
            <select id={ids.tier} value={tier} onChange={(e) => setTier(e.target.value as AiModelTier)}>
              {AI_MODEL_TIERS.map((t) => <option key={t} value={t}>{AGENT_TIER[t].label}</option>)}
            </select>
          </div>
          <div className="ai-set-actions ai-set-actions--end"><button type="submit" className="btn btn-dark btn-sm" disabled={!valid}>Create agent</button></div>
        </form>
      </section>
      {confirm && (
        <AiReasonDialog
          title="Create this agent?"
          body="It is stored switched off and can’t run until agent execution is approved. You may be asked to confirm it’s you."
          confirmLabel="Create agent"
          run={(reason) => aiSettingsApi.createAgent({ name, label: label.trim(), ...(description.trim() ? { description: description.trim() } : {}), prompt, model: { tier, modelId: null }, reason })}
          successMessage="Agent created"
          inlineErrors={AGENT_REFUSAL_TEXT}
          onDone={(created) => {
            setConfirm(false);
            // Shown at once (the list refetch follows), so the new agent's page never flashes "not found".
            qc.setQueryData(aiKeys.settingsArea(scope, 'agents'), (old: Parameters<typeof agentList>[0]) => [...agentList(old).filter((a) => a.id !== created.id), created]);
            void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'agents'), exact: true });
            onCreated(created.id);
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}
