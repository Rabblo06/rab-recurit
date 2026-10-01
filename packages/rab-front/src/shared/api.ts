import axios from 'axios';
import { getAccessToken, markAuthenticated, markUnauthenticated } from './lib/auth-session';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/rest/v1',
  // The refresh cookie is HttpOnly and Path-scoped to /rest/v1/auth (see
  // rab-server's refresh-cookie.constants.ts) — this only controls whether
  // the browser is ALLOWED to attach/accept it on cross-origin calls to the
  // API's own origin; it doesn't widen what the cookie is sent to.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  config.headers['X-Application-Target'] = 'manager_web';
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Only the genuinely unauthenticated auth routes — a bare `/auth/` prefix
// match also covers /auth/me and /auth/capabilities, which ARE guarded and
// DO need the same refresh-then-redirect handling as every other protected
// endpoint. Missing that meant a session that had actually ended produced a
// silently-stuck blank screen (OnboardingGate short-circuits on a React
// Query error) instead of a redirect to /login.
const UNAUTHENTICATED_AUTH_ROUTES = ['/auth/login', '/auth/refresh', '/auth/forgot-password', '/auth/reset-password', '/auth/activate-account'];
function isUnauthenticatedAuthRoute(url: string | undefined): boolean {
  return !!url && UNAUTHENTICATED_AUTH_ROUTES.some((route) => url.includes(route));
}

/** Exported for SessionProvider's visibilitychange revalidation — same "mark unauthenticated, redirect unless already there" logic every 401 path already funnels through. */
export function clearSessionAndRedirect(): void {
  markUnauthenticated();
  // Reassigning location.href to the page we're already on still reloads
  // it in most browsers — harmless on its own, but a page that fires an
  // unauthenticated request on boot (there was one; see theme.ts) would
  // loop forever doing it. Guard here too, since this is the one choke
  // point every such 401 ultimately funnels through.
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
}

// Single-flight refresh: concurrent 401s from several in-flight requests
// share one /auth/refresh call instead of each racing to rotate the same
// refresh token (the second rotation would be reuse-detected and revoke the
// whole session — see rab-workforce-architecture.md §8.1). No body is sent —
// the browser attaches the HttpOnly rab_rt cookie automatically; the server
// never returns the rotated refresh token back to this JS at all anymore,
// only a fresh access token, which is all this function stores.
let refreshInFlight: Promise<string | null> | null = null;

/**
 * PHASE 10 §8/§9 — cross-TAB coordination (the in-tab `refreshInFlight`
 * guard above only ever covers one JS execution context). Two tabs of the
 * same browser both receiving a 401 at roughly the same moment would
 * otherwise each independently call `/auth/refresh` with the SAME
 * cookie-borne token — the server's own AUTH-01 fix makes that SAFE
 * (exactly one wins, the other gets a clean reuse-detected 401, never a
 * corrupted session), but a losing tab that just replays its OWN doomed
 * network call would see that 401 and incorrectly sign itself out even
 * though the session is genuinely still alive in the winning tab.
 *
 * Two pieces, matching Step 9's exact described flow ("Tab A acquires
 * coordination and refreshes once; Tab B waits, then learns the session
 * state changed"):
 *  - The Web Locks API (`navigator.locks`) serializes the actual network
 *    call across every tab sharing one browser profile — a second tab's
 *    `run()` doesn't even START until the first tab's finishes.
 *  - A `BroadcastChannel` lets the winning tab announce its freshly-minted
 *    access token to every other tab the instant it lands. A tab that was
 *    waiting on the lock checks, once it's finally its turn, whether its
 *    OWN in-memory token already changed (i.e. the broadcast already
 *    arrived) — if so it uses that instead of making its own now-redundant
 *    (and would-be-reuse-detected) call.
 *
 * Neither mechanism is universally guaranteed (a browser without
 * `navigator.locks`/`BroadcastChannel` — rare in evergreen browsers, never
 * assumed here) — falling back to running the call directly is still SAFE,
 * per the server's own concurrency guarantee; only the UX benefit of
 * avoiding an occasional cross-tab false-logout is lost, never correctness.
 * The refresh TOKEN itself is never broadcast or stored — only the short-
 * lived access token and the non-secret session deadline, the same two
 * values `markAuthenticated` already holds in memory.
 */
const REFRESH_LOCK_NAME = 'rab-auth-refresh';
const REFRESH_BROADCAST_CHANNEL = 'rab-auth-refresh-broadcast';

let refreshBroadcast: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  refreshBroadcast = new BroadcastChannel(REFRESH_BROADCAST_CHANNEL);
  refreshBroadcast.onmessage = (event: MessageEvent<{ accessToken?: string; sessionExpiresAt?: string }>) => {
    if (event.data?.accessToken) markAuthenticated(event.data.accessToken, event.data.sessionExpiresAt);
  };
}

async function refreshAccessToken(): Promise<string | null> {
  const tokenBeforeCoordinating = getAccessToken();

  const run = async (): Promise<string | null> => {
    // Another tab may have already refreshed (and broadcast the result)
    // while this call was waiting its turn for the lock below.
    const maybeAlreadyRefreshed = getAccessToken();
    if (maybeAlreadyRefreshed && maybeAlreadyRefreshed !== tokenBeforeCoordinating) return maybeAlreadyRefreshed;

    try {
      const { data } = await axios.post(
        `${api.defaults.baseURL}/auth/refresh`,
        undefined,
        { withCredentials: true, headers: { 'X-Application-Target': 'manager_web' } },
      );
      markAuthenticated(data.accessToken, data.sessionExpiresAt);
      refreshBroadcast?.postMessage({ accessToken: data.accessToken, sessionExpiresAt: data.sessionExpiresAt });
      return data.accessToken as string;
    } catch {
      return null;
    }
  };

  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return navigator.locks.request(REFRESH_LOCK_NAME, run);
  }
  return run();
}

/**
 * Runs once on app boot (see `App.tsx`) — with no access token in memory yet
 * (a hard reload always starts empty), this is what silently restores a
 * session from the refresh cookie instead of forcing a fresh login every
 * time the tab is closed and reopened. Deliberately reuses the same
 * single-flight guard as the 401-triggered path below, so a page that
 * happens to fire several requests immediately on mount doesn't race
 * multiple bootstrap refreshes against the same cookie.
 */
export async function bootstrapSession(): Promise<boolean> {
  refreshInFlight ??= refreshAccessToken().finally(() => {
    refreshInFlight = null;
  });
  return (await refreshInFlight) !== null;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && original && !original._retried && !isUnauthenticatedAuthRoute(original.url)) {
      original._retried = true;
      refreshInFlight ??= refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
      const newAccessToken = await refreshInFlight;
      if (newAccessToken) {
        original.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(original);
      }
      clearSessionAndRedirect();
    } else if (error.response?.status === 401 && !isUnauthenticatedAuthRoute(original?.url)) {
      clearSessionAndRedirect();
    }
    return Promise.reject(error);
  },
);
