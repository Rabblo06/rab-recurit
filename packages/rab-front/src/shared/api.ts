import axios from 'axios';
import { applyIdentityFromServer, applyRefreshedToken, getAccessToken, getIdentitySnapshot, getSessionId, getUserId, markUnauthenticated, type IdentitySnapshot } from './lib/auth-session';
import { shouldAcceptResponse, shouldAdoptBroadcastIdentity, shouldFallBackToLegacyAuth, shouldReplayAfterRefresh } from './lib/identity-guard';
import { BACKGROUND_REQUEST_HEADER, installUserActivityTracking, isBackgroundRequest } from './lib/user-activity';

installUserActivityTracking();

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:3000/rest/v1',
  // The refresh cookie is HttpOnly and Path-scoped to /rest/v1/auth (see
  // rab-server's refresh-cookie.constants.ts) — this only controls whether
  // the browser is ALLOWED to attach/accept it on cross-origin calls to the
  // API's own origin; it doesn't widen what the cookie is sent to.
  withCredentials: true,
});

// P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B): every request captures the identity it was
// dispatched under. `__identity` is plain request metadata (never sent over the wire — axios
// config properties outside its own schema are simply carried along, never serialised into the
// HTTP request), read back by the response/401 handling below to detect a browser identity
// change that happened WHILE this request was in flight.
declare module 'axios' {
  interface AxiosRequestConfig {
    __identity?: IdentitySnapshot;
  }
}

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  config.headers['X-Application-Target'] = 'manager_web';
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // P1C.1C (FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9): the browser now also attaches the ambient
  // `crewflow_session` cookie to every one of these requests automatically (withCredentials above);
  // the guard treats that cookie as authoritative whenever it's present, resolved fresh against
  // Postgres on every request — this header is NOT what authenticates the call. It's a non-secret
  // consistency check closing a race class unique to an AMBIENT credential: unlike this Bearer
  // header (snapshotted into `config` right now, at dispatch time), the cookie is attached by the
  // browser at ACTUAL SEND time, so a request queued before a same-tab login/logout/account-switch
  // can still go out under a since-changed cookie identity. Sending the session id this tab
  // currently believes it has lets the guard reject that mismatch outright instead of letting the
  // request silently execute as whoever is now signed in. Never a credential, grants nothing on its
  // own, and absent entirely for the common case of no prior identity to fence against yet.
  const currentSessionId = getSessionId();
  if (currentSessionId) config.headers['X-Crewflow-Expected-Session-Id'] = currentSessionId;
  config.__identity = getIdentitySnapshot();
  // CF-20: no real input for a while → automatic traffic; the server will not extend the idle window for it.
  if (isBackgroundRequest()) config.headers[BACKGROUND_REQUEST_HEADER] = '1';
  return config;
});

// Only the genuinely unauthenticated auth routes — a bare `/auth/` prefix
// match also covers /auth/me and /auth/capabilities, which ARE guarded and
// DO need the same refresh-then-redirect handling as every other protected
// endpoint. Missing that meant a session that had actually ended produced a
// silently-stuck blank screen (OnboardingGate short-circuits on a React
// Query error) instead of a redirect to /login.
const UNAUTHENTICATED_AUTH_ROUTES = ['/auth/login', '/auth/refresh', '/auth/forgot-password', '/auth/reset-password', '/auth/activate-account', '/invitations/resolve', '/invitations/accept', '/email-change/confirm'];
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
let refreshInFlight: Promise<boolean> | null = null;

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
 *
 * P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B): `login` and `logout` ALSO run through this
 * same lock now (`withAuthLock`, exported below) — generation checks alone cannot undo a
 * `Set-Cookie` header the browser has already applied, so a login racing a logout racing a
 * refresh across tabs must not be allowed to interleave at the HTTP-response level either. Every
 * BroadcastChannel message now carries `type` plus enough identity metadata to validate it before
 * acting — never a naked token for blind adoption.
 */
const AUTH_LOCK_NAME = 'rab-auth-refresh';
const AUTH_BROADCAST_CHANNEL = 'rab-auth-refresh-broadcast';

// P1C.1C-F: the broadcast payload carries identity METADATA directly (userId/sessionId, both
// already non-secret and already readable by the broadcasting tab through other means — this IS
// its own identity) rather than a JWT to decode. This replaces the old `{type:'refresh',
// accessToken}` shape, which stopped being universable the moment a tab could establish its
// identity purely from the cookie-authenticated `/auth/me` response with no JWT ever involved —
// there would be nothing to put in `accessToken` for a receiving tab to decode in that case. Every
// identity-establishing path in this file (cookie bootstrap, legacy JWT refresh, login,
// OAuth-callback-complete) now posts through this ONE shape.
type AuthBroadcastMessage =
  | { type: 'identity'; userId: string; sessionId: string; sessionExpiresAt?: string }
  | { type: 'logout' };

