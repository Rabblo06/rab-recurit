import { useEffect, useState } from 'react';
import ModalFrame from '../../shared/components/ModalFrame';

/**
 * Owner decision 73 (b): deleting a user is a hold-to-confirm gesture (intent) FOLLOWED by the existing step-up: the actor
 * re-enters their own current password, which the DELETE routes verify server-side before anything else runs (P2.8).
 * The hold alone never deletes. Same `.modal` look as EmailChangeStepUpDialog / ConfirmDialog.
 */
export default function DeletePasswordPrompt({
  title,
  description,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  description: string;
  busy: boolean;
  onSubmit: (currentPassword: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'delete-step-up-title' }}
    >
      <form onSubmit={(e) => { e.preventDefault(); if (password && !busy) onSubmit(password); }}>
        <h3 id="delete-step-up-title">{title}</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>{description}</p>
        <label htmlFor="delete-step-up-password" style={{ fontSize: 13, fontWeight: 600 }}>Your current password</label>
        <input
          id="delete-step-up-password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          autoFocus
        />
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-danger" disabled={!password || busy}>{busy ? 'Deleting…' : 'Delete'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
