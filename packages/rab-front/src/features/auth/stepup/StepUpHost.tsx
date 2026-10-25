import { useEffect, useRef, useState } from 'react';

import { api, registerStepUpHandler } from '../../../shared/api';
import ModalFrame from '../../../shared/components/ModalFrame';
import { getApiErrorMessage } from '../../../shared/lib/apiError';

interface Pending {
  mfa: boolean;
  resolve: (ok: boolean) => void;
}

type ReauthProvider = 'google' | 'microsoft';

/** What the dialog needs to know about the signed-in account (from `GET /auth/mfa`; never anything about another account). */
interface AccountProof {
  hasPassword: boolean;
  ssoReauthProviders: ReauthProvider[];
}

const PROVIDER_LABEL: Record<ReauthProvider, string> = { google: 'Google', microsoft: 'Microsoft' };
/** Mirrors the server's fixed allowlist (SSO_REAUTH_RETURN_PATHS); the server ignores anything else anyway. */
const REAUTH_RETURN_PATHS = ['/settings/account', '/settings/admin', '/settings/profile'];

function returnPathHint(): string | undefined {
  const path = typeof window !== 'undefined' ? window.location.pathname : '';
  return REAUTH_RETURN_PATHS.includes(path) ? path : undefined;
}

/**
 * Lane D (M10-2) — the one "Confirm it's you" dialog. A sensitive server operation answers 403 STEP_UP_REQUIRED when this
 * session has not re-proved the password (and, when the account has two-factor authentication, a current authenticator
 * code) within the server's window; `shared/api.ts` asks this host, which collects the proof, calls `POST /auth/step-up`
 * and lets the original request replay once. Nothing here grants anything: the server checks the grant on the replay
 * and on every later sensitive call; cancelling simply fails the original request.
 *
 * Account security step 1 (P6), minimal: an account with NO password (Google / Microsoft sign-in only) gets
 * "Continue with <provider>" for each provider the server says it can re-authenticate with. That is a top-level form POST
 * (the server re-checks the session and Origin, then redirects to the provider with a forced fresh login, and back to a
 * fixed settings page); the original action is not replayed across that page change — the user repeats it. An enrolled
 * account then enters its authenticator code here, which completes the step-up without a password. Visual design later.
 *
 * Recovery codes are deliberately not accepted for step-up (server rule) — they are for signing in after losing a device.
 */