let refreshBroadcast: BroadcastChannel | null = null;
if (typeof BroadcastChannel !== 'undefined') {
  refreshBroadcast = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
  refreshBroadcast.onmessage = (event: MessageEvent<AuthBroadcastMessage>) => {
    const message = event.data;
    if (!message) return;
    if (message.type === 'logout') {
      // Another tab logged out. If this tab still thinks it's authenticated, it no longer is —
      // react immediately rather than waiting for this tab's own next request to discover a 401.
      if (getUserId() !== null) clearSessionAndRedirect();
      return;
    }
    if (message.type === 'identity' && message.userId && message.sessionId) {
      if (!shouldAdoptBroadcastIdentity(message.userId, getUserId())) {
        // A DIFFERENT user authenticated in another tab. Never silently adopt their identity into
        // this tab's own — a full reload rebuilds every piece of state (this module's own store,
        // the React Query cache, component state) from scratch against the browser's actual
        // current identity (and current cookie), which is the only way to "clear and reseed" state
        // that a plain module like this one has no access to otherwise.
        window.location.reload();
        return;
      }
      applyIdentityFromServer({ userId: message.userId, sessionId: message.sessionId }, message.sessionExpiresAt);
    }
  };
}

function broadcastIdentity(userId: string, sessionId: string, sessionExpiresAt?: string): void {
  refreshBroadcast?.postMessage({ type: 'identity', userId, sessionId, sessionExpiresAt } satisfies AuthBroadcastMessage);
}

/** Exported so Login/LogoutDialog can serialize a cookie-changing call across tabs the same way refresh already does — see this file's own doc comment above. */
export function withAuthLock<T>(run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    // lib.dom.d.ts types LockGrantedCallback as `(lock) => T`, not `T | PromiseLike<T>`, even
    // though the real Web Locks API is designed for async callbacks (MDN: "the callback usually
    // returns a promise") and correctly auto-flattens the nested promise at runtime either way —
    // this cast corrects an imprecise lib type, not a real type hazard.
    return navigator.locks.request(AUTH_LOCK_NAME, run) as unknown as Promise<T>;
  }
  return run();
}

/** Posted by LogoutDialog after a successful (or best-effort) server-side logout, so other tabs react immediately instead of waiting for their own next 401. */
export function broadcastLogout(): void {
  refreshBroadcast?.postMessage({ type: 'logout' } satisfies AuthBroadcastMessage);
}

/**
 * P0 finalization (FULL-ARCHITECTURE-UPGRADE-PLAN.md §16B), identity-fields shape since P1C.1C-F:
 * posted by Login.tsx/OAuthCallbackComplete.tsx after a successful sign-in, so a DIFFERENT tab
 * that was showing a previous user is told immediately — reusing the exact same identity-checked
 * message shape and `onmessage` handling every other identity-establishing path in this file
 * already posts through (a fresh login, an OAuth completion, a cookie bootstrap and a legacy JWT
 * refresh all mean "this browser now has this identity" from every OTHER tab's point of view; the
 * receiving handler's identity comparison is what matters, not which call established it). Without
 * this, a login in tab B was previously invisible to tab A until tab A's own next request happened
 * to 401 and re-resolve — this closes that gap explicitly, rather than relying on it working by
 * accident.
 */
export function broadcastLogin(userId: string, sessionId: string, sessionExpiresAt?: string): void {
  broadcastIdentity(userId, sessionId, sessionExpiresAt);
}

/**
 * P1C.1C-F — the cookie-first identity resolution `/auth/me` makes possible: a `manager_web`
 * login (password, Google, Microsoft — all converge on the same `completeLogin()`) always sets
 * `crewflow_session` for a genuinely new session, so an ordinary authenticated request never
 * needs a JS-held Bearer JWT at all — the ambient cookie (`withCredentials` above) already
 * authenticates it server-side. This is a plain, unguarded read: unlike `/auth/refresh` (which
 * ROTATES a single-use refresh token and therefore needs the cross-tab Web Lock below to avoid
 * concurrent rotations reuse-detecting each other), re-resolving identity from `/auth/me` is
 * idempotent and safe to run from several tabs/call-sites at once with no lock at all.
 */
type CookieIdentityResult = 'ok' | 'no-cookie' | 'rejected' | 'unavailable';

/**
 * Audit F5 — only a 401 (or 403) from the server means "this session is over". A network failure, a 5xx/503 (the
 * server could not CHECK the session: database blip, deploy) or a 429 is transient and must never log anyone out.
 */
export function isTransientAuthFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status >= 500 || status === 429;
}

/** Why the most recent identity resolution failed: `rejected` (session over) or `unavailable` (try again). */
let lastIdentityFailure: 'rejected' | 'unavailable' | null = null;

