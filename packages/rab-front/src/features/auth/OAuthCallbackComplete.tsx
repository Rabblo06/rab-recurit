import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, getLastIdentityFailure, getLastMeSnapshot, isTransientAuthFailure, resolveIdentityViaCookie, withAuthLock } from '../../shared/api';
import { getSessionStatus } from '../../shared/lib/auth-session';
import AuthLayout from './AuthLayout';
import { s } from './authStyles';
import MfaChallengeStep from './mfa/MfaChallengeStep';
import SecurityAuthLayout from './mfa/SecurityAuthLayout';
import { SecondFactorChallenge, secondFactorChallengeOf } from './mfa/mfaApi';
import { continueOnWorkspaceHost } from './workspaceHandoff';
import { useWorkspaceHost } from '../../shared/lib/workspace-host';

interface HandoffSummary {
  intent: 'sign_in' | 'accept_invitation';
  provider: 'google' | 'microsoft';
  email: string;
  returnTo: string;
  invitation: { email: string; workspaceName: string | null; roleLabel: string } | null;
}

type View =
  | { kind: 'working' }
  | { kind: 'confirm-invitation'; summary: HandoffSummary }
  | { kind: 'unavailable'; retry: () => Promise<void> }
  | { kind: 'second-factor'; challenge: SecondFactorChallenge; returnTo: string };

