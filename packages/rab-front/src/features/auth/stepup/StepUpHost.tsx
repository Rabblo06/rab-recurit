import { useEffect, useRef, useState } from 'react';

import { api, registerStepUpHandler } from '../../../shared/api';
import ModalFrame from '../../../shared/components/ModalFrame';
import { getApiErrorMessage } from '../../../shared/lib/apiError';

interface Pending {
  mfa: boolean;
  resolve: (ok: boolean) => void;
}

/**
 * Lane D (M10-2) — the one "Confirm it's you" dialog. A sensitive server operation answers 403 STEP_UP_REQUIRED when this
 * session has not re-proved the password (and, when the account has two-factor authentication, a current authenticator
 * code) within the server's window; `shared/api.ts` asks this host, which collects the proof, calls `POST /auth/step-up`
 * and lets the original request replay once. Nothing here grants anything: the server checks the grant on the replay
 * and on every later sensitive call; cancelling simply fails the original request.
 *
 * Recovery codes are deliberately not accepted for step-up (server rule) — they are for signing in after losing a device.
 */
export default function StepUpHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [currentPassword, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<Pending | null>(null);

  useEffect(
    () =>
      registerStepUpHandler(
        ({ mfa }) =>
          new Promise<boolean>((resolve) => {
            // Only one prompt at a time; `shared/api.ts` already shares it between concurrent refusals.
            pendingRef.current?.resolve(false);
            const next = { mfa, resolve };
            pendingRef.current = next;
            setPassword('');
            setCode('');
            setError('');
            setBusy(false);
            setNeedsCode(mfa);
            setPending(next);
          }),
      ),
    [],
  );

  function finish(ok: boolean): void {
    pendingRef.current?.resolve(ok);
    pendingRef.current = null;
    setPending(null);
    setPassword('');
    setCode('');
  }

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) finish(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, busy]);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = code.replace(/\s/g, '');
    if (!currentPassword || (needsCode && trimmed.length < 6)) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/auth/step-up', needsCode ? { currentPassword, code: trimmed } : { currentPassword });
      finish(true);
    } catch (err) {
      const status = (err as { response?: { status?: number; data?: { code?: string } } }).response;
      // The server tells us the account has a factor when the password alone was not enough.
      if (status?.data?.code === 'STEP_UP_MFA_INVALID' || status?.data?.code === 'STEP_UP_MFA_REQUIRED') setNeedsCode(true);
      setError(getApiErrorMessage(err, 'That didn’t work. Check your password and try again.'));
      setCode('');
      setBusy(false);
    }
  }

  if (!pending) return null;
  const canSubmit = !!currentPassword && (!needsCode || code.replace(/\s/g, '').length >= 6) && !busy;
  return (
    <ModalFrame
      open
      onBackdropMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) finish(false);
      }}
      dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'step-up-title' }}
    >
      <form onSubmit={(e) => void submit(e)}>
        <h3 id="step-up-title">Confirm it’s you</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>
          This is a sensitive change. Enter your password{needsCode ? ' and a code from your authenticator app' : ''} to continue. You won’t be asked again for a few minutes.
        </p>
        <label htmlFor="step-up-password" style={{ fontSize: 13, fontWeight: 600 }}>Your current password</label>
        <input
          id="step-up-password"
          className="input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={currentPassword}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', margin: '6px 0 12px' }}
        />
        {needsCode && (
          <>
            <label htmlFor="step-up-code" style={{ fontSize: 13, fontWeight: 600 }}>Six-digit code</label>
            <input
              id="step-up-code"
              className="input"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))}
              style={{ width: '100%', marginTop: 6 }}
            />
          </>
        )}
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--color-red)', marginTop: 8 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={() => finish(false)} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-dark" disabled={!canSubmit}>{busy ? 'Please wait…' : 'Continue'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
