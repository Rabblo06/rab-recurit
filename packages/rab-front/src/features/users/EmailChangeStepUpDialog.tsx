import { useEffect, useState } from 'react';
import ModalFrame from '../../shared/components/ModalFrame';
import { getApiErrorMessage } from '../../shared/lib/apiError';

/**
 * CF-04: changing the sign-in email of an account that can already sign in is a credential change. The administrator
 * confirms their OWN current password, and the change only takes effect once the new address confirms it. Built on the
 * shared `.modal-overlay` / `.modal` classes (same look as ConfirmDialog), not a new visual system.
 */
export default function EmailChangeStepUpDialog({
  newEmail,
  onSubmit,
  onCancel,
}: {
  newEmail: string;
  onSubmit: (currentPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(password);
    } catch (err: any) {
      setError(getApiErrorMessage(err, 'The email could not be changed.'));
      setBusy(false);
    }
  }

  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'email-step-up-title' }}
    >
      <form onSubmit={submit}>
        <h3 id="email-step-up-title">Confirm it’s you</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>
          We’ll send a confirmation link to <strong>{newEmail}</strong>. The account keeps its current email until that link is used, and it is then signed out everywhere.
        </p>
        <label htmlFor="email-step-up-password" style={{ fontSize: 13, fontWeight: 600 }}>Your current password</label>
        <input
          id="email-step-up-password"
          className="input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', marginTop: 6 }}
        />
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--color-red)', marginTop: 8 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-dark" disabled={busy || !password}>{busy ? 'Please wait…' : 'Send confirmation link'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
