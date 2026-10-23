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
 */
export default function LoginHandoffLanding() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const ran = useRef(false);
  const [state, setState] = useState<'working' | 'expired' | 'unavailable'>('working');

  async function exchange(token: string): Promise<void> {
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
      setState(isTransientAuthFailure(error) && !(error as { response?: unknown }).response ? 'unavailable' : 'expired');
    }
  }

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = takeTokenFromFragment();
    if (!token) {
      setState('expired');
      return;
    }
    void exchange(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'working') {
    return (
      <AuthLayout>
        <p role="status" style={s.subtitle}>Signing you in to your workspace…</p>
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
