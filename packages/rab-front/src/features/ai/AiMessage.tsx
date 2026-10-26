import { useState } from 'react';
import { IconAlertTriangle, IconBrain, IconCheck, IconCopy, IconListCheck, IconLoader2, IconPlayerStop, IconTool } from '@tabler/icons-react';
import type { AiPlanStep } from '@rab/shared';

import { AI_TURN_ERROR_TEXT, toolStepLabel, type AiMessage as AiMessageRecord } from './aiApi';
import AiAssistantAvatar, { DEFAULT_AVATAR_LOOK, type AiAvatarLook } from './avatar/AiAssistantAvatar';
import type { AiAvatarState } from './avatar/faces';
import SafeMarkdown from './SafeMarkdown';
import type { LiveTurn } from './useAiConversation';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** How the assistant is shown (CD-3): its configured name (plain text, never sent to the model) and avatar look. */
export interface AiAssistantIdentity {
  name: string;
  look: AiAvatarLook;
}
export const DEFAULT_ASSISTANT: AiAssistantIdentity = { name: 'Crewflow', look: DEFAULT_AVATAR_LOOK };

/** "Thought for N s" (TW-D7): the server-measured DURATION only — never expandable, there is no text to show. */
export function thoughtFor(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `Thought for ${seconds} s`;
}

/** The name with the always-present "AI" badge (transparency: the assistant can never pass as a colleague). */
export function AssistantName({ name }: { name: string }) {
  return (
    <span className="ai-assistant-name">
      <strong>{name}</strong>
      <span className="ai-badge-ai" aria-label="AI assistant">AI</span>
    </span>
  );
}

