import { useEffect, useState } from 'react';

import { api } from '../../../shared/api';
import ModalFrame from '../../../shared/components/ModalFrame';
import { getApiErrorMessage } from '../../../shared/lib/apiError';
import { toast } from '../../../shared/lib/toast';

/**
 * Wave 4 lane MFA — a platform administrator clears ANOTHER user's two-factor authentication (lost device). The server
 * requires the admin's own password AND a current code from the admin's OWN authenticator (an admin without MFA is
 * refused), never allows it on oneself, signs the target out everywhere and audits it in both organisations. This
 * dialog only collects that proof; every rule is server-side.
 */
export default function ResetTwoFactorDialog({ userId, userLabel, onClose }: { userId: string; userLabel: string; onClose: () => void }) {
  const [currentPassword, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!currentPassword || !code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post<{ reset: boolean }>(`/admin/users/${encodeURIComponent(userId)}/mfa/reset`, { currentPassword, code: code.trim() });
      toast.success(data.reset ? `Two-factor authentication was reset for ${userLabel}. They’ve been signed out everywhere.` : `${userLabel} didn’t have two-factor authentication turned on.`);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Two-factor authentication could not be reset.'));
      setCode('');
      setBusy(false);
    }
  }

  return (
    <ModalFrame open onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }} dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mfa-reset-title' }}>
      <form onSubmit={(e) => void submit(e)}>
        <h3 id="mfa-reset-title">Reset two-factor authentication</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>
          This removes <strong>{userLabel}</strong>’s authenticator and recovery codes and signs them out on every device. Use it only after you’ve confirmed who is asking. Confirm with your own password and a code from your own authenticator app.
        </p>
        <label htmlFor="mfa-reset-password" style={{ fontSize: 13, fontWeight: 600 }}>Your current password</label>
        <input id="mfa-reset-password" className="input" type="password" autoComplete="current-password" autoFocus value={currentPassword} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', margin: '6px 0 12px' }} />
        <label htmlFor="mfa-reset-code" style={{ fontSize: 13, fontWeight: 600 }}>Your six-digit code</label>
        <input id="mfa-reset-code" className="input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))} style={{ width: '100%', marginTop: 6 }} />
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--color-red)', marginTop: 8 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-danger" disabled={busy || !currentPassword || !code.trim()}>{busy ? 'Please wait…' : 'Reset'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
