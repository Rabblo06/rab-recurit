import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bootstrapSession, clearSessionAndRedirect, getLastIdentityFailure, getLastMeSnapshot } from '../api';
import { getSessionExpiresAt, getSessionStatus, markUnauthenticated, markUnavailable, subscribeToSession, type SessionStatus } from './auth-session';

/** Backoff for a session check that could not reach the API on boot (network/503/429) — never a logout. */
const BOOT_RETRY_DELAYS_MS = [1_000, 3_000, 8_000];

export function useSessionStatus(): SessionStatus {
  return useSyncExternalStore(subscribeToSession, getSessionStatus);
}

/**
 * Runs the one-time `bootstrapSession()` call exactly once per page load, at
 * the top of the tree — a hard reload always starts with no access token in
 * memory (see `auth-session.ts`), so this is what turns "the HttpOnly
 * refresh cookie is still valid" into a silently-restored session instead of
 * forcing a fresh login every time the tab is reopened. Deliberately a
 * component mounted once alongside `<BrowserRouter>`, not inside
 * `RequireAuth` itself — `RequireAuth` remounts on navigation between
 * top-level protected routes and would otherwise re-run this (and briefly
 * re-flash a loading state) on every such navigation.
 */
export function SessionBootstrap({ children }: { children: ReactNode }) {
  const ran = useRef(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    // No cancellation on cleanup: this runs once per page load (the `ran` guard also absorbs StrictMode's double
    // effect), and the retry chain must survive that double invocation.
    const attempt = (retry: number): void => {
      bootstrapSession().then((ok) => {
        if (!ok) {
          if (getLastIdentityFailure() === 'unavailable') {
            // Audit F5: an unreachable API is not a logged-out user. Retry with backoff, then show reconnect.
            if (retry < BOOT_RETRY_DELAYS_MS.length) setTimeout(() => attempt(retry + 1), BOOT_RETRY_DELAYS_MS[retry]);
            else markUnavailable();
            return;
          }
          markUnauthenticated();
          return;
        }
        onAuthenticated();
      });
    };
    const onAuthenticated = (): void => {
      // A successful bootstrap already called markAuthenticated() itself
      // (see api.ts's refreshAccessToken) — nothing more to do here except
      // seed React Query's ['me'] cache: the cookie-first path above just
      // fetched the exact same `/auth/me` body OnboardingGate's own `['me']`
      // query is about to fetch again on this same page load. Only set when
      // the cookie-first branch actually ran it (the legacy refresh-token
      // fallback never calls /auth/me, so there's nothing to seed from it).
      const snapshot = getLastMeSnapshot();
      if (snapshot) queryClient.setQueryData(['me'], snapshot);
    };
    attempt(0);
  }, [queryClient]);

  // A tab an authenticated user leaves open makes zero requests while idle
  // (React Query's refetchOnWindowFocus is off, and there's no polling), so
  // nothing ever discovers a session that ended while the tab sat in the
  // background — it would keep rendering the dashboard indefinitely, even
  // though the server would correctly reject the next real request. Revalidate
  // whenever the tab regains visibility instead: cheap (shares the same
  // single-flight bootstrapSession/refreshAccessToken every other refresh
  // path uses), and the standard place to catch this class of staleness.
  useEffect(() => {
    function handleVisibilityChange(): void {
      if (document.visibilityState !== 'visible') return;
      if (getSessionStatus() !== 'authenticated') return;
      bootstrapSession().then((ok) => {
        // Only a confirmed rejection ends the session; an unreachable API leaves this tab as it is.
        if (!ok && getLastIdentityFailure() !== 'unavailable') clearSessionAndRedirect();
      });
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // PHASE 10 §26/§27 — a tab that stays open and actively visible makes no
  // requests that would otherwise surface a 401 once the session's absolute
  // deadline passes (the visibilitychange handler above only ever fires on
  // a tab that was BACKGROUNDED and came back). This is UX only: it exists
  // so an actively-visible tab redirects promptly instead of continuing to
  // show a trusted-looking authenticated screen until the user's next
  // click happens to trigger a request. The server remains the sole
  // security authority — `SessionValidityService` denies every request
  // past the deadline regardless of whether this timer ever fires, fires
  // late (a backgrounded/throttled tab), or is defeated entirely by a
  // manipulated device clock or disabled JavaScript timer.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    function scheduleFromCurrentDeadline(): void {
      if (timer) clearTimeout(timer);
      if (getSessionStatus() !== 'authenticated') return;
      const deadline = getSessionExpiresAt();
      if (deadline === null) return;
      const delayMs = deadline - Date.now();
      if (delayMs <= 0) {
        clearSessionAndRedirect();
        return;
      }
      // setTimeout's delay argument is a 32-bit signed int internally in
      // most engines — a 90-day-class delay (irrelevant for manager_web's
      // own 24h policy, but this component is shared code) would silently
      // fire immediately if passed as-is. Re-check and reschedule in
      // bounded chunks rather than trusting an arbitrarily long delay.
      const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
      timer = setTimeout(scheduleFromCurrentDeadline, Math.min(delayMs, MAX_TIMEOUT_MS));
    }

    scheduleFromCurrentDeadline();
    const unsubscribe = subscribeToSession(scheduleFromCurrentDeadline);
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  return <>{children}</>;
}