const safePath = (value: string | null | undefined) => (value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/');

/**
 * `/oauth/callback-complete` — the end of a Google/Microsoft sign-in.
 *
 * Handoff mode (`?handoff=1`, AUTH_OAUTH_HANDOFF_ENABLED): the provider callback left a one-time, HttpOnly handoff
 * cookie (never anything in this URL). This page reads what the handoff is for, then redeems it with a trusted POST
 * — the server issues the session cookies only then. A sign-in completes automatically (Twenty: exactly one
 * authorised workspace ⇒ continue); accepting an invitation asks first ("Join Northwind as Supervisor?").
 *
 * Legacy mode (no `handoff`): the callback already set the session cookies; this page only resolves identity.
 *
 * Either way the identity comes from the cookie-authenticated `/auth/me`, the React Query cache is cleared for the
 * new identity, other tabs are told (broadcast inside `resolveIdentityViaCookie`), and a temporary outage shows a
 * retry instead of a sign-in error.
 */
export default function OAuthCallbackComplete() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const ran = useRef(false);
  const [view, setView] = useState<View>({ kind: 'working' });
  const base = api.defaults.baseURL;
  const host = useWorkspaceHost();
  /** One action at a time (Accept / Cancel / Try again): `busy` re-renders a tick late, the ref does not. */
  const actionInFlight = useRef(false);
  const [busy, setBusy] = useState<'accept' | 'cancel' | 'retry' | null>(null);

  async function runOnce(kind: 'accept' | 'cancel' | 'retry', action: () => Promise<void>): Promise<void> {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(kind);
    try {
      await action();
    } finally {
      actionInFlight.current = false;
      setBusy(null);
    }
  }

  async function finishWithIdentity(target: { mustResetPassword: boolean; returnTo: string }, onRetry: () => Promise<void>): Promise<void> {
    const ok = await resolveIdentityViaCookie();
    if (!ok) {
      if (getLastIdentityFailure() === 'unavailable') setView({ kind: 'unavailable', retry: onRetry });
      else nav('/login?oauthError=1', { replace: true });
      return;
    }
    qc.clear();
    // P1G: same cache-seeding as Login.tsx's password path.
    const snapshot = getLastMeSnapshot();
    if (snapshot) qc.setQueryData(['me'], snapshot);
    if (!target.mustResetPassword && (await continueOnWorkspaceHost(host))) return;
    nav(target.mustResetPassword ? '/set-password' : safePath(target.returnTo), { replace: true });
  }

  async function complete(intent: HandoffSummary['intent']): Promise<void> {
    setView({ kind: 'working' });
    const failTo = intent === 'accept_invitation' ? '/accept-invitation?oauthError=1' : '/login?oauthError=1';
    try {
      // Serialised with password login/logout across tabs, like every other credential change.
      const { data } = await withAuthLock(() =>
        axios.post<{ mustResetPassword: boolean; returnTo: string }>(`${base}/auth/oauth/complete`, {}, { withCredentials: true }),
      );
      // "Try again" re-reads the identity as often as needed (a second outage must not leave a dead button).
      const retryIdentity = (): Promise<void> => finishWithIdentity(data, retryIdentity);
      await retryIdentity();
    } catch (error) {
      // Wave 4 lane MFA: the provider proved the identity; the account's second factor is next (the handoff is spent and
      // this challenge is now the only way to finish).
      const pendingFactor = secondFactorChallengeOf(error);
      if (pendingFactor) {
        setView({ kind: 'second-factor', challenge: pendingFactor, returnTo: '/' });
        return;
      }
      if (isTransientAuthFailure(error)) {
        setView({ kind: 'unavailable', retry: () => complete(intent) });
        return;
      }
      nav(failTo, { replace: true });
    }
  }

  async function startHandoff(): Promise<void> {
    setView({ kind: 'working' });
    try {
      const { data } = await axios.get<HandoffSummary>(`${base}/auth/oauth/handoff`, { withCredentials: true });
      if (data.intent === 'accept_invitation') {
        setView({ kind: 'confirm-invitation', summary: data });
        return;
      }
      await complete('sign_in');
    } catch (error) {
      if (isTransientAuthFailure(error)) {
        setView({ kind: 'unavailable', retry: () => startHandoff() });
        return;
      }
      // Already used (e.g. the Back button returned here after signing in) or expired.
      nav(getSessionStatus() === 'authenticated' ? '/' : '/login?oauthError=1', { replace: true });
    }
  }

  async function cancel(): Promise<void> {
    try {
      await axios.post(`${base}/auth/oauth/cancel`, {}, { withCredentials: true });
    } catch {
      // Already used or expired: there is nothing left to cancel, and the handoff cookie dies on its own.
    }
    nav('/login', { replace: true });
  }

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (searchParams.get('handoff') === '1') {
      void startHandoff();
      return;
    }
    const legacyTarget = { mustResetPassword: searchParams.get('mustResetPassword') === 'true', returnTo: searchParams.get('returnTo') ?? '/' };
    const retry = (): Promise<void> => finishWithIdentity(legacyTarget, retry);
    void retry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (view.kind === 'working') {
    return (
      <AuthLayout>
        <p role="status" style={s.subtitle}>Signing you in…</p>
      </AuthLayout>
    );
  }
  if (view.kind === 'unavailable') {
    return (
      <AuthLayout>
        <h1 style={s.title}>We couldn’t reach Crewflow</h1>
        <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Check your connection and try again. You haven’t been signed out.</p>
        <button
          type="button"
          style={{ ...s.submitBtn, opacity: busy ? 0.65 : 1 }}
          disabled={busy !== null}
          aria-busy={busy === 'retry' || undefined}
          onClick={() => void runOnce('retry', view.retry)}
        >
          {busy === 'retry' ? 'Trying again…' : 'Try again'}
        </button>
      </AuthLayout>
    );
  }
  if (view.kind === 'second-factor') {
    const { challenge, returnTo } = view;
    return (
      <SecurityAuthLayout>
        <MfaChallengeStep
          challenge={challenge}
          onSignedIn={(body) => finishWithIdentity({ mustResetPassword: body.mustResetPassword, returnTo }, async () => nav('/login', { replace: true }))}
          onRestart={() => nav('/login', { replace: true })}
        />
      </SecurityAuthLayout>
    );
  }
  const { invitation, email } = view.summary;
  return (
    <AuthLayout>
      <h1 style={s.title}>{invitation?.workspaceName ? `Join ${invitation.workspaceName}` : 'Join your team'}</h1>
      <p style={s.subtitle}>
        You’ve been invited as {invitation?.roleLabel ?? 'a member'}. You’ll sign in with {view.summary.provider === 'google' ? 'Google' : 'Microsoft'} as <strong>{email}</strong>.
      </p>
      <button
        type="button"
        style={{ ...s.submitBtn, opacity: busy ? 0.65 : 1 }}
        disabled={busy !== null}
        aria-busy={busy === 'accept' || undefined}
        onClick={() => void runOnce('accept', () => complete('accept_invitation'))}
      >
        {busy === 'accept' ? 'Accepting…' : 'Accept invitation'}
      </button>
      <button
        type="button"
        style={{ ...s.submitBtn, background: 'transparent', color: 'inherit', border: '1px solid currentColor', marginTop: 10, opacity: busy ? 0.65 : 1 }}
        disabled={busy !== null}
        aria-busy={busy === 'cancel' || undefined}
        onClick={() => void runOnce('cancel', cancel)}
      >
        {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
      </button>
    </AuthLayout>
  );
}
