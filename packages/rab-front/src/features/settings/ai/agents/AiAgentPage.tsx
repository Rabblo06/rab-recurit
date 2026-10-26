import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBolt, IconClock, IconPlus, IconTrash } from '@tabler/icons-react';
import {
  AI_AGENT_EVENT_TYPES,
  AI_AGENT_LIMITS,
  AI_MODEL_TIERS,
  type AiAgentEventType,
  type AiAgentRoleFlag,
  type AiAgentSchedule,
  type AiAgentTriggerKind,
  type AiAgentTriggerView,
  type AiModelTier,
} from '@rab/shared';

import { aiKeys } from '../../../ai/aiApi';
import { useAiChat } from '../../../ai/AiChatProvider';
import { AiLevelGlyph } from '../../../ai/AiComposerControls';
import AiAssistantAvatar from '../../../ai/avatar/AiAssistantAvatar';
import AiReasonDialog from '../AiReasonDialog';
import AiSetCrumb from '../AiSetCrumb';
import { countText } from '../AiSkillsTab';
import { agentIsReadOnly, aiSettingsApi, type AiAgentRoleAny, type AiAgentRow } from '../aiSettingsApi';
import { AGENT_EVENT_TEXT, AGENT_EXECUTION_REASON, AGENT_TIER, DAYS, triggerText } from './agentText';

/** Server refusal codes of an agent write, in the CEO's words (inside the reason dialog, never a toast as well). */
export const AGENT_REFUSAL_TEXT: Record<string, string> = {
  AI_AGENT_NAME_TAKEN: 'An agent with that identifier already exists. Choose another.',
  AI_AGENT_LIMIT_REACHED: `Your organisation already has ${AI_AGENT_LIMITS.agentsPerWorkspace} agents. Delete one first.`,
  AI_AGENT_TRIGGER_LIMIT_REACHED: `An agent can have at most ${AI_AGENT_LIMITS.triggersPerAgent} triggers.`,
  AI_AGENT_READ_ONLY: 'Standard agents can’t be changed or deleted.',
  AI_AGENT_CONTENT_REFUSED: 'This can’t be saved: it contains something an agent may not be given (markup, hidden characters, personal data or something that looks like a secret).',
  AI_AGENT_INVALID: 'Something in this change isn’t allowed. Check the fields and try again.',
  AI_AGENT_ROLE_FLAG_NOT_ALLOWED: 'One of these permissions can’t be given to an agent, or you don’t hold it yourself.',
  AI_AGENT_EXECUTION_NOT_APPROVED: AGENT_EXECUTION_REASON,
};

type AgentTab = 'settings' | 'role' | 'triggers' | 'runs' | 'test';
const AGENT_TABS: Array<{ id: AgentTab; label: string; disabled?: boolean }> = [
  { id: 'settings', label: 'Settings' },
  { id: 'role', label: 'Role' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'runs', label: 'Runs', disabled: true },
  { id: 'test', label: 'Test', disabled: true },
];

/**
 * U6 agent page (agents mockup view 2): header (avatar, name, description, a run switch that stays OFF and disabled with
 * the EX-3 reason), tabs Settings · Role · Triggers · Runs · Test. Runs and Test are disabled with the EX-3 reason;
 * nothing here can start, test or enable anything. Standard / system agents (`readOnly`) are shown read-only and can't
 * be deleted. Every write goes through `AiReasonDialog` (reason + step-up + audit).
 */
