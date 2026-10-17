import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, getLastIdentityFailure, getLastMeSnapshot, isTransientAuthFailure, resolveIdentityViaCookie, withAuthLock } from '../../shared/api';
import { getSessionStatus } from '../../shared/lib/auth-session';
import AuthLayout from './AuthLayout';
import { s } from './authStyles';

interface HandoffSummary {
  intent: 'sign_in' | 'accept_invitation';
  provider: 'google' | 'microsoft';
  email: string;
  returnTo: string;
  secondFactor: 'none' | 'verify' | 'enroll';
  invitation: { email: string; workspaceName: string | null; roleLabel: string } | null;
}

type View =
  | { kind: 'working' }
  | { kind: 'confirm-invitation'; summary: HandoffSummary }
  | { kind: 'unavailable'; retry: () => void }
  | { kind: 'second-factor' };

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

  async function finishWithIdentity(target: { mustResetPassword: boolean; returnTo: string }, onRetry: () => void): Promise<void> {
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
      await finishWithIdentity(data, () => void finishWithIdentity(data, () => undefined));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 409 && (error.response.data as { code?: string })?.code === 'SECOND_FACTOR_REQUIRED') {
        setView({ kind: 'second-factor' });
        return;
      }
      if (isTransientAuthFailure(error)) {
        setView({ kind: 'unavailable', retry: () => void complete(intent) });
        return;
      }
      nav(failTo, { replace: true });
    }
  }

  async function startHandoff(): Promise<void> {
    setView({ kind: 'working' });
    try {
      const { data } = await axios.get<HandoffSummary>(`${base}/auth/oauth/handoff`, { withCredentials: true });
      if (data.secondFactor !== 'none') {
        setView({ kind: 'second-factor' });
        return;
      }
      if (data.intent === 'accept_invitation') {
        setView({ kind: 'confirm-invitation', summary: data });
        return;
      }
      await complete('sign_in');
    } catch (error) {
      if (isTransientAuthFailure(error)) {
        setView({ kind: 'unavailable', retry: () => void startHandoff() });
        return;
      }
      // Already used (e.g. the Back button returned here after signing in) or expired.
      nav(getSessionStatus() === 'authenticated' ? '/' : '/login?oauthError=1', { replace: true });
    }
  }

  async function cancel(): Promise<void> {
    try {
      await axios.post(`${base}/auth/oauth/cancel`, {}, { withCredentials: true });
    } finally {
      nav('/login', { replace: true });
    }
  }

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (searchParams.get('handoff') === '1') {
      void startHandoff();
      return;
    }
    const legacyTarget = { mustResetPassword: searchParams.get('mustResetPassword') === 'true', returnTo: searchParams.get('returnTo') ?? '/' };
    const retry = () => void finishWithIdentity(legacyTarget, retry);
    void finishWithIdentity(legacyTarget, retry);
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
        <button type="button" style={s.submitBtn} onClick={view.retry}>Try again</button>
      </AuthLayout>
    );
  }
  if (view.kind === 'second-factor') {
    return (
      <AuthLayout>
        <h1 style={s.title}>Additional verification required</h1>
        <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>Your workspace requires another verification step that isn’t available yet. Contact your administrator.</p>
        <button type="button" style={s.submitBtn} onClick={() => void cancel()}>Back to sign in</button>
      </AuthLayout>
    );
  }
  const { invitation, email } = view.summary;
  return (
    <AuthLayout>
      <h1 style={s.title}>{invitation?.workspaceName ? `Join ${invitation.workspaceName}` : 'Join your team'}</h1>
      <p style={s.subtitle}>
        You’ve been invited as {invitation?.roleLabel ?? 'a member'}. You’ll sign in with {view.summary.provider === 'google' ? 'Google' : 'Microsoft'} as <strong>{email}</strong>.
      </p>
      <button type="button" style={s.submitBtn} onClick={() => void complete('accept_invitation')}>Accept invitation</button>
      <button type="button" style={{ ...s.submitBtn, background: 'transparent', color: 'inherit', border: '1px solid currentColor', marginTop: 10 }} onClick={() => void cancel()}>
        Cancel
      </button>
    </AuthLayout>
  );
}