export function getLastIdentityFailure(): 'rejected' | 'unavailable' | null {
  return lastIdentityFailure;
}

/** The exact shape `AuthService.me()` returns — see auth.service.ts:552. No sensitive field
 * (cookie, token, password hash) is in it; it's already served to this same browser over `/auth/me`. */
export interface AuthMeResponse {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  organisationId: string;
  roles: string[];
  mustResetPassword: boolean;
  isPlatformAdmin: boolean;
  sessionId: string;
  applicationTarget: string;
  sessionExpiresAt: string;
}

// P1G — `resolveCookieIdentity()` already fetches the full `/auth/me` body below; it used to
// discard everything but `id`/`sessionId`/`sessionExpiresAt`. `OnboardingGate` (App.tsx) and
// several Settings pages independently re-fetch the SAME endpoint under the SAME React Query key
// (['me']) a moment later. Keeping the last-fetched body here lets `SessionBootstrap` seed that
// cache directly after a successful bootstrap, turning a guaranteed duplicate request into a
// cache hit. Always reflects the most recent successful `/auth/me` read; `null` until the first one.
let lastMeSnapshot: AuthMeResponse | null = null;

export function getLastMeSnapshot(): AuthMeResponse | null {
  return lastMeSnapshot;
}

/**
 * P1C.1C-F (owner-raised follow-up): distinguishes WHY the cookie-authenticated call failed, not
 * just whether it did — `establishIdentity()` below uses this to decide whether falling back to
 * the legacy JWT/`rab_rt` path is even appropriate. This call sends no `Authorization` header at
 * all (deliberately — it only ever wants to know what the COOKIE resolves to), so the guard's
 * `'Missing credentials'` message can only mean one thing here: no `crewflow_session` cookie was
 * sent at all, the genuine "this session predates P1C.1C" case the legacy fallback exists for.
 * Any OTHER rejection (`'Invalid session.'` — malformed or unknown hash; `'Session identity
 * mismatch.'` — the fencing header) means a cookie WAS presented and the server explicitly
 * rejected it — that must never silently escalate into trying a DIFFERENT credential type for a
 * DIFFERENT (possibly still-valid) session. A present-but-rejected credential means this identity
 * is done, full stop; fail closed, never degrade to "try something else instead."
 */
async function resolveCookieIdentity(): Promise<CookieIdentityResult> {
  try {
    const { data } = await axios.get(`${api.defaults.baseURL}/auth/me`, {
      withCredentials: true,
      headers: { 'X-Application-Target': 'manager_web' },
    });
    applyIdentityFromServer({ userId: data.id, sessionId: data.sessionId }, data.sessionExpiresAt);
    broadcastIdentity(data.id, data.sessionId, data.sessionExpiresAt);
    lastMeSnapshot = data as AuthMeResponse;
    return 'ok';
  } catch (error) {
    if (isTransientAuthFailure(error)) return 'unavailable';
    const message = axios.isAxiosError(error) ? (error.response?.data as { message?: string } | undefined)?.message : undefined;
    return shouldFallBackToLegacyAuth(message) ? 'no-cookie' : 'rejected';
  }
}

export async function resolveIdentityViaCookie(): Promise<boolean> {
  const result = await resolveCookieIdentity();
  lastIdentityFailure = result === 'ok' ? null : result === 'unavailable' ? 'unavailable' : 'rejected';
  return result === 'ok';
}

/**
 * The LEGACY path — a session created before P1C.1C never gained a `crewflow_session` cookie (the
 * credential hash is immutable once set, so it can never retroactively appear on an older row —
 * HANDOFF.md §40/§33.9) and so has no choice but to keep using the JWT/refresh-rotation path until
 * that session naturally ends and its owner logs in fresh, at which point `resolveIdentityViaCookie`
 * above takes over for good. Kept exactly as before P1C.1C-F: single-flight, cross-tab Web-Lock
 * coordinated (rotation is single-use — concurrent rotations would reuse-detect each other), and
 * still the one place an access token is stored and attached as a Bearer header, since a caller on
 * this path has no cookie for the ambient transport to rely on instead.
 */
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
      const token = applyRefreshedToken(data.accessToken, data.sessionExpiresAt);
      const uid = getUserId();
      const sid = getSessionId();
      if (uid && sid) broadcastIdentity(uid, sid, data.sessionExpiresAt);
      return token;
    } catch (error) {
      if (isTransientAuthFailure(error)) lastIdentityFailure = 'unavailable';
      return null;
    }
  };

  return withAuthLock(run);
}

