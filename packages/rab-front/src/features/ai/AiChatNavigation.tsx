import { IconMessageCircle, IconPlus } from '@tabler/icons-react';
import { useAiChat } from './AiChatProvider';

export default function AiChatNavigation() {
  const chat = useAiChat();
  const items = chat.current.text.trim()
    ? [chat.current, ...chat.drafts.filter(item => item.id !== chat.current.id)] : chat.drafts.filter(item => item.id !== chat.current.id);
  return <div className="sidebar-section ai-navigation">
    <button className="nav-item" title="New chat" aria-label="New chat" onClick={chat.newChat}><IconPlus size={16}/><span>New chat</span></button>
    <p className="sidebar-section-label">Recent drafts</p>
    <nav className="sidebar-nav" aria-label="Recent chat drafts">{items.map(item => <button key={item.id} title={item.text} aria-label={`Open draft: ${item.text}`} aria-current={item.id === chat.current.id ? 'true' : undefined} className={`nav-item${item.id === chat.current.id ? ' active' : ''}`} onClick={() => chat.selectDraft(item.id)}><IconMessageCircle size={16}/><span>{item.text}</span></button>)}</nav>
    <p className="ai-history-note">{items.length ? 'Unsent drafts · this tab only' : 'No conversations yet. AI is not configured.'}</p>
  </div>;
}
