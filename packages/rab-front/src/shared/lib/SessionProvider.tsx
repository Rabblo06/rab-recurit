import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { bootstrapSession } from '../api';
import { getSessionStatus, markUnauthenticated, subscribeToSession, type SessionStatus } from './auth-session';

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

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    bootstrapSession().then((ok) => {
      if (!ok) markUnauthenticated();
      // A successful bootstrap already called markAuthenticated() itself
      // (see api.ts's refreshAccessToken) — nothing more to do here.
    });
  }, []);

  return <>{children}</>;
}
