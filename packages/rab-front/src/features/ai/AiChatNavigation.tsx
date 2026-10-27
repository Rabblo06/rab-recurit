import { IconPlus } from '@tabler/icons-react';
import { useAiChat } from './AiChatProvider';
import AiConversationList from './AiConversationList';
import { useAiAvailability } from './useAiAvailability';

/** Sidebar of the AI mode: "New chat" and the user's own conversation history (server-side, newest first). */
export default function AiChatNavigation() {
  const chat = useAiChat();
  const { usable } = useAiAvailability();
  // History and "New chat" only when questions can actually be asked (not_configured / demo_data_only: the chat page
  // shows the disabled composer and its message; there is nothing to list).
  if (!usable) return null;
  return <div className="sidebar-section ai-navigation">
    <button type="button" className="nav-item" title="New chat" aria-label="New chat" onClick={chat.newChat}><IconPlus size={16}/><span>New chat</span></button>
    <AiConversationList enabled={usable} />
  </div>;
}
