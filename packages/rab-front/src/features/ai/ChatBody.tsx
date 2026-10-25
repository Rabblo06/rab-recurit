import { useEffect, useRef, type ReactNode } from 'react';
import { IconCalendarCheck, IconChartPie, IconClockExclamation, IconMail, IconCash } from '@tabler/icons-react';
import ChatComposer, { type ChatComposerProps } from './ChatComposer';

/** The owner brief's Phase 1 example questions — each maps to one of the five real read tools. */
export const AI_EXAMPLE_PROMPTS = [
  { text: 'Which shifts this weekend are unfilled?', Icon: IconCalendarCheck },
  { text: 'What is our fill rate this week?', Icon: IconChartPie },
  { text: 'How many shift offers are awaiting replies?', Icon: IconMail },
  { text: 'How many late clock-ins occurred this month?', Icon: IconClockExclamation },
  { text: 'How does this payroll period compare with the previous one?', Icon: IconCash },
];

/** Same body and stable composer for page, dock and isolated component fixtures. */
export default function ChatBody({ surface, messages, hasMessages = false, autoFocus = true, top, bottom, emptyTitle = 'What can I help you with?', ...composer }: ChatComposerProps & {
  surface: 'page' | 'panel'; messages?: ReactNode; hasMessages?: boolean; autoFocus?: boolean;
  /** Above the transcript (conversation title, usage). */
  top?: ReactNode;
  /** Under the composer (the accuracy notice). */
  bottom?: ReactNode;
  emptyTitle?: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => { if (autoFocus) inputRef.current?.focus({ preventScroll: true }); }, [autoFocus]);
  useEffect(() => {
    if (stickToBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });
  return <section className={`ai-chat-body ai-chat-${surface}${hasMessages ? ' has-messages' : ' is-empty'}`} aria-label="AI Assistant">
    {top && <div className="ai-content-column ai-chat-top">{top}</div>}
    <div className="ai-messages" ref={scroller} onScroll={e => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64; }}>
      {hasMessages ? <div className="ai-content-column">{messages}</div> : <div className="ai-empty ai-content-column">
        <h1>{emptyTitle}</h1>
        <div className="ai-suggestions">{AI_EXAMPLE_PROMPTS.map(({ text, Icon }, index) => <button key={text} style={{ animationDelay: `${index * 35}ms` }} disabled={composer.disabled || composer.unavailable} onClick={() => { composer.onChange(text); inputRef.current?.focus(); }}><Icon size={15}/>{text}</button>)}</div>
      </div>}
    </div>
    <div className="ai-content-column"><ChatComposer {...composer} inputRef={inputRef}/>{bottom}</div>
    <div className="ai-bottom-space" aria-hidden="true"/>
  </section>;
}
