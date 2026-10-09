import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getLastMeSnapshot, resolveIdentityViaCookie } from '../../shared/api';

/**
 * P1C.1B (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.7.9) — the one new frontend route the
 * Google/Microsoft flow needs. The server's OAuth callback has ALREADY set `rab_rt` AND
 * `crewflow_session` (P1C.1C — both providers converge on the same `completeLogin()` password
 * login does) exactly like password login does; this route's only job is resolving THIS tab's
 * identity from that already-set cookie — the same cookie-authenticated `GET /auth/me`
 * `resolveIdentityViaCookie()` uses everywhere else (Login.tsx, app-boot bootstrap). No access
 * token, JWT, or any other credential ever transited the redirect URL to get here, and none is
 * decoded here either (P1C.1C-F).
 */
export default function OAuthCallbackComplete() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    (async () => {
      const ok = await resolveIdentityViaCookie();
      if (!ok) {
        nav('/login?oauthError=1', { replace: true });
        return;
      }
      qc.clear();
      // P1G: same cache-seeding as Login.tsx's password path — resolveIdentityViaCookie() above
      // already fetched this exact user's /auth/me body for the OAuth case too.
      const snapshot = getLastMeSnapshot();
      if (snapshot) qc.setQueryData(['me'], snapshot);
      const mustResetPassword = searchParams.get('mustResetPassword') === 'true';
      const returnTo = searchParams.get('returnTo');
      const safeReturnTo = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
      nav(mustResetPassword ? '/set-password' : safeReturnTo, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
