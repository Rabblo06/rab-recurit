import { useState } from 'react';
import { IconAlertTriangle, IconCheck, IconCopy, IconLoader2, IconPlayerStop, IconSparkles, IconTool } from '@tabler/icons-react';

import { AI_TOOL_LABEL, AI_TURN_ERROR_TEXT, type AiMessage as AiMessageRecord } from './aiApi';
import SafeMarkdown from './SafeMarkdown';
import type { LiveTurn } from './useAiConversation';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * One transcript entry. A user question is plain text (never Markdown). An assistant answer is rendered through
 * `SafeMarkdown` (no HTML, no images, safe links only) — while streaming from the live deltas, afterwards from the
 * persisted content. Tool activity shows the tool's name and outcome only, never its data.
 */
export default function AiMessage({ message, live }: { message: AiMessageRecord; live?: LiveTurn | null }) {
  const [copied, setCopied] = useState<'' | 'Copied' | 'Could not copy'>('');
  if (message.role === 'user') {
    return (
      <article className="ai-card ai-message user" aria-label="Your question">
        <header><time dateTime={message.createdAt}>{time(message.createdAt)}</time></header>
        <div className="ai-message-text">{message.content}</div>
      </article>
    );
  }
  const status = live?.status ?? message.status;
  const text = live ? live.text : message.content;
  const errorCode = live ? live.errorCode : message.errorCode;
  const active = status === 'queued' || status === 'running';
  const tools = live?.tools ?? message.toolCalls.map((t) => ({ name: t.name, phase: 'finished' as const, outcome: t.outcome }));
  return (
    <article className="ai-card ai-message assistant" aria-label="Assistant answer" aria-busy={active} data-status={status}>
      <header>
        <IconSparkles size={14} aria-hidden="true" />Crewflow AI
        {active && <span className="ai-turn-state"><IconLoader2 size={12} className="ai-spin" aria-hidden="true" />{live?.cancelling ? 'Stopping…' : status === 'queued' ? 'Queued' : 'Answering'}</span>}
        <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
      </header>
      {tools.length > 0 && (
        <ul className="ai-tools" aria-label="Data the assistant read">
          {tools.map((t) => (
            <li key={t.name} data-outcome={t.outcome ?? (t.phase === 'started' ? 'running' : 'ok')}>
              {t.phase === 'started' ? <IconLoader2 size={12} className="ai-spin" aria-hidden="true" /> : t.outcome && t.outcome !== 'ok' ? <IconAlertTriangle size={12} aria-hidden="true" /> : <IconTool size={12} aria-hidden="true" />}
              <span>{AI_TOOL_LABEL[t.name] ?? 'Reading workspace data'}</span>
              {t.outcome && t.outcome !== 'ok' && <span className="ai-tool-outcome">{t.outcome === 'denied' ? 'not permitted' : t.outcome === 'invalid_input' ? 'refused' : 'failed'}</span>}
            </li>
          ))}
        </ul>
      )}
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
