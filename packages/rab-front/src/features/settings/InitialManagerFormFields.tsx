import { useState, type ReactNode } from 'react';
import { IconSend } from '@tabler/icons-react';

export interface InitialManagerFormValues { email: string }

/** Shared email-only invitation/replacement form. Recipients enter their names during profile setup. */
export default function InitialManagerFormFields({ idPrefix, onSubmit, submitting, submitLabel, error, disabled = false, roleControl, draftEmail, onDraftEmailChange }: {
  idPrefix: string;
  onSubmit: (values: InitialManagerFormValues) => void;
  submitting: boolean;
  submitLabel: string;
  error?: string;
  disabled?: boolean;
  roleControl?: ReactNode;
  draftEmail?: string;
  onDraftEmailChange?: (email: string) => void;
}) {
  const [localEmail, setLocalEmail] = useState('');
  const email = draftEmail ?? localEmail;
  const setEmail = onDraftEmailChange ?? setLocalEmail;
  const canSubmit = email.trim().length > 0 && !submitting && !disabled;
  return <form className="initial-manager-form compact-invite-form inline-invite-form leadership-invite-form" onSubmit={event => {
    event.preventDefault();
    if (canSubmit) onSubmit({ email: email.trim() });
  }}>
    <div className="invite-field">
      <label htmlFor={`${idPrefix}-email`}>Email</label>
      <div className="invite-email-group">
      <input required disabled={submitting || disabled} id={`${idPrefix}-email`} type="email" value={email}
        placeholder="name@company.com" onChange={event => setEmail(event.target.value)} autoFocus={draftEmail === undefined} />
      </div>
    </div>
    <div className="invite-field">{roleControl}</div>
    <button type="submit" className="btn btn-dark invite-submit" aria-label={submitLabel} disabled={!canSubmit}>
      <IconSend size={14} aria-hidden="true" />{submitting ? 'Sending…' : 'Invite'}
    </button>
    {error && <p role="alert" className="error">{error}</p>}
  </form>;
}
