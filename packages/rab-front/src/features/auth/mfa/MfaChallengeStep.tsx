import { useState } from 'react';

import { api, withAuthLock } from '../../../shared/api';
import { s } from '../authStyles';
import EnrolmentQr from './EnrolmentQr';
import { EnrolmentMaterial, isChallengeGone, mfaErrorMessage, SecondFactorChallenge } from './mfaApi';
import RecoveryCodesList from './RecoveryCodesList';

/** What a completed challenge returns (same body as a successful /auth/login for the web). */
export interface SignedInBody {
  mustResetPassword: boolean;
  sessionExpiresAt?: string;
}

type View =
  | { kind: 'code' }
  | { kind: 'recovery' }
  | { kind: 'enrol-intro' }
  | { kind: 'enrol-scan'; material: EnrolmentMaterial }
  | { kind: 'enrol-codes'; codes: string[]; body: SignedInBody }
  | { kind: 'gone'; message: string };

/**
 * Wave 4 lane MFA — the second step of a sign-in that answered 409 SECOND_FACTOR_REQUIRED (password, Google or
 * Microsoft). `verify`: a six-digit code or a recovery code. `enroll` (an enforced role with no factor yet): set it up
 * right here — QR + manual key, confirm with the first code, save the recovery codes — and the sign-in finishes; the
 * account is never locked out. The session cookies are set by the server only when this step succeeds.
 */
export default function MfaChallengeStep({
  challenge,
  email,
  onSignedIn,
  onRestart,
}: {
  challenge: SecondFactorChallenge;
  email?: string;
  onSignedIn: (body: SignedInBody) => void | Promise<void>;
  onRestart: () => void;
}) {
  const [view, setView] = useState<View>(challenge.requirement === 'enroll' ? { kind: 'enrol-intro' } : { kind: 'code' });
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function fail(err: unknown): void {
    if (isChallengeGone(err)) {
      setView({ kind: 'gone', message: mfaErrorMessage(err) });
    } else {
      setError(mfaErrorMessage(err));
    }
    setBusy(false);
  }

  async function verify(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await withAuthLock(() => api.post<SignedInBody>('/auth/mfa/challenge/verify', { challengeToken: challenge.challengeToken, code: code.trim() }));
      await onSignedIn(data);
    } catch (err) {
      setCode('');
      fail(err);
    }
  }

  async function startEnrolment(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post<EnrolmentMaterial>('/auth/mfa/challenge/enrolment', { challengeToken: challenge.challengeToken });
      setView({ kind: 'enrol-scan', material: data });
      setBusy(false);
    } catch (err) {
      fail(err);
    }
  }

  async function confirmEnrolment(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await withAuthLock(() =>
        api.post<SignedInBody & { recoveryCodes: string[] }>('/auth/mfa/challenge/enrolment/confirm', { challengeToken: challenge.challengeToken, code: code.trim() }),
      );
      const { recoveryCodes, ...body } = data;
      setCode('');
      setView({ kind: 'enrol-codes', codes: recoveryCodes, body });
      setBusy(false);
    } catch (err) {
      setCode('');
      fail(err);
    }
  }

  async function cancel(): Promise<void> {
    try {
      await api.post('/auth/mfa/challenge/cancel', { challengeToken: challenge.challengeToken });
    } catch {
      // Expired or already used — nothing to cancel.
    }
    onRestart();
  }

  if (view.kind === 'gone') {
    return (
      <div>
        <h1 style={s.title}>Sign in again</h1>
        <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>{view.message}</p>
        <button type="button" style={s.submitBtn} onClick={onRestart}>Back to sign in</button>
      </div>
    );
  }

  if (view.kind === 'enrol-intro') {
    return (
      <div>
        <h1 style={s.title}>Set up two-factor authentication</h1>
        <p style={s.subtitle}>Your organisation requires a second step for this account. You’ll need an authenticator app such as Google Authenticator, Microsoft Authenticator or 1Password.</p>
        {error && <p role="alert" style={s.error}>{error}</p>}
        <button type="button" style={{ ...s.submitBtn, opacity: busy ? 0.65 : 1 }} disabled={busy} onClick={() => void startEnrolment()}>{busy ? 'Preparing…' : 'Set up now'}</button>
        <button type="button" style={s.backBtn} onClick={() => void cancel()}>← Back to sign in</button>
      </div>
    );
  }

  if (view.kind === 'enrol-scan') {
    return (
      <div>
        <h1 style={s.title}>Scan with your authenticator app</h1>
        <p style={s.subtitle}>Then enter the six-digit code it shows.</p>
        <EnrolmentQr material={view.material} />
        <form onSubmit={(e) => void confirmEnrolment(e)}>
          <CodeInput value={code} onChange={setCode} />
          {error && <p role="alert" style={s.error}>{error}</p>}
          <button type="submit" style={{ ...s.submitBtn, opacity: busy || !code ? 0.65 : 1 }} disabled={busy || !code}>{busy ? 'Checking…' : 'Turn on and sign in'}</button>
        </form>
        <button type="button" style={s.backBtn} onClick={() => void cancel()}>← Back to sign in</button>
      </div>
    );
  }

  if (view.kind === 'enrol-codes') {
    return (
      <div>
        <h1 style={s.title}>Two-factor authentication is on</h1>
        <RecoveryCodesList codes={view.codes} accountLabel={email} continueLabel="Continue" onContinue={() => void onSignedIn(view.body)} />
      </div>
    );
  }

  const recovery = view.kind === 'recovery';
  return (
    <div>
      <h1 style={s.title}>{recovery ? 'Use a recovery code' : 'Enter your authentication code'}</h1>
      <p style={s.subtitle}>{recovery ? 'Each recovery code works once.' : 'Open your authenticator app and enter the six-digit code for Crewflow.'}</p>
      <form onSubmit={(e) => void verify(e)}>
        {recovery ? (
          <>
            <label style={s.label} htmlFor="mfa-recovery">Recovery code</label>
            <input id="mfa-recovery" style={s.input} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX-XXXX" autoFocus />
          </>
        ) : (
          <CodeInput value={code} onChange={setCode} />
        )}
        {error && <p role="alert" style={s.error}>{error}</p>}
        <button type="submit" style={{ ...s.submitBtn, opacity: busy || !code ? 0.65 : 1 }} disabled={busy || !code}>{busy ? 'Checking…' : 'Verify'}</button>
      </form>
      <button
        type="button"
        style={{ ...s.backBtn, marginTop: 16 }}
        onClick={() => {
          setCode('');
          setError('');
          setView({ kind: recovery ? 'code' : 'recovery' });
        }}
      >
        {recovery ? 'Use your authenticator app instead' : 'Use a recovery code instead'}
      </button>
      <button type="button" style={{ ...s.backBtn, marginTop: 8 }} onClick={() => void cancel()}>← Back to sign in</button>
    </div>
  );
}

function CodeInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <>
      <label style={s.label} htmlFor="mfa-code">Six-digit code</label>
      <input
        id="mfa-code"
        style={{ ...s.input, letterSpacing: 4, textAlign: 'center', fontSize: 16 }}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9 ]/g, '').slice(0, 7))}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        placeholder="123 456"
        autoFocus
      />
    </>
  );
}
