import { useId, useState, type ReactNode } from 'react';
import { IconAlertTriangle, IconBook, IconBrain, IconCheck, IconChevronDown, IconClock, IconCopy, IconListCheck, IconLoader2, IconPlayerStop, IconTool, IconX } from '@tabler/icons-react';
import type { AiPlanStep } from '@rab/shared';

import { AI_TURN_ERROR_TEXT, toolStepLabel, type AiMessage as AiMessageRecord } from './aiApi';
import AiRecordChip from './AiRecordChip';
import { formatMicroUsdPrecise } from './AiComposerControls';
import AiAssistantAvatar, { DEFAULT_AVATAR_LOOK, type AiAvatarLook } from './avatar/AiAssistantAvatar';
import type { AiAvatarState } from './avatar/faces';
import { AiBanner } from './AiStates';
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

/** The fixed privacy line of every expanded tool step (owner decision 2: inputs and outputs are never shown). */
export const STEP_PRIVACY_TEXT = 'Inputs and outputs aren’t shown. Names, contact details and pay are removed before the assistant sees any record.';

const OUTCOME_TEXT: Record<string, string> = {
  ok: 'Completed',
  denied: 'Not permitted for you',
  unknown_tool: 'Not permitted for you',
  invalid_input: 'Refused: the request was not valid',
  error: 'Failed',
  timeout: 'Took too long and was stopped',
};

export interface AiToolStep {
  name: string;
  phase: 'started' | 'finished';
  outcome?: string;
  rows: number | null;
  /** `load_skills`: the skills' LABELS (from `GET /ai/skills`), never content. */
  skills: string[];
}

/**
 * U2: one tool step as a disclosure. Expanded, it shows ONLY server facts — the fixed label, the outcome in words, the
 * row count and (load_skills) the skill labels — and the fixed privacy line. It never reads a tool's arguments or data
 * (rule 11.2): there is no field for them on `AiToolCallSummaryV2`, and this component takes none.
 */
export function AiStepDisclosure({ step }: { step: AiToolStep }) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const running = step.phase === 'started';
  const failed = !!step.outcome && step.outcome !== 'ok';
  const label = toolStepLabel(step.name, step.phase, running ? null : step.rows, step.skills.length ? step.skills.join(', ') : undefined);
  const Icon = running ? IconLoader2 : failed ? IconAlertTriangle : step.name === 'load_skills' ? IconBook : IconTool;
  return (
    <li data-outcome={step.outcome ?? (running ? 'running' : 'ok')} className="ai-step-tool">
      <button type="button" className="ai-step-toggle" aria-expanded={open} aria-controls={regionId} onClick={() => setOpen((v) => !v)} disabled={running}>
        <Icon size={13} className={running ? 'ai-spin' : undefined} aria-hidden="true" />
        <span>{label}</span>
        {failed && <span className="ai-tool-outcome">{step.outcome === 'denied' || step.outcome === 'unknown_tool' ? 'not permitted' : step.outcome === 'invalid_input' ? 'refused' : 'failed'}</span>}
        {!running && <IconChevronDown size={12} className="ai-step-chevron" aria-hidden="true" />}
      </button>
      {open && (
        <div id={regionId} className="ai-step-body" role="region" aria-label={`Details: ${label}`}>
          <dl>
            <div><dt>Result</dt><dd>{OUTCOME_TEXT[step.outcome ?? 'ok'] ?? 'Failed'}</dd></div>
            {step.rows !== null && <div><dt>Records</dt><dd>{step.rows.toLocaleString('en-GB')}</dd></div>}
            {step.skills.length > 0 && <div><dt>Skills</dt><dd>{step.skills.join(', ')}</dd></div>}
          </dl>
          <p className="ai-step-privacy">{STEP_PRIVACY_TEXT}</p>
        </div>
      )}
    </li>
  );
}

/** Presentation facts the transcript resolves once (labels from server lists only, never from model text). */
export interface AiMessageContext {
  /** Skill name → label (`GET /ai/skills`). */
  skillLabels?: Readonly<Record<string, string>>;
  /** Level enum → label (`availability.levels.options`). */
  levelLabels?: Readonly<Record<string, string>>;
  /** Model id → label (the availability model and, for the CEO, `GET /ai/settings/models`). Unknown id → nothing shown. */
  modelLabels?: Readonly<Record<string, string>>;
}

/**
 * One transcript entry. A user question is a plain-text bubble (never Markdown). An assistant answer shows the assistant's
 * avatar, name, "AI" badge and time, the turn's steps (fixed server labels, never arguments or data), "Thought for N s"
 * (duration only), the plan checklist (information only), and the answer through `SafeMarkdown` — while streaming from
 * the live deltas (record references stay text), afterwards from the persisted content (record chips, S2).
 */
