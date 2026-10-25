import { useState } from 'react';
import { IconTrash } from '@tabler/icons-react';

import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { getApiErrorStatus } from '../../shared/lib/apiError';
import { isAiBlocked, type AiAvailability, type AiBlockedAvailability } from './aiApi';
import { useAiChat } from './AiChatProvider';
import { useDeleteConversation } from './AiConversationList';
import AiMessage from './AiMessage';
import { aiBlockedMessage, AiErrorState, AiLoadingState, AiNotice, AiUnavailableState, AiUsageIndicator } from './AiStates';
import ChatBody from './ChatBody';
import { useAiAvailability } from './useAiAvailability';
import { useAiConversation } from './useAiConversation';

/**
 * The working AI chat (page and side-panel surfaces share it). Availability decides everything first: loading, an
 * unreachable service, "turned off" / "not available to you", or the conversation itself. Real API data only.
 */
export default function AiChatPanel({ surface }: { surface: 'page' | 'panel' }) {
  const availability = useAiAvailability();
  if (availability.isLoading) return <AiLoadingState />;
  if (availability.isError || !availability.data) {
    return <AiErrorState message="The AI assistant could not be reached. Check your connection and try again." onRetry={() => void availability.refetch()} busy={availability.isFetching} />;
  }
  if (isAiBlocked(availability.data)) return <AiBlockedView surface={surface} availability={availability.data} />;
  if (!availability.data.available) return <AiUnavailableState reason={availability.data.reason} />;
  return <AiConversationView surface={surface} availability={availability.data} />;
}

/**
 * Eligible, but AI is not set up (no provider key / no model) or limited to demo data (crewflow-ai-work-like-twenty.md
 * §1.4, §1.5): the chat opens, the input is DISABLED with the server's fixed text, and there is no send action at all —
 * nothing is sent, no tool runs and no usage is recorded. The draft stays local to this tab.
 */
function AiBlockedView({ surface, availability }: { surface: 'page' | 'panel'; availability: AiBlockedAvailability }) {
  const chat = useAiChat();
  const message = aiBlockedMessage(availability);
  return (
    <ChatBody
      surface={surface}
      value={chat.draft}
      onChange={chat.setDraft}
      disabled
      unavailable
      status={message}
      note={<span className="ai-composer-note">Not available yet</span>}
      placeholder={message}
      hasMessages={false}
      autoFocus={false}
      bottom={<AiNotice />}
    />
  );
}

function AiConversationView({ surface, availability }: { surface: 'page' | 'panel'; availability: Extract<AiAvailability, { available: true }> }) {
  const chat = useAiChat();
  const max = availability.limits.maxInputChars;
  const conv = useAiConversation({ available: true, maxInputChars: max });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteConversation(() => setConfirmDelete(false));
  const detail = conv.detail;
  const messages = detail.data?.messages ?? [];
  const title = detail.data?.conversation.title;
  const length = chat.draft.trim().length;
  const over = length > max;
  const limited = conv.limitSecondsLeft > 0;
  const blocked = conv.sending || conv.activeTurn || limited || over;

  if (chat.conversationId && detail.isLoading) return <AiLoadingState label="Loading the conversation…" />;
  if (chat.conversationId && detail.isError) {
    return getApiErrorStatus(detail.error) === 404 ? (
      <div className="ai-state" role="status">
        <p>This conversation is no longer available.</p>
        <button type="button" className="btn btn-outline" onClick={chat.newChat}>Start a new conversation</button>
      </div>
    ) : (
      <AiErrorState message="The conversation could not be loaded." onRetry={() => void detail.refetch()} busy={detail.isFetching} />
    );
  }

  const problem = conv.problem;
  const error = problem?.message ?? (over ? `Questions are limited to ${max.toLocaleString('en-GB')} characters. Shorten yours to send it.` : undefined);
  const statusAction = problem?.retry ? (
    <button type="button" className="ai-link-btn" onClick={problem.retry}>Try again</button>
  ) : problem?.startNew ? (
    <button type="button" className="ai-link-btn" onClick={() => { conv.clearProblem(); chat.newChat(); }}>Start a new conversation</button>
  ) : limited ? (
    <span className="ai-status-hint">You can ask again in {formatWait(conv.limitSecondsLeft)}.</span>
  ) : conv.live?.connection === 'lost' && conv.activeTurn ? (
    <button type="button" className="ai-link-btn" onClick={conv.reconnect}>Reconnect</button>
  ) : null;
  const status = conv.sending
    ? 'Sending your question…'
    : conv.live?.connection === 'lost' && conv.activeTurn
      ? 'Live updates stopped. The answer is still being prepared on the server.'
      : conv.activeTurn
        ? 'The assistant is answering. You can stop it.'
        : '';

  return (
    <>
      <ChatBody
        surface={surface}
        value={chat.draft}
        onChange={chat.setDraft}
        onSend={blocked ? undefined : () => conv.send(chat.draft)}
        onStop={conv.activeTurn && !conv.live?.cancelling ? () => void conv.cancel() : undefined}
        sending={conv.sending || conv.activeTurn}
        error={error}
        invalid={over}
        status={status}
        statusAction={statusAction}
        placeholder="Ask about shifts, fill rate, offers, attendance or payroll totals…"
        note={<span className={`ai-composer-note${over ? ' ai-error' : ''}`} aria-hidden={length < max * 0.8 ? 'true' : undefined}>{length >= max * 0.8 ? `${length.toLocaleString('en-GB')} / ${max.toLocaleString('en-GB')}` : 'Shift + Enter for a new line'}</span>}
        hasMessages={messages.length > 0}
        messages={messages.map((m) => <AiMessage key={m.id} message={m} live={conv.live?.turnId === m.id ? conv.live : null} />)}
        top={
          <div className="ai-chat-head">
            {chat.conversationId ? <strong className="ai-chat-title" title={title ?? undefined}>{title || 'Untitled conversation'}</strong> : <span className="ai-chat-title ai-muted">New conversation</span>}
            <AiUsageIndicator availability={availability} />
            {chat.conversationId && (
              <button type="button" className="btn-icon" aria-label="Delete this conversation" title="Delete this conversation" onClick={() => setConfirmDelete(true)}>
                <IconTrash size={15} />
              </button>
            )}
          </div>
        }
        bottom={<AiNotice />}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this conversation?"
        description="The questions and answers in it are deleted for good. This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={remove.busy}
        onConfirm={() => detail.data && remove.submit(detail.data.conversation)}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
