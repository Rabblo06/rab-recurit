import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getGeneration, getSessionId, subscribeToSession } from '../../shared/lib/auth-session';

const NEW = 'new';
const sessionKey = () => `${getGeneration()}:${getSessionId() ?? 'no-session'}`;

/**
 * Per-tab chat UI state: which server conversation is open, the unsent draft of each conversation, and the side
 * panel's presentation. Conversations and messages themselves live on the server (React Query, `useAiConversation`).
 *
 * The shell keys this provider by session epoch AND workspace (`AiChatProvider` below): a logout, another account, a
 * new session or a workspace change remounts it, so a draft, a selected conversation id or a query key from one
 * identity can never surface under another. `scope` is that same key, used in every AI query key.
 */
export function useChatSession(scope: string) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const [returnTo, setReturnTo] = useState('/');
  const draftKey = conversationId ?? NEW;
  const draft = drafts[draftKey] ?? '';
  const setDraft = useCallback((text: string) => setDrafts((all) => ({ ...all, [draftKey]: text })), [draftKey]);
  /** Writes the draft of one specific conversation (an async send must not write into whichever one is open now). */
  const setDraftFor = useCallback((id: string | null, text: string) => setDrafts((all) => ({ ...all, [id ?? NEW]: text })), []);
  /** Moves the unsent "new conversation" draft onto the conversation the server just created for it. */
  const adoptNewDraft = useCallback((id: string) => {
    setDrafts((all) => {
      const { [NEW]: moved, ...rest } = all;
      return moved === undefined ? rest : { ...rest, [id]: moved };
    });
    setConversationId(id);
  }, []);
  const newChat = useCallback(() => setConversationId(null), []);
  const selectConversation = useCallback((id: string) => setConversationId(id), []);
  return useMemo(
    () => ({ scope, conversationId, selectConversation, newChat, adoptNewDraft, draft, setDraft, setDraftFor, panelOpen, setPanelOpen, panelWidth, setPanelWidth, returnTo, setReturnTo }),
    [scope, conversationId, selectConversation, newChat, adoptNewDraft, draft, setDraft, setDraftFor, panelOpen, panelWidth, returnTo],
  );
}

export type AiChatState = ReturnType<typeof useChatSession>;

const ChatContext = createContext<AiChatState | null>(null);

function SessionScopedProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const state = useChatSession(scope);
  return <ChatContext.Provider value={state}>{children}</ChatContext.Provider>;
}

export function AiChatProvider({ children, workspaceId = 'no-workspace' }: { children: ReactNode; workspaceId?: string }) {
  const identity = useSyncExternalStore(subscribeToSession, sessionKey);
  const scope = `${identity}:${workspaceId}`;
  return <SessionScopedProvider key={scope} scope={scope}>{children}</SessionScopedProvider>;
}

export function useAiChat(): AiChatState {
  const state = useContext(ChatContext);
  if (!state) throw new Error('AI chat must be inside its session provider');
  return state;
}
