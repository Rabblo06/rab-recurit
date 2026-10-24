import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { api, getLastIdentityFailure, getLastMeSnapshot, isTransientAuthFailure, resolveIdentityViaCookie, withAuthLock } from '../../shared/api';
import AuthLayout from './AuthLayout';
import { s } from './authStyles';

const TOKEN_PATTERN = /^lho_[A-Za-z0-9_-]{43}$/;

/** Reads the single-use token from the fragment and strips it from the address bar BEFORE anything else happens. */
function takeTokenFromFragment(): string | null {
  const match = /^#t=([^&]+)$/.exec(window.location.hash);
  // Remove it from the URL (and the history entry) immediately, whatever it contained.
  window.history.replaceState(null, '', window.location.pathname);
  const token = match ? decodeURIComponent(match[1]!) : null;
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * `/auth/handoff` on a WORKSPACE host — the landing step of the cross-host login handoff (server: LoginHandoffService).
 * The token arrives in the URL fragment (never sent to any server, never in a Referer), is stripped from the address bar
 * at once, and is exchanged with a JSON POST from this origin; the server checks that this host is the token's audience
 * and sets a brand-new host-only session cookie. Nothing else on this page can sign anyone in, and it never redirects
 * anywhere but this same origin.
 *
 * Lane D (M10-3): the token is first PEEKED (`/auth/login-handoff/peek`: read-only, never consumes or extends it) and the
 * page asks "Continue as j***@example.com?" with the workspace's name. Only an explicit Continue exchanges it. This closes
 * the login-CSRF residual of an attacker sending a victim a link minted for the ATTACKER's account: the victim sees
 * someone else's (masked) address and declines; declining sends nothing, and the unused token expires on its own.
 */
export default function LoginHandoffLanding() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const ran = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<'checking' | 'confirm' | 'working' | 'expired' | 'unavailable'>('checking');
  const [who, setWho] = useState<{ maskedEmail: string; workspaceName: string } | null>(null);

  const failureState = (error: unknown): 'expired' | 'unavailable' =>
    isTransientAuthFailure(error) && !(error as { response?: unknown }).response ? 'unavailable' : 'expired';

  async function peek(token: string): Promise<void> {
    try {
      const { data } = await api.post<{ maskedEmail: string; workspaceName: string }>('/auth/login-handoff/peek', { token });
      setWho({ maskedEmail: data.maskedEmail, workspaceName: data.workspaceName });
      setState('confirm');
    } catch (error) {
      tokenRef.current = null;
      setState(failureState(error));
    }
  }

  async function exchange(): Promise<void> {
    const token = tokenRef.current;
    // One attempt only: the server burns the token when it sees it.
    tokenRef.current = null;
    if (!token) {
      setState('expired');
      return;
    }
    setState('working');
    try {
      const { data } = await withAuthLock(() => api.post<{ mustResetPassword: boolean }>('/auth/login-handoff/exchange', { token }));
      const ok = await resolveIdentityViaCookie();
      if (!ok) {
        setState(getLastIdentityFailure() === 'unavailable' ? 'unavailable' : 'expired');
        return;
      }
      qc.clear();
      const snapshot = getLastMeSnapshot();
      if (snapshot) qc.setQueryData(['me'], snapshot);
      nav(data.mustResetPassword ? '/set-password' : '/', { replace: true });
    } catch (error) {
      // A single-use token cannot be retried after the server saw it; only a network failure leaves it unused.
      setState(failureState(error));
    }
  }

  /** "Not you?" — nothing is sent; the unused token simply expires. */
  function decline(): void {
    tokenRef.current = null;
    nav('/login', { replace: true });
  }

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = takeTokenFromFragment();
    if (!token) {
      setState('expired');
      return;
    }
    tokenRef.current = token;
    void peek(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'checking' || state === 'working') {
    return (
      <AuthLayout>
        <p role="status" style={s.subtitle}>{state === 'checking' ? 'Checking your sign-in link…' : 'Signing you in to your workspace…'}</p>
      </AuthLayout>
    );
  }
  if (state === 'confirm' && who) {
    return (
      <AuthLayout>
        <h1 style={s.title}>Continue to {who.workspaceName}?</h1>
        <p style={s.subtitle}>
          You’ll be signed in as <strong data-testid="handoff-masked-email">{who.maskedEmail}</strong>. If that isn’t you, don’t continue.
        </p>
        <button type="button" style={s.submitBtn} onClick={() => void exchange()}>Continue as {who.maskedEmail}</button>
        <button type="button" style={{ ...s.providerBtn, marginTop: 12 }} onClick={decline}>
          Not you? Sign in with another account
        </button>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <h1 style={s.title}>{state === 'unavailable' ? 'We couldn’t reach Crewflow' : 'This sign-in link has expired'}</h1>
      <p role="alert" style={{ ...s.subtitle, ...s.errorText }}>
        {state === 'unavailable' ? 'Check your connection, then sign in again.' : 'Sign-in links work once and only for a minute. Please sign in again.'}
      </p>
      <button type="button" style={s.submitBtn} onClick={() => nav('/login', { replace: true })}>Sign in</button>
    </AuthLayout>
  );
}
