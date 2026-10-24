import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconShieldCheck, IconShieldOff } from '@tabler/icons-react';

import { api } from '../../../shared/api';
import ModalFrame from '../../../shared/components/ModalFrame';
import { toast } from '../../../shared/lib/toast';
import EnrolmentQr from '../../auth/mfa/EnrolmentQr';
import { EnrolmentMaterial, mfaErrorMessage } from '../../auth/mfa/mfaApi';
import RecoveryCodesList from '../../auth/mfa/RecoveryCodesList';

interface MfaStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  enforced: boolean;
  enrolmentAvailable: boolean;
  mobileChallenged: boolean;
}

type Dialog =
  | { kind: 'enrol-password' }
  | { kind: 'enrol-scan'; material: EnrolmentMaterial }
  | { kind: 'codes'; codes: string[]; title: string }
  | { kind: 'regenerate' }
  | { kind: 'disable' }
  | null;

/**
 * Wave 4 lane MFA — Settings → Account → Two-factor authentication. Real server state only (`GET /auth/mfa`); every
 * change re-proves the user: turning it on needs the current password, and regenerating recovery codes or turning it off
 * needs the password AND a current code (authenticator or recovery code), so a borrowed or stolen session alone can't
 * change it. Turning it on or off signs out the account's other sessions.
 */
export default function TwoFactorSection({ email }: { email?: string }) {
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const { data: status, isLoading, isError } = useQuery({
    queryKey: ['auth', 'mfa'],
    queryFn: async () => (await api.get<MfaStatus>('/auth/mfa')).data,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['auth', 'mfa'] });

  return (
    <div className="settings-section">
      <h3>Two-factor authentication</h3>
      <p>Ask for a code from your authenticator app whenever you sign in to the web console.</p>
      {isLoading ? (
        <div className="settings-row"><span className="muted">Loading…</span></div>
      ) : isError || !status ? (
        <div className="settings-row"><span role="alert" style={{ color: 'var(--color-red)' }}>Two-factor status couldn’t be loaded.</span></div>
      ) : status.enabled ? (
        <>
          <div className="settings-row">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><IconShieldCheck size={14} /> Authenticator app</span>
            <span className="badge badge-active">On</span>
          </div>
          <div className="settings-row">
            <span>Recovery codes</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={status.recoveryCodesRemaining <= 2 ? '' : 'muted'} style={status.recoveryCodesRemaining <= 2 ? { color: 'var(--color-red)' } : undefined}>
                {status.recoveryCodesRemaining} left
              </span>
              <button type="button" className="btn btn-outline" onClick={() => setDialog({ kind: 'regenerate' })}>Generate new codes</button>
            </span>
          </div>
          <div className="settings-row">
            <span className="muted" style={{ fontSize: 12 }}>
              {status.enforced ? 'Required for your account by your organisation.' : status.enabledAt ? `On since ${new Date(status.enabledAt).toLocaleDateString()}.` : ''}
              {status.mobileChallenged ? ' The mobile app asks for a code too.' : ' The mobile app does not ask for a code for your account.'}
            </span>
            {!status.enforced && (
              <button type="button" className="btn btn-outline" onClick={() => setDialog({ kind: 'disable' })}>
                <IconShieldOff size={14} /> Turn off
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="settings-row">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconShieldOff size={14} /> Off{status.enforced ? ' — required for your account; you’ll be asked to set it up at your next sign-in' : ''}
          </span>
          {status.enrolmentAvailable ? (
            <button type="button" className="btn btn-dark" onClick={() => setDialog({ kind: 'enrol-password' })}>Set up</button>
          ) : (
            <span className="muted">Not available right now</span>
          )}
        </div>
      )}

      {dialog?.kind === 'enrol-password' && (
        <ProofDialog
          title="Set up two-factor authentication"
          description="Confirm your password to continue."
          askCode={false}
          submitLabel="Continue"
          onCancel={() => setDialog(null)}
          onSubmit={async ({ currentPassword }) => {
            const { data } = await api.post<EnrolmentMaterial>('/auth/mfa/enrolment', { currentPassword });
            setDialog({ kind: 'enrol-scan', material: data });
          }}
        />
      )}
      {dialog?.kind === 'enrol-scan' && (
        <ConfirmEnrolmentDialog
          material={dialog.material}
          onCancel={() => setDialog(null)}
          onConfirmed={(codes) => {
            void refresh();
            setDialog({ kind: 'codes', codes, title: 'Two-factor authentication is on' });
          }}
        />
      )}
      {dialog?.kind === 'codes' && (
        <ModalFrame open onBackdropMouseDown={() => undefined} dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mfa-codes-title' }}>
          <h3 id="mfa-codes-title">{dialog.title}</h3>
          <RecoveryCodesList codes={dialog.codes} accountLabel={email} continueLabel="Done" onContinue={() => setDialog(null)} />
        </ModalFrame>
      )}
      {dialog?.kind === 'regenerate' && (
        <ProofDialog
          title="Generate new recovery codes"
          description="Your current codes stop working. Confirm your password and enter a code from your authenticator app (or an unused recovery code)."
          askCode
          submitLabel="Generate"
          onCancel={() => setDialog(null)}
          onSubmit={async (proof) => {
            const { data } = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', proof);
            void refresh();
            setDialog({ kind: 'codes', codes: data.recoveryCodes, title: 'New recovery codes' });
          }}
        />
      )}
      {dialog?.kind === 'disable' && (
        <ProofDialog
          title="Turn off two-factor authentication"
          description="You’ll sign in with your password only, and your other sessions will be signed out. Confirm your password and enter a current code (or a recovery code)."
          askCode
          danger
          submitLabel="Turn off"
          onCancel={() => setDialog(null)}
          onSubmit={async (proof) => {
            await api.post('/auth/mfa/disable', proof);
            void refresh();
            setDialog(null);
            toast.success('Two-factor authentication is off.');
          }}
        />
      )}
    </div>
  );
}

function useEscape(onCancel: () => void, busy: boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);
}

function ProofDialog({
  title,
  description,
  askCode,
  danger,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  description: string;
  askCode: boolean;
  danger?: boolean;
  submitLabel: string;
  onSubmit: (proof: { currentPassword: string; code?: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [currentPassword, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEscape(onCancel, busy);
  const mutation = useMutation({ mutationFn: onSubmit });

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!currentPassword || (askCode && !code.trim())) return;
    setBusy(true);
    setError('');
    try {
      await mutation.mutateAsync(askCode ? { currentPassword, code: code.trim() } : { currentPassword });
    } catch (err) {
      setError(mfaErrorMessage(err));
      setCode('');
      setBusy(false);
    }
  }

  return (
    <ModalFrame open onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }} dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mfa-proof-title' }}>
      <form onSubmit={(e) => void submit(e)}>
        <h3 id="mfa-proof-title">{title}</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>{description}</p>
        <label htmlFor="mfa-proof-password" style={{ fontSize: 13, fontWeight: 600 }}>Current password</label>
        <input id="mfa-proof-password" className="input" type="password" autoComplete="current-password" autoFocus value={currentPassword} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', margin: '6px 0 12px' }} />
        {askCode && (
          <>
            <label htmlFor="mfa-proof-code" style={{ fontSize: 13, fontWeight: 600 }}>Authentication or recovery code</label>
            <input id="mfa-proof-code" className="input" autoComplete="one-time-code" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} style={{ width: '100%', marginTop: 6 }} />
          </>
        )}
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--color-red)', marginTop: 8 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className={danger ? 'btn btn-danger' : 'btn btn-dark'} disabled={busy || !currentPassword || (askCode && !code.trim())}>{busy ? 'Please wait…' : submitLabel}</button>
        </div>
      </form>
    </ModalFrame>
  );
}