/** The informational checklist of `update_plan` (TW-D8). No approve button exists: approval is per proposal only. */
export function AiPlanChecklist({ steps }: { steps: AiPlanStep[] }) {
  return (
    <ol className="ai-plan-list" aria-label="Plan">
      {steps.map((step, i) => (
        <li key={i} data-status={step.status}>
          <span className="ai-plan-box" aria-hidden="true">{step.status === 'done' ? <IconCheck size={11} /> : null}</span>
          <span className="ai-plan-label">{step.label}</span>
          <span className="visually-hidden">{step.status === 'done' ? 'Done' : step.status === 'in_progress' ? 'In progress' : 'Not started'}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One transcript entry. A user question is a plain-text bubble (never Markdown). An assistant answer shows the assistant's
 * avatar, name, "AI" badge and time, the turn's steps (fixed server labels, never arguments or data), "Thought for N s"
 * (duration only), the plan checklist (information only), and the answer through `SafeMarkdown` — while streaming from
 * the live deltas, afterwards from the persisted content.
 */
export default function AiMessage({ message, live, assistant = DEFAULT_ASSISTANT, avatarState }: { message: AiMessageRecord; live?: LiveTurn | null; assistant?: AiAssistantIdentity; avatarState?: AiAvatarState }) {
  const [copied, setCopied] = useState<'' | 'Copied' | 'Could not copy'>('');
  if (message.role === 'user') {
    return (
      <article className="ai-message user ai-bubble-row" aria-label="Your question">
        <div className="ai-bubble">
          <div className="ai-message-text">{message.content}</div>
        </div>
        <time className="ai-bubble-time" dateTime={message.createdAt}>{time(message.createdAt)}</time>
      </article>
    );
  }
  const status = live?.status ?? message.status;
  const text = live ? live.text : message.content;
  const errorCode = live ? live.errorCode : message.errorCode;
  const active = status === 'queued' || status === 'running';
  const tools = live?.tools ?? message.toolCalls.map((t) => ({ name: t.name, phase: 'finished' as const, outcome: t.outcome }));
  const rowsOf = (name: string) => message.toolCalls.find((t) => t.name === name)?.rows ?? null;
  const reasoningMs = live?.reasoning?.durationMs ?? message.reasoningMs ?? null;
  const reasoningOpen = live?.reasoning?.phase === 'started';
  const thinking = active && !text;
  const plan = live?.plan ?? [...message.toolCalls].reverse().find((t) => t.plan?.length)?.plan ?? null;
  const state: AiAvatarState = avatarState ?? (status === 'failed' ? 'error' : active ? 'thinking' : 'idle');
  const hasSteps = tools.length > 0 || reasoningMs !== null || reasoningOpen || (plan?.length ?? 0) > 0;
  return (
    <article className="ai-message assistant" aria-label="Assistant answer" aria-busy={active} data-status={status}>
      <header>
        <AiAssistantAvatar look={assistant.look} state={state} size="sm" />
        <AssistantName name={assistant.name} />
        {thinking ? (
          <span className="ai-turn-state">{live?.cancelling ? 'Stopping…' : status === 'queued' ? 'is waiting to start' : 'is thinking'}</span>
        ) : active ? (
          <span className="ai-turn-state"><IconLoader2 size={12} className="ai-spin" aria-hidden="true" />{live?.cancelling ? 'Stopping…' : 'Answering'}</span>
        ) : null}
        <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
      </header>
      {hasSteps && (
        <ul className="ai-steps" aria-label="What the assistant did">
          {reasoningOpen && reasoningMs === null && (
            <li data-outcome="running"><IconBrain size={13} aria-hidden="true" /><span>Thinking…</span></li>
          )}
          {reasoningMs !== null && (
            <li data-outcome="ok" className="ai-step-thought"><IconBrain size={13} aria-hidden="true" /><span>{thoughtFor(reasoningMs)}</span></li>
          )}
          {plan && plan.length > 0 && (
            <li data-outcome="ok"><IconListCheck size={13} aria-hidden="true" /><span>{`Planned ${plan.length} ${plan.length === 1 ? 'step' : 'steps'}`}</span></li>
          )}
          {tools.map((t) => {
            const failed = t.outcome && t.outcome !== 'ok';
            return (
              <li key={t.name} data-outcome={t.outcome ?? (t.phase === 'started' ? 'running' : 'ok')}>
                {t.phase === 'started' ? <IconLoader2 size={13} className="ai-spin" aria-hidden="true" /> : failed ? <IconAlertTriangle size={13} aria-hidden="true" /> : <IconTool size={13} aria-hidden="true" />}
                <span>{toolStepLabel(t.name, t.phase, t.phase === 'finished' ? rowsOf(t.name) : null)}</span>
                {failed && <span className="ai-tool-outcome">{t.outcome === 'denied' || t.outcome === 'unknown_tool' ? 'not permitted' : t.outcome === 'invalid_input' ? 'refused' : 'failed'}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {plan && plan.length > 0 && <AiPlanChecklist steps={plan} />}
      {text ? (
        <div className="ai-message-text ai-markdown" aria-live={active ? 'polite' : 'off'}>
          <SafeMarkdown text={text} />
        </div>
      ) : active ? (
        <div className="ai-pending" role="status"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>{status === 'queued' ? 'Waiting for the assistant…' : 'Preparing an answer…'}</span></div>
      ) : null}
      {status === 'failed' && (
        <p className="ai-turn-error" role="note"><IconAlertTriangle size={14} aria-hidden="true" />{AI_TURN_ERROR_TEXT[errorCode ?? ''] ?? AI_TURN_ERROR_TEXT.AI_INTERNAL_ERROR}</p>
      )}
      {status === 'cancelled' && <p className="ai-turn-note" role="note"><IconPlayerStop size={13} aria-hidden="true" />Stopped. {text ? 'The answer above is incomplete.' : 'No answer was produced.'}</p>}
      {live?.connection === 'reconnecting' && active && <p className="ai-turn-note" role="status">Connection interrupted. Reconnecting…</p>}
      {status === 'completed' && text && (
        <div className="ai-message-actions">
          <button
            type="button"
            aria-label="Copy answer"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied('Copied');
              } catch {
                setCopied('Could not copy');
              }
            }}
          >
            {copied === 'Copied' ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
          <span role="status" className={copied === 'Copied' ? 'feedback-success' : copied ? 'feedback-error' : undefined}>{copied}</span>
        </div>
      )}
    </article>
  );
}
