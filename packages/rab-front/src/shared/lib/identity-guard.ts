/**
 * The pure identity-comparison decisions behind the P0.1 session-mixing fix
 * (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.1/§16B), factored out of `api.ts`'s
 * axios interceptors so they can be unit-tested directly without needing the
 * real axios instance (which pulls in `import.meta.env`, incompatible with
 * this test project's CommonJS-targeted ts-jest config — see api.spec.ts's
 * own doc comment for why that matters). `api.ts` is the only real caller;
 * this file has no axios/browser dependency at all.
 */

/**
 * Should a response be accepted (never populate a cache/callback with it
 * otherwise)? `capturedUserId` is whatever `getIdentitySnapshot().userId` was
 * at the REQUEST's dispatch time; `currentUserId` is read fresh when the
 * response arrives. A request dispatched with no known identity (anonymous —
 * login, refresh, forgot-password, or anything fired before a token ever
 * existed) has nothing to have gone stale relative to, so it's always
 * accepted.
 */
export function shouldAcceptResponse(capturedUserId: string | null, currentUserId: string | null): boolean {
  if (capturedUserId === null) return true;
  return capturedUserId === currentUserId;
}

/**
 * Should a 401-triggered request be replayed after a refresh resolves? Mirrors
 * `shouldAcceptResponse`'s rule exactly — refresh succeeding is necessary but
 * not sufficient; the identity it resolved to must match what THIS SPECIFIC
 * request was dispatched under, checked against the CURRENT store state after
 * the refresh (never against a flag the refresh call itself returns), because
 * the store may have already changed via an unrelated path (a cross-tab
 * broadcast) by the time this runs.
 */
export function shouldReplayAfterRefresh(refreshedToken: string | null, capturedUserId: string | null, currentUserIdAfterRefresh: string | null): boolean {
  if (!refreshedToken) return false;
  return shouldAcceptResponse(capturedUserId, currentUserIdAfterRefresh);
}

/**
 * May a BroadcastChannel-delivered token be silently adopted into this tab's own identity? Only
 * when this tab has no identity yet, or the broadcast confirms the SAME identity it already has.
 * A broadcast for a DIFFERENT, already-established identity means another tab authenticated as
 * someone else — never silently adopted (§16B: "a tab must never silently switch authenticated
 * user because another tab sent a new token"); the caller must instead do a full reset.
 */
export function shouldAdoptBroadcastIdentity(incomingUserId: string | null, currentUserId: string | null): boolean {
  return currentUserId === null || incomingUserId === currentUserId;
}

/**
 * P1C.1C-F — may a FAILED cookie-authenticated `/auth/me` call fall back to the legacy
 * JWT/`rab_rt` path? `api.ts`'s `resolveCookieIdentity()` sends no `Authorization` header at all,
 * so the ONLY way `JwtAuthGuard` throws its generic `'Missing credentials'` message from that
 * specific call is that no `crewflow_session` cookie was sent either — the genuine pre-P1C.1C
 * legacy case the fallback exists for. Any OTHER rejection message (`'Invalid session.'` —
 * malformed or unknown hash; `'Session identity mismatch.'` — the fencing header) means a cookie
 * WAS presented and the server explicitly rejected it, which must never silently escalate into
 * trying a DIFFERENT credential type for what might be a different, still-valid session — fail
 * closed, treat as logged out, never "try something else instead."
 */
export function shouldFallBackToLegacyAuth(rejectionMessage: string | undefined): boolean {
  return rejectionMessage === 'Missing credentials';
}
