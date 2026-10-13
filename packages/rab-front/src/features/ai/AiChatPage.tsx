import ChatBody from './ChatBody';
import { useAiChat } from './AiChatProvider';

export default function AiChatPage() {
  const chat = useAiChat();
  return <ChatBody surface="page" value={chat.current.text} onChange={chat.setDraft} unavailable />;
}
