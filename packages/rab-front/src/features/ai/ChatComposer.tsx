import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
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
  /** Replaces the default hint beside the send button (e.g. the character counter). */
  note?: ReactNode;
  /** Shown after the status line (e.g. "Try again" / "Start a new conversation" next to an error). */
  statusAction?: ReactNode;
  /** A non-error status line (e.g. "Answer in progress…"); an `error` always wins. */
  status?: string;
  placeholder?: string;
  /** Marks the textarea invalid (e.g. over the character limit) without changing the status line. */
  invalid?: boolean;
}

export default function ChatComposer({ value, onChange, onSend, onStop, sending = false, disabled = false, unavailable = false, error, inputRef, models, model, onModelChange, note, statusAction, status, placeholder, invalid = false }: ChatComposerProps) {
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
    <div className={`ai-composer${error || invalid ? ' has-error' : ''}`} aria-busy={sending}>
      <textarea ref={ref} aria-label="Message Crewflow AI" aria-describedby={statusId} value={value} aria-invalid={invalid || undefined}
        placeholder={placeholder ?? 'Ask about your team, shifts and venues…'} disabled={disabled} rows={3}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault(); if (canSend) onSend?.();
          }
        }} />
      <div className="ai-composer-actions">
        {models?.length && onModelChange ? <select aria-label="AI model" value={model} disabled={disabled || sending || unavailable} onChange={e => onModelChange(e.target.value)}>{models.map(name => <option key={name}>{name}</option>)}</select> : note ?? <span className="ai-composer-note">{unavailable ? 'AI not configured' : 'Shift + Enter for a new line'}</span>}
        {sending && onStop ? <button className="ai-send" aria-label="Stop response" onClick={onStop}><IconPlayerStop size={16}/></button>
          : <button className="ai-send" aria-label="Send message" disabled={!canSend} title={unavailable ? 'AI is not configured' : 'Send message'} onClick={() => { if (canSend) onSend?.(); }}><IconArrowUp size={17}/></button>}
      </div>
    </div>
    <div className="ai-status-row">
      <p id={statusId} className={error ? 'ai-status ai-error' : 'ai-status'} role={error ? 'alert' : 'status'}>
        {error || status || (unavailable ? 'AI is not configured. Your draft stays in this tab until you leave or sign out.' : '')}
      </p>
      {statusAction}
    </div>
  </div>;
}