export default function AiAgentPage({ agent, onBack }: { agent: AiAgentRow; onBack: () => void }) {
  const [tab, setTab] = useState<AgentTab>('settings');
  const refs = useRef<Partial<Record<AgentTab, HTMLButtonElement | null>>>({});
  const readOnly = agentIsReadOnly(agent);
  const enabledTabs = AGENT_TABS.filter((t) => !t.disabled);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = enabledTabs.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % enabledTabs.length : e.key === 'ArrowLeft' ? (i - 1 + enabledTabs.length) % enabledTabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? enabledTabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(enabledTabs[next]!.id);
    refs.current[enabledTabs[next]!.id]?.focus();
  };
  return (
    <>
      <AiSetCrumb parent="Agents" current={agent.label} onParent={onBack} headingId="ai-agent-title" />
      <div className="ai-agent-head">
        <AiAssistantAvatar size={36} state="sleepy" />
        <div className="ai-agent-head-text">
          <h3 id="ai-agent-title">{`Agent · ${agent.label}`}</h3>
          {agent.description && <p>{agent.description}</p>}
        </div>
        <span className="ai-agent-run" title={AGENT_EXECUTION_REASON}>
          <span className="ai-switch" data-on="false" role="switch" aria-checked="false" aria-disabled="true" aria-label="Run this agent" aria-describedby="ai-agent-exec-reason"><i /></span>
        </span>
        {readOnly && <span className="ai-pill" data-tone="neutral">Standard</span>}
      </div>
      <div className="ai-set-tabs ai-set-tabs--inner" role="tablist" aria-label="Agent">
        {AGENT_TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            id={`ai-agent-tab-${t.id}`}
            type="button"
            role="tab"
            className="ai-set-tab"
            aria-selected={tab === t.id}
            aria-controls={tab === t.id ? 'ai-agent-panel' : undefined}
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
      <p id="ai-agent-exec-reason" className="ai-set-reason">Running, Runs and Test: {AGENT_EXECUTION_REASON}</p>
      <div role="tabpanel" id="ai-agent-panel" className="settings-section ai-agent-panel" aria-labelledby={`ai-agent-tab-${tab}`}>
        {tab === 'settings' && <AgentSettings agent={agent} readOnly={readOnly} onDeleted={onBack} />}
        {tab === 'role' && <AgentRole agent={agent} readOnly={readOnly} />}
        {tab === 'triggers' && <AgentTriggers agent={agent} readOnly={readOnly} />}
      </div>
    </>
  );
}

function useAgentsRefresh() {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'agents') });
}

