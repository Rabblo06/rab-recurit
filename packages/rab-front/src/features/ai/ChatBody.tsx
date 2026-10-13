import { useEffect, useRef, type ReactNode } from 'react';
import { IconSparkles, IconUsers, IconCalendarCheck, IconMail } from '@tabler/icons-react';
import ChatComposer, { type ChatComposerProps } from './ChatComposer';

const prompts = [
  { text: 'Find available staff', Icon: IconUsers },
  { text: "Summarise today's shifts", Icon: IconCalendarCheck },
  { text: 'Review pending offers', Icon: IconMail },
  { text: 'Prepare a staffing plan', Icon: IconSparkles },
];

/** Same body and stable composer for page, dock and isolated component fixtures. */
export default function ChatBody({ surface, messages, hasMessages = false, autoFocus = true, ...composer }: ChatComposerProps & {
  surface: 'page' | 'panel'; messages?: ReactNode; hasMessages?: boolean; autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => {
    if (stickToBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages]);
  return <section className={`ai-chat-body ai-chat-${surface}${hasMessages ? ' has-messages' : ' is-empty'}`} aria-label="AI Assistant">
    <div className="ai-messages" ref={scroller} onScroll={e => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
      {hasMessages ? <div className="ai-content-column">{messages}</div> : <div className="ai-empty ai-content-column">
        <h1>What can I help you with?</h1>
        <div className="ai-suggestions">{prompts.map(({ text, Icon }, index) => <button key={text} style={{ animationDelay: `${index * 35}ms` }} onClick={() => { composer.onChange(text); inputRef.current?.focus(); }}><Icon size={15}/>{text}</button>)}</div>
      </div>}
    </div>
    <div className="ai-content-column"><ChatComposer {...composer} inputRef={inputRef}/></div>
    <div className="ai-bottom-space" aria-hidden="true"/>
  </section>;
}
