import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
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

/** A quick action of the empty state (TW-D12): pre-fills a question, or opens a sheet. Never sends on its own. */
export interface ChatQuickAction {
  label: string;
  Icon: ComponentType<{ size?: number }>;
  /** Text placed in the composer (the user still presses send). */
  prompt?: string;
  onClick?: () => void;
}

/** Same body and stable composer for page, dock and isolated component fixtures. */
export default function ChatBody({ surface, messages, hasMessages = false, autoFocus = true, top, bottom, emptyTitle = 'What can I help you with?', emptyAvatar, quickActions = [], ...composer }: ChatComposerProps & {
  surface: 'page' | 'panel'; messages?: ReactNode; hasMessages?: boolean; autoFocus?: boolean;
  /** Above the transcript (conversation title, usage). */
  top?: ReactNode;
  /** Under the composer (the accuracy notice). */
  bottom?: ReactNode;
  emptyTitle?: string;
  /** The assistant's avatar above the empty title (H1). */
  emptyAvatar?: ReactNode;
  /** TW-D12 quick actions, shown before the example questions. */
  quickActions?: ChatQuickAction[];
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
        {emptyAvatar && <div className="ai-empty-avatar">{emptyAvatar}</div>}
        <h1>{emptyTitle}</h1>
        {quickActions.length > 0 && <div className="ai-quick-actions">{quickActions.map(({ label, Icon, prompt, onClick }) => <button key={label} type="button" disabled={composer.disabled || composer.unavailable} onClick={() => { if (prompt) { composer.onChange(prompt); inputRef.current?.focus(); } onClick?.(); }}><Icon size={15}/>{label}</button>)}</div>}
        <div className="ai-suggestions">{AI_EXAMPLE_PROMPTS.map(({ text, Icon }, index) => <button key={text} style={{ animationDelay: `${index * 35}ms` }} disabled={composer.disabled || composer.unavailable} onClick={() => { composer.onChange(text); inputRef.current?.focus(); }}><Icon size={15}/>{text}</button>)}</div>
      </div>}
    </div>
    <div className="ai-content-column"><ChatComposer {...composer} inputRef={inputRef}/>{bottom}</div>
    <div className="ai-bottom-space" aria-hidden="true"/>
  </section>;
}