export default function StepUpHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [currentPassword, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  /** Which input the error is about (it is linked to that one, which is also marked invalid and focused). */
  const [errorField, setErrorField] = useState<'password' | 'code' | null>(null);
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<AccountProof | null>(null);
  /** The provider form already went (a full-page POST): never a second one from a double click. */
  const [redirecting, setRedirecting] = useState<ReauthProvider | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const inFlight = useRef(false);
  const redirectingRef = useRef(false);

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
            setErrorField(null);
            setBusy(false);
            inFlight.current = false;
            redirectingRef.current = false;
            setRedirecting(null);
            setNeedsCode(mfa);
            setProof(null);
            setPending(next);
          }),
      ),
    [],
  );

  // Which proof this account can give. Any failure falls back to the password form (the server decides anyway).
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get<Partial<AccountProof>>('/auth/mfa');
        if (cancelled) return;
        setProof({
          hasPassword: data?.hasPassword !== false,
          ssoReauthProviders: (data?.ssoReauthProviders ?? []).filter((p): p is ReauthProvider => p === 'google' || p === 'microsoft'),
        });
      } catch {
        if (!cancelled) setProof({ hasPassword: true, ssoReauthProviders: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pending]);

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

  const usesPassword = proof?.hasPassword !== false;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const trimmed = code.replace(/\s/g, '');
    if (inFlight.current) return; // `busy` re-renders a tick late: a fast double Enter / click must not post twice
    if (usesPassword ? !currentPassword || (needsCode && trimmed.length < 6) : trimmed.length < 6) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setErrorField(null);
    try {
      // No password: the code completes a fresh provider re-authentication of this session (server-checked).
      const body = usesPassword ? (needsCode ? { currentPassword, code: trimmed } : { currentPassword }) : { code: trimmed };
      await api.post('/auth/step-up', body);
      finish(true);
    } catch (err) {
      const status = (err as { response?: { status?: number; data?: { code?: string } } }).response;
      // The server tells us the account has a factor when the password alone was not enough.
      const codeProblem = status?.data?.code === 'STEP_UP_MFA_INVALID' || status?.data?.code === 'STEP_UP_MFA_REQUIRED';
      if (codeProblem) setNeedsCode(true);
      const field = codeProblem || !usesPassword ? 'code' : 'password';
      setError(
        usesPassword
          ? getApiErrorMessage(err, 'That didn’t work. Check your password and try again.')
          : getApiErrorMessage(err, 'Continue with your sign-in provider first, then enter your code.'),
      );
      setErrorField(field);
      setCode('');
      inFlight.current = false;
      setBusy(false);
      // Focus the field the error is about, once it is enabled and rendered again.
      window.setTimeout(() => document.getElementById(field === 'code' ? 'step-up-code' : 'step-up-password')?.focus(), 0);
    }
  }

  if (!pending) return null;
  const codeOk = code.replace(/\s/g, '').length >= 6;
  const canSubmit = !busy && (usesPassword ? !!currentPassword && (!needsCode || codeOk) : needsCode && codeOk);
  const providers = proof?.ssoReauthProviders ?? [];
  const returnTo = returnPathHint();
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
          {usesPassword
            ? <>This is a sensitive change. Enter your password{needsCode ? ' and a code from your authenticator app' : ''} to continue. You won’t be asked again for a few minutes.</>
            : <>This is a sensitive change. Confirm with your sign-in provider{needsCode ? ', then enter a code from your authenticator app' : ''}. After confirming, repeat the action.</>}
        </p>
        {usesPassword && (
          <>
            <label htmlFor="step-up-password" style={{ fontSize: 13, fontWeight: 600 }}>Your current password</label>
            <input
              id="step-up-password"
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-invalid={(error && errorField === 'password') || undefined}
              aria-describedby={error && errorField === 'password' ? 'step-up-error' : undefined}
              style={{ width: '100%', margin: '6px 0 12px' }}
            />
          </>
        )}
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
              disabled={busy}
              aria-invalid={(error && errorField === 'code') || undefined}
              aria-describedby={error && errorField === 'code' ? 'step-up-error' : undefined}
              style={{ width: '100%', marginTop: 6 }}
            />
          </>
        )}
        {!usesPassword && providers.length === 0 && (
          <p role="note" style={{ fontSize: 13, marginTop: 8 }}>Your account can’t be confirmed with a provider here. Ask an administrator for help.</p>
        )}
        {error && <p id="step-up-error" role="alert" style={{ fontSize: 13, color: 'var(--color-red)', marginTop: 8 }}>{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={() => finish(false)} disabled={busy}>Cancel</button>
          {(usesPassword || needsCode) && (
            <button type="submit" className="btn btn-dark" disabled={!canSubmit} aria-busy={busy || undefined}>{busy ? 'Please wait…' : usesPassword ? 'Continue' : 'Verify code'}</button>
          )}
        </div>
      </form>
      {!usesPassword && providers.map((provider) => (
        // A top-level form POST: the server authenticates the session cookie, checks the Origin, and answers a redirect.
        <form
          key={provider}
          method="post"
          action={`${api.defaults?.baseURL ?? ''}/auth/${provider}/reauthenticate`}
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            // The page is leaving for the provider; a second click would post a second re-authentication.
            if (redirectingRef.current) {
              e.preventDefault();
              return;
            }
            redirectingRef.current = true;
            setRedirecting(provider);
          }}
        >
          {returnTo && <input type="hidden" name="returnTo" value={returnTo} />}
          <button type="submit" className="btn btn-outline" style={{ width: '100%' }} disabled={redirecting !== null} aria-busy={redirecting === provider || undefined}>
            {redirecting === provider ? `Opening ${PROVIDER_LABEL[provider]}…` : `Continue with ${PROVIDER_LABEL[provider]}`}
          </button>
        </form>
      ))}
    </ModalFrame>
  );
}
