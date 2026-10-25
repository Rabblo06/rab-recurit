import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconChevronLeft, IconHistory, IconMaximize, IconPencilPlus, IconX } from '@tabler/icons-react';
import RightSidePanel from '../../shared/components/RightSidePanel';
import AiChatPanel from './AiChatPanel';
import AiConversationList from './AiConversationList';
import { useAiAvailability } from './useAiAvailability';
import { useAiChat } from './AiChatProvider';

export default function AskAiPanel({ onExpand }: { onExpand: () => void }) {
  const chat = useAiChat();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const [history, setHistory] = useState(false);
  const { eligible } = useAiAvailability();
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (width: number) => Math.max(320, Math.min(600, width, window.innerWidth - 360));
  useEffect(() => {
    const onOtherPanel = (event: Event) => { if (!(event as CustomEvent).detail?.persistent) chat.setPanelOpen(false); };
    document.addEventListener('crewflow:panel-open', onOtherPanel);
    return () => document.removeEventListener('crewflow:panel-open', onOtherPanel);
  }, [chat.setPanelOpen]);
  useLayoutEffect(() => {
    if (chat.panelOpen) triggerRef.current = document.activeElement as HTMLElement;
  }, [chat.panelOpen]);
  const close = () => { chat.setPanelOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  return <RightSidePanel open={chat.panelOpen} onClose={close} width={chat.panelWidth} persistent resizing={resizing} className="ai-panel-dock">
    <aside className="ai-panel-content" aria-label="Ask AI">
      <div role="separator" tabIndex={0} aria-label="Resize Ask AI panel" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={600} aria-valuenow={chat.panelWidth} className="ai-panel-resize"
        onKeyDown={event => { const delta = event.key === 'ArrowLeft' ? 20 : event.key === 'ArrowRight' ? -20 : 0; if (delta) { event.preventDefault(); chat.setPanelWidth(clamp(chat.panelWidth + delta)); } }}
        onPointerDown={event => { drag.current = { x: event.clientX, width: chat.panelWidth }; setResizing(true); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (drag.current) chat.setPanelWidth(clamp(drag.current.width + drag.current.x - event.clientX)); }}
        onPointerUp={() => { drag.current = null; setResizing(false); }} onPointerCancel={() => { drag.current = null; setResizing(false); }} />
      <header className="ai-panel-header">
        <button className="btn-icon" aria-label="Back to workspace" title="Back to workspace" onClick={close}><IconChevronLeft size={16}/></button><strong>Ask AI</strong>
        {eligible && <button className="btn-icon" aria-label={history ? 'Hide history' : 'Show history'} aria-pressed={history} title="Conversation history" onClick={() => setHistory(v => !v)}><IconHistory size={16}/></button>}
        {eligible && <button className="btn-icon" aria-label="New chat" title="New chat" onClick={() => { chat.newChat(); setHistory(false); }}><IconPencilPlus size={16}/></button>}
        <button className="btn-icon" aria-label="Expand chat" title="Expand chat" onClick={onExpand}><IconMaximize size={16}/></button>
        <button className="btn-icon" aria-label="Close Ask AI" title="Close Ask AI" onClick={close}><IconX size={16}/></button>
      </header>
      {history && eligible
        ? <div className="ai-panel-history"><AiConversationList enabled compact onSelect={() => setHistory(false)} /></div>
        : chat.panelOpen && <AiChatPanel surface="panel" />}
    </aside>
  </RightSidePanel>;
}