function ConfirmEnrolmentDialog({ material, onConfirmed, onCancel }: { material: EnrolmentMaterial; onConfirmed: (codes: string[]) => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEscape(onCancel, busy);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enrolment/confirm', { code: code.trim() });
      onConfirmed(data.recoveryCodes);
    } catch (err) {
      setError(mfaErrorMessage(err));
      setCode('');
      setBusy(false);
    }
  }

  return (
    <ModalFrame open onBackdropMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }} dialogProps={{ role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mfa-enrol-title' }}>
      <form onSubmit={(e) => void submit(e)}>
        <h3 id="mfa-enrol-title">Scan with your authenticator app</h3>
        <p style={{ fontSize: 13, color: 'var(--font-secondary)' }}>Then enter the six-digit code it shows to turn two-factor authentication on.</p>
        <EnrolmentQr material={material} />
        <label htmlFor="mfa-enrol-code" style={{ fontSize: 13, fontWeight: 600 }}>Six-digit code</label>
        <input id="mfa-enrol-code" className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))} style={{ width: '100%', marginTop: 6 }} />
        {error && <p role="alert" style={{ fontSize: 13, color: 'var(--color-red)', marginTop: 8 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-dark" disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Turn on'}</button>
        </div>
      </form>
    </ModalFrame>
  );
}
