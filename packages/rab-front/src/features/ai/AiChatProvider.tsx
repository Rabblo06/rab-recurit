import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react';
import { getGeneration, getSessionId, subscribeToSession } from '../../shared/lib/auth-session';

export interface ChatDraft { id: string; text: string; }
const blankDraft = (): ChatDraft => ({ id: crypto.randomUUID(), text: '' });
const sessionKey = () => `${getGeneration()}:${getSessionId() ?? 'no-session'}`;

/** Tab-memory drafts only. The shell keys this provider by session epoch and workspace.
 * No messages, provider requests, persisted history or invented server thread IDs. */
export function useDraftSession() {
  const [current, setCurrent] = useState(blankDraft);
  const [drafts, setDrafts] = useState<ChatDraft[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const [returnTo, setReturnTo] = useState('/');
  const setDraft = (text: string) => setCurrent(value => ({ ...value, text }));
  function remember() {
    setDrafts(items => current.text.trim()
      ? [current, ...items.filter(item => item.id !== current.id)]
      : items.filter(item => item.id !== current.id));
  }
  function newChat() { remember(); setCurrent(blankDraft()); }
  function selectDraft(id: string) {
    if (id === current.id) return;
    const selected = drafts.find(item => item.id === id);
    if (!selected) return;
    remember(); setCurrent(selected);
  }
  return { current, drafts, setDraft, newChat, selectDraft, panelOpen, setPanelOpen, panelWidth, setPanelWidth, returnTo, setReturnTo };
}
const ChatContext = createContext<ReturnType<typeof useDraftSession> | null>(null);
function DraftProvider({ children }: { children: ReactNode }) {
  const state = useDraftSession();
  return <ChatContext.Provider value={state}>{children}</ChatContext.Provider>;
}
export function AiChatProvider({ children, workspaceId = 'no-workspace' }: { children: ReactNode; workspaceId?: string }) {
  const identity = useSyncExternalStore(subscribeToSession, sessionKey);
  return <DraftProvider key={`${identity}:${workspaceId}`}>{children}</DraftProvider>;
}
export function useAiChat() {
  const state = useContext(ChatContext);
  if (!state) throw new Error('AI chat must be inside its session provider');
  return state;
}