function AgentSettings({ agent, readOnly, onDeleted }: { agent: AiAgentRow; readOnly: boolean; onDeleted: () => void }) {
  const refresh = useAgentsRefresh();
  const ids = { label: useId(), description: useId(), prompt: useId(), tier: useId() };
  const [label, setLabel] = useState(agent.label);
  const [description, setDescription] = useState(agent.description ?? '');
  const [prompt, setPrompt] = useState(agent.prompt);
  const [tier, setTier] = useState<AiModelTier>(agent.model.tier);
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const tooLong = prompt.length > AI_AGENT_LIMITS.promptMaxChars;
  const changed = label !== agent.label || description !== (agent.description ?? '') || prompt !== agent.prompt || tier !== agent.model.tier;
  const valid = !readOnly && !tooLong && label.trim().length > 0 && prompt.trim().length > 0 && changed;
  const shortcut = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';
  return (
    <>
      <form
        className="ai-skill-form"
        noValidate
        onSubmit={(e) => { e.preventDefault(); if (valid) setPending('save'); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && valid) { e.preventDefault(); setPending('save'); } }}
      >
        {readOnly && <p className="ai-set-pending" role="note">Standard agent: it can’t be edited or deleted.</p>}
        <div className="field"><label htmlFor={ids.label}>Name</label><input id={ids.label} value={label} disabled={readOnly} maxLength={AI_AGENT_LIMITS.labelMaxChars} onChange={(e) => setLabel(e.target.value)} /></div>
        <div className="field"><label htmlFor={ids.description}>Description</label><input id={ids.description} value={description} disabled={readOnly} maxLength={AI_AGENT_LIMITS.descriptionMaxChars} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="field">
          <label htmlFor={ids.prompt}>Instructions</label>
          <textarea id={ids.prompt} className="ai-set-textarea" rows={8} value={prompt} disabled={readOnly} aria-invalid={tooLong || undefined} aria-describedby={`${ids.prompt}-count ${ids.prompt}-hint`} onChange={(e) => setPrompt(e.target.value)} />
          <span id={`${ids.prompt}-count`} className={`ai-set-count${tooLong ? ' ai-set-field-error' : ''}`}>{countText(prompt.length, AI_AGENT_LIMITS.promptMaxChars)}</span>
          <span id={`${ids.prompt}-hint`} className="ai-set-muted">Stored exactly as written (no variables). Added after Crewflow’s rules; they can’t give the agent permissions or tools.</span>
        </div>
        <div className="field">
          <label htmlFor={ids.tier}>Model</label>
          <span className="ai-agent-model">
            <AiLevelGlyph bars={AGENT_TIER[tier].bars} />
            <select id={ids.tier} value={tier} disabled={readOnly} onChange={(e) => setTier(e.target.value as AiModelTier)}>
              {AI_MODEL_TIERS.map((t) => <option key={t} value={t}>{AGENT_TIER[t].label}</option>)}
            </select>
          </span>
        </div>
        <div className="field">
          <span className="ai-set-label">Response format</span>
          <div className="ai-set-rows">
            <div className="ai-set-row"><div className="ai-set-row-text"><strong>Text</strong><span>A short summary in the run log</span></div><span className="ai-pill" data-tone="info">Selected</span></div>
            <div className="ai-set-row" data-disabled="true"><div className="ai-set-row-text"><strong>JSON with fields</strong><span>Structured output for workflows</span></div><span className="ai-set-muted">Not available yet</span></div>
          </div>
        </div>
        {!readOnly && (
          <div className="ai-set-actions ai-set-actions--end">
            <span className="ai-set-muted">{`${shortcut} + Enter to save`}</span>
            <button type="submit" className="btn btn-dark btn-sm" disabled={!valid}>Save</button>
          </div>
        )}
      </form>
      <h4 className="ai-set-subhead">Danger zone</h4>
      <div className="ai-set-danger">
        {readOnly ? (
          <>
            <button type="button" className="btn btn-outline btn-sm ai-set-danger-btn" disabled aria-describedby="ai-agent-nodelete"><IconTrash size={14} aria-hidden="true" />Delete</button>
            <span id="ai-agent-nodelete" className="ai-set-muted">Standard agents can’t be deleted.</span>
          </>
        ) : (
          <button type="button" className="btn btn-outline btn-sm ai-set-danger-btn" onClick={() => setPending('delete')}><IconTrash size={14} aria-hidden="true" />Delete agent</button>
        )}
      </div>
      {pending === 'save' && (
        <AiReasonDialog
          title="Save this agent?"
          body="Nothing runs: agents are stored only until agent execution is approved. You may be asked to confirm it’s you."
          run={(reason) =>
            aiSettingsApi.updateAgent(
              agent.id,
              {
                ...(label !== agent.label ? { label: label.trim() } : {}),
                ...(description !== (agent.description ?? '') ? { description: description.trim() } : {}),
                ...(prompt !== agent.prompt ? { prompt } : {}),
                ...(tier !== agent.model.tier ? { model: { tier, modelId: null } } : {}),
              },
              reason,
            )
          }
          successMessage="Agent saved"
          inlineErrors={AGENT_REFUSAL_TEXT}
          onDone={() => { setPending(null); refresh(); }}
          onClose={() => setPending(null)}
        />
      )}
      {pending === 'delete' && (
        <AiReasonDialog
          title={`Delete ${agent.label}?`}
          body="The agent and its triggers are deleted. This cannot be undone."
          confirmLabel="Delete"
          destructive
          run={(reason) => aiSettingsApi.deleteAgent(agent.id, reason)}
          successMessage="Agent deleted"
          inlineErrors={AGENT_REFUSAL_TEXT}
          onDone={() => { setPending(null); refresh(); onDeleted(); }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

const AREA_TEXT: Record<string, string> = { schedule: 'Shifts', venues: 'Venues', staff: 'Staff', attendance: 'Attendance', payroll: 'Payroll' };

/** `GET/PUT /ai/agents/:id/role`: only the C1 allowlist; a flag is selectable only when the server lists it as grantable. */
function AgentRole({ agent, readOnly }: { agent: AiAgentRow; readOnly: boolean }) {
  const { scope } = useAiChat();
  const qc = useQueryClient();
  const key = [...aiKeys.settingsArea(scope, 'agents'), agent.id, 'role'];
  const role = useQuery({ queryKey: key, queryFn: () => aiSettingsApi.agentRole(agent.id), retry: false });
  const [draft, setDraft] = useState<AiAgentRoleFlag[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  if (role.isLoading) return <p className="ai-set-muted" role="status">Loading the agent’s role…</p>;
  if (role.isError || !role.data) return <p className="ai-set-notice" role="alert">The agent’s role could not be loaded. Refresh the page to try again.</p>;
  const view = role.data;
  const held = draft ?? view.flags.filter((f) => f.held).map((f) => f.flag);
  const changed = draft !== null && [...draft].sort().join() !== view.flags.filter((f) => f.held).map((f) => f.flag).sort().join();
  const toggle = (flag: AiAgentRoleFlag, on: boolean) => setDraft(on ? [...held.filter((f) => f !== flag), flag] : held.filter((f) => f !== flag));
  return (
    <>
      <p>The agent acts with this role <strong>and</strong> the permissions of whoever turns it on, whichever is narrower. No role = no data access.</p>
      <fieldset className="ai-set-rows ai-agent-role" disabled={readOnly}>
        <legend className="visually-hidden">What this agent may see and suggest</legend>
        <div className="ai-set-row">
          <div className="ai-set-row-text"><strong>{view.roleId ? 'Agent role' : 'No role yet'}</strong><span>{view.roleId ? 'A dedicated role only this agent uses' : 'Saving permissions creates a dedicated role for this agent'}</span></div>
        </div>
        {view.flags.map((f) => {
          const grantable = view.grantable.includes(f.flag);
          const on = held.includes(f.flag);
          const inputId = `ai-agent-flag-${f.flag.replace('.', '-')}`;
          return (
            <div key={f.flag} className="ai-set-row" data-disabled={!grantable || undefined}>
              <div className="ai-set-row-text">
                <label htmlFor={inputId}><strong>{f.label}</strong></label>
                <span id={`${inputId}-hint`}>{`${AREA_TEXT[f.area] ?? f.area} · ${f.verb === 'see' ? 'read only' : 'suggestions a person approves'}${!grantable ? ' · you can’t grant this yet' : ''}`}</span>
              </div>
              <span className="ai-pill" data-tone={on ? 'ok' : 'neutral'}>{on ? 'Allowed' : 'Not allowed'}</span>
              <input id={inputId} type="checkbox" checked={on} disabled={readOnly || (!grantable && !on)} aria-describedby={`${inputId}-hint`} onChange={(e) => toggle(f.flag, e.target.checked)} />
            </div>
          );
        })}
        <div className="ai-set-row" data-disabled="true">
          <div className="ai-set-row-text"><strong>Right-to-work, contact details and pay changes</strong><span>Never available to agents</span></div>
          <span className="ai-pill" data-tone="neutral">Blocked</span>
        </div>
      </fieldset>
      {!readOnly && (
        <div className="ai-set-actions ai-set-actions--end">
          {changed && <button type="button" className="btn btn-outline btn-sm" onClick={() => setDraft(null)}>Undo</button>}
          <button type="button" className="btn btn-dark btn-sm" disabled={!changed} onClick={() => setConfirm(true)}>Save role</button>
        </div>
      )}
      {confirm && (
        <AiReasonDialog
          title="Save what this agent may see and suggest?"
          body="Only permissions you hold yourself can be given. Nothing runs until agent execution is approved. You may be asked to confirm it’s you."
          run={(reason) => aiSettingsApi.setAgentRole(agent.id, held, reason)}
          successMessage="Agent role saved"
          inlineErrors={AGENT_REFUSAL_TEXT}
          onDone={(saved: AiAgentRoleAny) => {
            qc.setQueryData(key, saved);
            setDraft(null);
            setConfirm(false);
            void qc.invalidateQueries({ queryKey: aiKeys.settingsArea(scope, 'agents'), exact: true });
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

type TriggerDraft = { kind: AiAgentTriggerKind; every: AiAgentSchedule['every']; at: string; dow: NonNullable<AiAgentSchedule['dow']>; events: AiAgentEventType[] };
const EMPTY_TRIGGER: TriggerDraft = { kind: 'schedule', every: 'week', at: '09:00', dow: 4, events: [] };

/** Triggers: stored switched OFF. "Turn on" is disabled with the EX-3 reason (the server refuses enable with 409 anyway). */
function AgentTriggers({ agent, readOnly }: { agent: AiAgentRow; readOnly: boolean }) {
  const refresh = useAgentsRefresh();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<TriggerDraft>(EMPTY_TRIGGER);
  const [pending, setPending] = useState<{ kind: 'create' } | { kind: 'delete'; trigger: AiAgentTriggerView } | null>(null);
  const formRef = useRef<HTMLFieldSetElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const ids = { every: useId(), at: useId(), dow: useId() };
  const atLimit = agent.triggers.length >= AI_AGENT_LIMITS.triggersPerAgent;
  const wasAdding = useRef(false);
  useEffect(() => {
    // Opening moves focus into the form; closing (Cancel, Esc, or saved) returns it to "Add trigger".
    if (adding) formRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    else if (wasAdding.current) addRef.current?.focus();
    wasAdding.current = adding;
  }, [adding]);
  const close = () => {
    setAdding(false);
    setDraft(EMPTY_TRIGGER);
  };
  const valid = draft.kind === 'schedule' ? /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.at) : draft.events.length > 0 && draft.events.length <= 4;
  return (
    <>
      <p>When the agent would run. Triggers are stored switched off.</p>
      {agent.triggers.length ? (
        <ul className="ai-agent-triggers">
          {agent.triggers.map((t) => (
            <li key={t.id} className="ai-agent-trigger">
              {t.kind === 'schedule' ? <IconClock size={16} aria-hidden="true" /> : <IconBolt size={16} aria-hidden="true" />}
              <div className="ai-set-row-text">
                <strong>{t.kind === 'schedule' ? 'Schedule' : 'Record event'}</strong>
                <span>{triggerText(t)}{t.kind === 'schedule' ? ' (organisation time)' : ' · ignores the agent’s own changes'}</span>
              </div>
              <button type="button" className="btn btn-outline btn-sm" disabled title={AGENT_EXECUTION_REASON} aria-describedby="ai-agent-trigger-reason">Turn on</button>
              {!readOnly && (
                <button type="button" className="btn-icon" aria-label={`Delete trigger: ${triggerText(t)}`} onClick={() => setPending({ kind: 'delete', trigger: t })}><IconTrash size={14} /></button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ai-set-muted">No triggers.</p>
      )}
      <p id="ai-agent-trigger-reason" className="ai-set-reason">{AGENT_EXECUTION_REASON}</p>
      {!readOnly && !adding && (
        <button ref={addRef} type="button" className="btn btn-outline btn-sm" disabled={atLimit} title={atLimit ? AGENT_REFUSAL_TEXT.AI_AGENT_TRIGGER_LIMIT_REACHED : undefined} onClick={() => setAdding(true)}>
          <IconPlus size={14} aria-hidden="true" />Add trigger
        </button>
      )}
      {adding && (
        <form
          className="ai-agent-trigger-form"
          noValidate
          onSubmit={(e) => { e.preventDefault(); if (valid) setPending({ kind: 'create' }); }}
          onKeyDown={(e) => { if (e.key === 'Escape' && !pending) { e.stopPropagation(); close(); } }}
        >
          <fieldset ref={formRef}>
            <legend>New trigger</legend>
            <div className="ai-agent-kind" role="radiogroup" aria-label="Trigger kind">
              {(['schedule', 'record_event'] as const).map((k) => (
                <label key={k}><input type="radio" name="ai-trigger-kind" checked={draft.kind === k} onChange={() => setDraft({ ...draft, kind: k })} />{k === 'schedule' ? 'On a schedule' : 'When a record changes'}</label>
              ))}
            </div>
            {draft.kind === 'schedule' ? (
              <div className="ai-agent-sched">
                <div className="field">
                  <label htmlFor={ids.every}>Repeat</label>
                  <select id={ids.every} value={draft.every} onChange={(e) => setDraft({ ...draft, every: e.target.value as TriggerDraft['every'] })}>
                    <option value="hour">Every hour</option><option value="day">Every day</option><option value="weekday">Every weekday</option><option value="week">Every week</option>
                  </select>
                </div>
                {draft.every === 'week' && (
                  <div className="field">
                    <label htmlFor={ids.dow}>Day</label>
                    <select id={ids.dow} value={draft.dow} onChange={(e) => setDraft({ ...draft, dow: Number(e.target.value) as TriggerDraft['dow'] })}>
                      {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label htmlFor={ids.at}>Time (24 h, organisation time)</label>
                  <input id={ids.at} type="time" value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} />
                </div>
              </div>
            ) : (
              <div className="ai-agent-events" role="group" aria-label="Events (at most 4)">
                {AI_AGENT_EVENT_TYPES.map((ev) => (
                  <label key={ev}>
                    <input type="checkbox" checked={draft.events.includes(ev)} onChange={(e) => setDraft({ ...draft, events: e.target.checked ? [...draft.events, ev] : draft.events.filter((x) => x !== ev) })} />
                    {`When ${AGENT_EVENT_TEXT[ev]}`}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="ai-set-actions ai-set-actions--end">
            <button type="button" className="btn btn-outline btn-sm" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn-dark btn-sm" disabled={!valid}>Add trigger</button>
          </div>
        </form>
      )}
      <p className="ai-set-pending" role="note">
        {`Limits: at most ${AI_AGENT_LIMITS.runsPerAgentPerHour} runs per agent per hour and ${AI_AGENT_LIMITS.eventsPerRun} events per run; at most ${AI_AGENT_LIMITS.triggersPerAgent} triggers per agent. Triggered runs can’t ask questions; their changes wait as proposals for a manager.`}
      </p>
      {pending?.kind === 'create' && (
        <AiReasonDialog
          title="Add this trigger?"
          body="It is stored switched off and can’t start the agent until agent execution is approved. You may be asked to confirm it’s you."
          confirmLabel="Add trigger"
          run={(reason) =>
            aiSettingsApi.createTrigger(
              agent.id,
              draft.kind === 'schedule'
                ? { kind: 'schedule', schedule: { every: draft.every, at: draft.at, ...(draft.every === 'week' ? { dow: draft.dow } : {}) } }
                : { kind: 'record_event', eventTypes: draft.events },
              reason,
            )
          }
          successMessage="Trigger added (switched off)"
          inlineErrors={AGENT_REFUSAL_TEXT}
          onDone={() => { setPending(null); setAdding(false); setDraft(EMPTY_TRIGGER); refresh(); }}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === 'delete' && (
        <AiReasonDialog
          title="Delete this trigger?"
          body={triggerText(pending.trigger)}
          confirmLabel="Delete"
          destructive
          run={(reason) => aiSettingsApi.deleteTrigger(agent.id, pending.trigger.id, reason)}
          successMessage="Trigger deleted"
          inlineErrors={AGENT_REFUSAL_TEXT}
          onDone={() => { setPending(null); refresh(); }}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

