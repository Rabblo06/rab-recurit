import { useId, useState, type ReactNode } from 'react';

import { AcsIcon, type AcsIconName } from './icons';

/** The design's `emblem()`: a 52px mint tile with a green stroke icon. */
export function Emblem({ icon = 'shield' }: { icon?: AcsIconName }) {
  return (
    <div className="acs-emblem" aria-hidden="true">
      <AcsIcon name={icon} />
    </div>
  );
}

/** The design's `badge()`: On (mint) / Off (quiet), always with text so the state never depends on colour alone. */
export function StatusBadge({
  on,
  dot = true,
  children,
}: {
  on: boolean;
  /** The design's On/Off badges have a dot; a plain label badge ("This device") has none. */
  dot?: boolean;
  children?: ReactNode;
}) {
  return (
    <span className={on ? 'acs-badge acs-badge--on' : 'acs-badge'}>
      {dot && <span className="acs-badge-dot" aria-hidden="true" />}
      {children ?? (on ? 'On' : 'Off')}
    </span>
  );
}

export type NoticeTone = 'info' | 'error' | 'success' | 'warning';

/**
 * The design's `notice()`. `live` makes it a live region: errors are `role="alert"` (announced at once), other changing
 * notices `role="status"`. A static, always-there notice needs neither.
 */
export function Notice({
  tone = 'info',
  live = false,
  id,
  children,
}: {
  tone?: NoticeTone;
  live?: boolean;
  id?: string;
  children: ReactNode;
}) {
  const role = live ? (tone === 'error' ? 'alert' : 'status') : undefined;
  return (
    <div id={id} className={`acs-notice acs-notice--${tone}`} role={role}>
      <AcsIcon name={tone === 'success' ? 'check' : 'info'} />
      <span>{children}</span>
    </div>
  );
}

/** A field's own error, directly under it, announced (`role="alert"`) and linked through `aria-describedby`. */
export function FieldError({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <p id={id} className="acs-field-error" role="alert">
      {children}
    </p>
  );
}

/** The design's `field()` for a real, editable password (with a working show/hide toggle). */
export function PasswordField({
  label = 'Current password',
  value,
  onChange,
  error,
  autoFocus,
  disabled,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** Shown under the field; the typed value is kept. */
  error?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [shown, setShown] = useState(false);
  return (
    <div className="acs-field">
      <label htmlFor={id}>{label}</label>
      <span className="acs-input-box">
        <input
          id={id}
          className={
            error
              ? 'acs-input acs-input--error acs-input--with-icon'
              : 'acs-input acs-input--with-icon'
          }
          type={shown ? 'text' : 'password'}
          autoComplete="current-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoFocus={autoFocus}
          disabled={disabled}
        />
        <button
          type="button"
          className="acs-input-toggle"
          aria-label={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown((v) => !v)}
        >
          <AcsIcon name={shown ? 'eyeOff' : 'eye'} />
        </button>
      </span>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}

/** A labelled text field (recovery code). */
export function TextField({
  label,
  value,
  onChange,
  error,
  invalid = false,
  describedBy,
  placeholder,
  autoFocus,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Shown under the field; the typed value is kept. */
  error?: string;
  /** Marks the field invalid when the message is rendered elsewhere (`describedBy`). */
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const isInvalid = invalid || Boolean(error);
  return (
    <div className="acs-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className={isInvalid ? 'acs-input acs-input--error' : 'acs-input'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        placeholder={placeholder}
        aria-invalid={isInvalid || undefined}
        aria-describedby={error ? errorId : describedBy}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
