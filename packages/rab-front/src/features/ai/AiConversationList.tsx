import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { IconMessageCircle, IconTrash } from '@tabler/icons-react';

import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { useFeedbackMutation } from '../../shared/hooks/useFeedbackMutation';
import { timeAgo } from '../../shared/lib/timeAgo';
import { aiApi, aiKeys, type AiConversation } from './aiApi';
import { useAiChat } from './AiChatProvider';

/** The signed-in user's OWN conversations, newest first (keyset pages of 20). Nobody else's history is reachable. */
export function useAiConversationList(enabled: boolean) {
  const { scope } = useAiChat();
  return useInfiniteQuery({
    queryKey: aiKeys.list(scope),
    queryFn: ({ pageParam }) => aiApi.list(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 30_000,
    meta: { silent: true },
  });
}

/** Delete one conversation (owner only, server-confirmed). Works even when AI is switched off. */
export function useDeleteConversation(onDeleted?: (id: string) => void) {
  const chat = useAiChat();
  const qc = useQueryClient();
  return useFeedbackMutation<void, AiConversation>({
    mutationFn: (conversation) => aiApi.remove(conversation.id),
    successMessage: 'Conversation deleted',
    errorFeedback: { fallback: 'Could not delete the conversation. Please try again.', messages: { not_found: 'This conversation was already deleted.' } },
    onSuccess: (_data, conversation) => {
      if (chat.conversationId === conversation.id) chat.newChat();
      qc.removeQueries({ queryKey: aiKeys.detail(chat.scope, conversation.id) });
      void qc.invalidateQueries({ queryKey: aiKeys.list(chat.scope) });
      onDeleted?.(conversation.id);
    },
    onError: () => void qc.invalidateQueries({ queryKey: aiKeys.list(chat.scope) }),
  });
}

export default function AiConversationList({ enabled, onSelect, compact = false }: { enabled: boolean; onSelect?: (id: string) => void; compact?: boolean }) {
  const chat = useAiChat();
  const list = useAiConversationList(enabled);
  const [confirm, setConfirm] = useState<AiConversation | null>(null);
  const remove = useDeleteConversation(() => setConfirm(null));
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];

  if (!enabled) return null;
  return (
    <div className={`ai-history${compact ? ' is-compact' : ''}`}>
      <p className="sidebar-section-label">History</p>
      {list.isLoading ? (
        <p className="ai-history-note" role="status">Loading conversations…</p>
      ) : list.isError ? (
        <p className="ai-history-note" role="alert">
          Conversations could not be loaded. <button type="button" className="ai-link-btn" onClick={() => void list.refetch()}>Try again</button>
        </p>
      ) : items.length === 0 ? (
        <p className="ai-history-note">No conversations yet.</p>
      ) : (
        <nav className="sidebar-nav" aria-label="AI conversations">
          {items.map((c) => {
            const title = c.title || 'Untitled conversation';
            const current = chat.conversationId === c.id;
            return (
              <div key={c.id} className={`ai-history-row${current ? ' active' : ''}`}>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={current ? 'true' : undefined}
                  title={`${title} · ${timeAgo(c.lastMessageAt)}`}
                  onClick={() => {
                    chat.selectConversation(c.id);
                    onSelect?.(c.id);
                  }}
                >
                  <IconMessageCircle size={16} aria-hidden="true" />
                  <span>{title}</span>
                </button>
                <button type="button" className="btn-icon ai-history-delete" aria-label={`Delete conversation: ${title}`} title="Delete conversation" onClick={() => setConfirm(c)}>
                  <IconTrash size={14} />
                </button>
              </div>
            );
          })}
          {list.hasNextPage && (
            <button type="button" className="ai-link-btn ai-history-more" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? 'Loading…' : 'Show older conversations'}
            </button>
          )}
        </nav>
      )}
      <ConfirmDialog
        open={!!confirm}
        title="Delete this conversation?"
        description="The questions and answers in it are deleted for good. This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={remove.busy}
        onConfirm={() => confirm && remove.submit(confirm)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