/**
 * P1C.1C-F — THE identity-establishment entry point. Cookie-first: tries the unguarded, lock-free
 * `/auth/me` read before ever touching the JWT/refresh-rotation machinery. Only a caller whose
 * session predates this checkpoint (no cookie, `resolveIdentityViaCookie` 401s) falls through to
 * `refreshAccessToken`'s legacy path. Single-flight across BOTH branches via the same
 * `refreshInFlight` guard `bootstrapSession`/the 401 handler already relied on, so a page that
 * fires several requests at once never races multiple identity-resolution attempts against the
 * same cookie/refresh-token.
 */
async function establishIdentity(): Promise<boolean> {
  const cookieResult = await resolveCookieIdentity();
  lastIdentityFailure = null;
  if (cookieResult === 'ok') return true;
  // Could not reach / could not check: nothing is known about the session — never treat it as ended.
  if (cookieResult === 'unavailable') {
    lastIdentityFailure = 'unavailable';
    return false;
  }
  // A PRESENT cookie that was explicitly rejected ends this attempt here — never silently try a
  // different credential type for what might be a different, still-technically-valid session
  // (see `resolveCookieIdentity`'s own doc comment). Only a genuinely ABSENT cookie — the real
  // pre-P1C.1C legacy case — reaches the JWT/`rab_rt` fallback below.
  if (cookieResult === 'rejected') {
    lastIdentityFailure = 'rejected';
    return false;
  }
  const refreshed = (await refreshAccessToken()) !== null;
  if (!refreshed && lastIdentityFailure === null) lastIdentityFailure = 'rejected';
  return refreshed;
}

/**
 * Runs once on app boot (see `App.tsx`) — with no identity established in memory yet (a hard
 * reload always starts empty), this is what silently restores a session from whichever credential
 * the browser actually holds (the `crewflow_session` cookie first, the legacy `rab_rt`-backed JWT
 * path only if that fails) instead of forcing a fresh login every time the tab is closed and
 * reopened. Deliberately reuses the same single-flight guard as the 401-triggered path below, so a
 * page that happens to fire several requests immediately on mount doesn't race multiple bootstrap
 * attempts against the same credential.
 */
export async function bootstrapSession(): Promise<boolean> {
  refreshInFlight ??= establishIdentity().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

api.interceptors.response.use(
  (response) => {
    // P0.1 (§16B, tests 1/5/6): a response whose request was captured under a DIFFERENT identity
    // than the browser's CURRENT one must never resolve successfully — resolving it would let
    // React Query populate a cache key, run a `queryFn`'s return value into component state, or
    // fire a mutation's `onSuccess` callback with another user's data. Rejecting instead means
    // React Query sees an error, never a stale success. A request captured with no identity at
    // all (userId null — login/refresh/forgot-password/reset/activate, or any request fired
    // before any token existed) is never subject to this check: there is no prior identity for it
    // to have become stale relative to.
    const captured = response.config.__identity;
    if (captured && !shouldAcceptResponse(captured.userId, getUserId())) {
      return Promise.reject(new Error('Stale response: browser identity changed since this request was dispatched.'));
    }
    return response;
  },
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && original && !original._retried && !isUnauthenticatedAuthRoute(original.url)) {
      original._retried = true;
      const capturedUserId: string | null = original.__identity?.userId ?? null;
      refreshInFlight ??= establishIdentity().finally(() => {
        refreshInFlight = null;
      });
      const resolved = await refreshInFlight;
      // P0.1 (§16B, test 2 — the exact mechanism the account-mixing finding exploited):
      // identity-resolution succeeding is NOT sufficient to replay. It may legitimately have
      // resolved to a DIFFERENT user than the one this specific request was dispatched under
      // (another tab logged in as someone else while this request was waiting on its 401).
      // Compare the CAPTURED identity against the browser's CURRENT identity, taken fresh after
      // resolution finished — never against any flag the resolution call itself returns, since the
      // store may already have changed via an unrelated path (a BroadcastChannel message) by the
      // time this runs. The retried request simply re-dispatches through `api()`, whose own request
      // interceptor re-reads the current token/cookie/fencing-header state — no credential is
      // manually attached here, matching however the ORIGINAL dispatch was authenticated.
      if (shouldReplayAfterRefresh(resolved ? 'ok' : null, capturedUserId, getUserId())) {
        return api(original);
      }
      if (resolved) {
        // Identity resolved, but to a different identity than this request was dispatched under.
        // The browser's own state is now correctly updated to that identity — this specific
        // request simply must not be replayed under it.
        return Promise.reject(error);
      }
      // The session could not be checked (API unreachable/503): fail THIS request, keep the session.
      if (lastIdentityFailure === 'unavailable') return Promise.reject(error);
      clearSessionAndRedirect();
    } else if (error.response?.status === 401 && !isUnauthenticatedAuthRoute(original?.url)) {
      clearSessionAndRedirect();
    }
    return Promise.reject(error);
  },
);
