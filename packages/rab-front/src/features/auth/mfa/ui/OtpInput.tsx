import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent,
} from 'react';

export const OTP_LENGTH = 6;

const digitsOnly = (raw: string) => raw.replace(/\D/g, '');

/**
 * The design's six code boxes (`otp()`), built on ONE real input (UI_PLAN §5): `autocomplete="one-time-code"` and
 * `inputMode="numeric"`, so an authenticator's autofill, a paste ("482 913", "482-913") or a phone's code suggestion lands
 * whole; Arrow/Home/End/Backspace/Delete are the input's own; the highlighted box follows the caret. The six boxes are
 * painted underneath and hidden from assistive technology — the input carries the one label, `aria-invalid` and the
 * error description. There is deliberately no `maxLength` attribute: the browser would cut a pasted "482 913" to
 * "482 91" before it could be cleaned; the value is cleaned to six digits here instead.
 *
 * When `invalid` turns on, the wrong code stays visible in red (as designed) and is selected, so typing replaces it.
 */
export default function OtpInput({
  value,
  onChange,
  onComplete,
  label = '6-digit authentication code',
  invalid = false,
  describedBy,
  autoFocus = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Called once the sixth digit arrives (typed, pasted or autofilled). */
  onComplete?: (value: string) => void;
  label?: string;
  invalid?: boolean;
  describedBy?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);

  useEffect(() => {
    if (!invalid) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, input.value.length);
    setCaret(0);
  }, [invalid]);

  function syncCaret(): void {
    const input = inputRef.current;
    if (input) setCaret(input.selectionStart ?? input.value.length);
  }

  function commit(next: string, caretAt?: number): void {
    const clean = digitsOnly(next).slice(0, OTP_LENGTH);
    onChange(clean);
    if (caretAt !== undefined) {
      requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(
          Math.min(caretAt, clean.length),
          Math.min(caretAt, clean.length),
        );
        syncCaret();
      });
    }
    if (clean.length === OTP_LENGTH && clean !== value) onComplete?.(clean);
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>): void {
    const pasted = digitsOnly(e.clipboardData.getData('text'));
    e.preventDefault();
    if (!pasted) return;
    const input = e.currentTarget;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    // A whole code replaces whatever is there; a fragment is inserted at the caret.
    const next =
      pasted.length >= OTP_LENGTH
        ? pasted
        : value.slice(0, start) + pasted + value.slice(end);
    commit(
      next,
      pasted.length >= OTP_LENGTH ? OTP_LENGTH : start + pasted.length,
    );
  }

  // Clicking a box puts the caret on that box (the input is transparent and spans all six).
  function onMouseUp(e: MouseEvent<HTMLInputElement>): void {
    const input = e.currentTarget;
    const rect = input.getBoundingClientRect();
    if (!rect.width) return;
    const index = Math.max(
      0,
      Math.min(
        OTP_LENGTH - 1,
        Math.floor(((e.clientX - rect.left) / rect.width) * OTP_LENGTH),
      ),
    );
    const at = Math.min(index, value.length);
    input.setSelectionRange(at, at);
    setCaret(at);
  }

  const active = Math.min(caret, OTP_LENGTH - 1);
  return (
    <div className="acs-field">
      <label htmlFor={id}>{label}</label>
      <div
        className={`acs-otp${invalid ? ' acs-otp--error' : ''}${disabled ? ' acs-otp--disabled' : ''}`}
      >
        {Array.from({ length: OTP_LENGTH }, (_, i) => (
          <span
            key={i}
            aria-hidden="true"
            className={`acs-otp-box${focused && i === active ? ' acs-otp-box--active' : ''}${value[i] ? '' : ' acs-otp-box--empty'}`}
          >
            {value[i] ?? '—'}
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          className="acs-otp-input"
          value={value}
          onChange={(e) => commit(e.target.value)}
          onPaste={onPaste}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          onBlur={() => setFocused(false)}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onMouseUp={onMouseUp}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoFocus={autoFocus}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