export default function AiMessage({
  message,
  live,
  assistant = DEFAULT_ASSISTANT,
  avatarState,
  onRetry,
  onStartNew,
  queued,
  context = {},
  cards,
}: {
  message: AiMessageRecord;
  live?: LiveTurn | null;
  assistant?: AiAssistantIdentity;
  avatarState?: AiAvatarState;
  onRetry?: () => void;
  /** AI_CONTEXT_FULL: the only way on is a new conversation (no "Try again"). */
  onStartNew?: () => void;
  /** U2: this user question waits behind the running answer; Remove cancels its queued turn. */
  queued?: { onRemove: () => void; busy: boolean };
  context?: AiMessageContext;
  /** U5: this answer's approval / question / form cards (attached by turn id). */
  cards?: ReactNode;
}) {
  const [copied, setCopied] = useState<'' | 'Copied' | 'Could not copy'>('');
  if (message.role === 'user') {
    return (
      <article className="ai-message user ai-bubble-row" aria-label={queued ? 'Your queued question' : 'Your question'} data-queued={queued ? 'true' : undefined}>
        <div className="ai-bubble">
          {message.skills && message.skills.length > 0 && (
            // 4w: the skills this question tagged (labels from the server list; never content).
            <ul className="ai-skill-tags ai-skill-tags-sent" aria-label="Tagged skills">
              {message.skills.map((name) => <li key={name} className="ai-skill-tag"><IconBook size={12} aria-hidden="true" /><span>{context.skillLabels?.[name] ?? name}</span></li>)}
            </ul>
          )}
          <div className="ai-message-text">{message.content}</div>
        </div>
        {queued ? (
          <span className="ai-queued">
            <span className="ai-queued-tag"><IconClock size={12} aria-hidden="true" />Queued · asks after the current answer</span>
            <button type="button" className="ai-link-btn" onClick={queued.onRemove} disabled={queued.busy} aria-label="Remove queued question"><IconX size={12} aria-hidden="true" />Remove</button>
          </span>
        ) : (
          <time className="ai-bubble-time" dateTime={message.createdAt}>{time(message.createdAt)}</time>
        )}
      </article>
    );
  }
  const status = live?.status ?? message.status;
  const text = live ? live.text : message.content;
  const errorCode = live ? live.errorCode : message.errorCode;
  const active = status === 'queued' || status === 'running';
  const skillLabel = (name: string) => context.skillLabels?.[name] ?? name;
  // While the answer runs the steps come from the stream; once it ended, from the persisted call summaries (they carry
  // the row counts and skill names the stream does not).
  const steps: AiToolStep[] = live && (active || message.toolCalls.length === 0)
    ? live.tools.map((t) => {
        const persisted = message.toolCalls.find((c) => c.name === t.name);
        return { name: t.name, phase: t.phase, outcome: t.outcome, rows: t.phase === 'finished' ? persisted?.rows ?? null : null, skills: (persisted?.skills ?? []).map(skillLabel) };
      })
    : message.toolCalls.map((t) => ({ name: t.name, phase: 'finished' as const, outcome: t.outcome, rows: t.rows, skills: (t.skills ?? []).map(skillLabel) }));
  const reasoningMs = live?.reasoning?.durationMs ?? message.reasoningMs ?? null;
  const reasoningOpen = live?.reasoning?.phase === 'started';
  const thinking = active && !text;
  const plan = live?.plan ?? [...message.toolCalls].reverse().find((t) => t.plan?.length)?.plan ?? null;
  const state: AiAvatarState = avatarState ?? (status === 'failed' ? 'error' : active ? 'thinking' : 'idle');
  const hasSteps = steps.length > 0 || reasoningMs !== null || reasoningOpen || (plan?.length ?? 0) > 0;
  const levelLabel = message.level ? context.levelLabels?.[message.level] ?? null : null;
  const modelLabel = message.modelId ? context.modelLabels?.[message.modelId] ?? null : null;
  const footer = [levelLabel, modelLabel, message.usage ? formatMicroUsdPrecise(message.usage.costUsdMicros) : null].filter((x): x is string => !!x);
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
          {steps.map((step) => <AiStepDisclosure key={step.name} step={step} />)}
        </ul>
      )}
      {plan && plan.length > 0 && <AiPlanChecklist steps={plan} />}
      {text ? (
        <div className="ai-message-text ai-markdown" aria-live={active ? 'polite' : 'off'}>
          {/* S2: record chips only from stored content — never while the answer is still streaming. */}
          <SafeMarkdown text={text} renderRecord={active ? undefined : (ref, key) => <AiRecordChip key={key} recordRef={ref} />} />
        </div>
      ) : active ? (
        <div className="ai-pending" role="status"><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /><span>{status === 'queued' ? 'Waiting for the assistant…' : 'Preparing an answer…'}</span></div>
      ) : null}
      {cards}
      {status === 'waiting_for_input' && <p className="ai-turn-note" role="note">Waiting for your answer below.</p>}
      {status === 'failed' && (
        // U1 state 6, fourth banner: the error face, the fixed reason for this code, and "Try again" (puts the question
        // back in the composer; nothing is re-sent automatically). AI_CONTEXT_FULL offers a new conversation instead.
        <AiBanner
          kind="failed"
          icon={<AiAssistantAvatar look={{ ...assistant.look, colour: 'red' }} state="error" size={20} />}
          detail={AI_TURN_ERROR_TEXT[errorCode ?? ''] ?? AI_TURN_ERROR_TEXT.AI_INTERNAL_ERROR}
          onRetry={errorCode === 'AI_CONTEXT_FULL' ? undefined : onRetry}
          action={errorCode === 'AI_CONTEXT_FULL' && onStartNew ? <button type="button" className="ai-link-btn" onClick={onStartNew}>Start a new conversation</button> : undefined}
        />
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
          {footer.length > 0 && <span className="ai-message-meta">{footer.join(' · ')}</span>}
        </div>
      )}
    </article>
  );
}
