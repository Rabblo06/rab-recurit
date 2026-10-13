import { useId, useLayoutEffect, useRef, type RefObject } from 'react';
import { IconArrowUp, IconPlayerStop } from '@tabler/icons-react';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend?: () => void;
  onStop?: () => void;
  sending?: boolean;
  disabled?: boolean;
  unavailable?: boolean;
  error?: string;
  inputRef?: RefObject<HTMLTextAreaElement>;
  models?: string[];
  model?: string;
  onModelChange?: (model: string) => void;
}

export default function ChatComposer({ value, onChange, onSend, onStop, sending = false, disabled = false, unavailable = false, error, inputRef, models, model, onModelChange }: ChatComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const statusId = useId();
  const canSend = !disabled && !unavailable && !sending && !!onSend && !!value.trim();
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(240, Math.max(72, input.scrollHeight))}px`;
  }, [value, ref]);
  return <div className="ai-composer-area">
    <div className={`ai-composer${error ? ' has-error' : ''}`} aria-busy={sending}>
      <textarea ref={ref} aria-label="Message Crewflow AI" aria-describedby={statusId} value={value}
        placeholder="Ask about your team, shifts and venues…" disabled={disabled} rows={3}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); if (canSend) onSend?.();
          }
        }} />
      <div className="ai-composer-actions">
        {models?.length && onModelChange ? <select aria-label="AI model" value={model} disabled={disabled || sending || unavailable} onChange={e => onModelChange(e.target.value)}>{models.map(name => <option key={name}>{name}</option>)}</select> : <span className="ai-composer-note">{unavailable ? 'AI not configured' : 'Shift + Enter for a new line'}</span>}
        {sending && onStop ? <button className="ai-send" aria-label="Stop response" onClick={onStop}><IconPlayerStop size={16}/></button>
          : <button className="ai-send" aria-label="Send message" disabled={!canSend} title={unavailable ? 'AI is not configured' : 'Send message'} onClick={() => { if (canSend) onSend?.(); }}><IconArrowUp size={17}/></button>}
      </div>
    </div>
    <p id={statusId} className={error ? 'ai-status ai-error' : 'ai-status'} role={error ? 'alert' : 'status'}>
      {error || (unavailable ? 'AI is not configured. Your draft stays in this tab until you leave or sign out.' : '')}
    </p>
  </div>;
}
