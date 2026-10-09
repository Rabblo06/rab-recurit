/**
 * The single source of truth for Web's client-side session state — an
 * external store (not React state) so both plain modules (`api.ts`'s 401
 * handler, which isn't a component) and React components (`SessionProvider`,
 * via `useSyncExternalStore`) can read and update it consistently.
 *
 * The access token itself lives here too, as a plain in-memory value,
 * deliberately never persisted anywhere (localStorage/sessionStorage/
 * IndexedDB). It's gone on every hard reload, by design — `bootstrapSession()`
 * (see `api.ts`) re-derives a fresh one from the HttpOnly `rab_rt` refresh
 * cookie on boot instead. That cookie is the only long-lived credential Web
 * holds now, and JavaScript can never read it — see
 * rab-workforce-architecture.md §8.1 and the security remediation history
 * for why this replaced the old localStorage-based pair.
 *
 * P0.1 (FULL-ARCHITECTURE-UPGRADE-PLAN.md §8.1/§16B) adds `userId`, `sessionId`
 * and `generation` — the identity-epoch mechanism that stops stale async work
 * from crossing an identity boundary (the web account-mixing finding). See
 * `markAuthenticated` vs `applyRefreshedToken`'s doc comments for exactly when
 * `generation` bumps and when it doesn't, and `api.ts` for how every request
 * captures and later re-checks this identity.
 */
import { decodeAccessToken } from './jwt';

export type SessionStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface IdentitySnapshot {
  userId: string | null;
  sessionId: string | null;
  generation: number;
}

let accessToken: string | null = null;
let status: SessionStatus = 'loading';
/**
 * PHASE 10 §26 — the session family's absolute deadline, as plain non-secret
 * metadata from the login/refresh response (never a credential — see
 * `AuthTokens.sessionExpiresAt`'s own server-side doc comment). Used only to
 * schedule ONE client-side UX timer (`SessionProvider`'s deadline effect);
 * the server remains the sole security authority regardless of whether this
 * value is ever read, stale, or tampered with in a compromised tab.
 */
let sessionExpiresAt: number | null = null;

/** Decoded from the current access token's own payload — see jwt.ts's doc comment for why this is safe bookkeeping, never an authorization input. */
let userId: string | null = null;
let sessionId: string | null = null;
/**
 * Monotonically increasing, never recycled. Bumps on an explicit identity
 * TRANSITION (`markAuthenticated` — login, or any other call site that knows
 * this is a genuinely new session) and on a DETECTED identity change inside
 * what was supposed to be a silent continuation (`applyRefreshedToken` — a
 * background refresh, a bootstrap, or a cross-tab broadcast that turns out to
 * belong to a different user than this tab currently has). Deliberately NOT
 * an authorization credential — the server session remains sole authority —
 * its only job is letting `api.ts` detect and discard stale async work that
 * crosses that boundary (the exact mechanism the web account-mixing finding
 * exploited, §8.1).
 */
let generation = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSessionStatus(): SessionStatus {
  return status;
}

export function getSessionExpiresAt(): number | null {
  return sessionExpiresAt;
}

export function getUserId(): string | null {
  return userId;
}

export function getSessionId(): string | null {
  return sessionId;
}

export function getGeneration(): number {
  return generation;
}

/** What `api.ts` captures at every authenticated request's dispatch time, and re-compares against on completion/retry — see that file. */
export function getIdentitySnapshot(): IdentitySnapshot {
  return { userId, sessionId, generation };
}

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * The EXPLICIT identity-transition entry point: a fresh login (and anywhere
 * else that is unambiguously establishing a brand-new session, never a
 * same-session token renewal). ALWAYS bumps `generation` — unconditionally,
 * regardless of whether the decoded user id happens to match whoever was
 * previously authenticated in this tab (re-logging in as yourself after an
 * explicit logout is still a real transition boundary: every bit of
 * in-flight work from before it must be treated as belonging to the OLD
 * generation).
 */
export function markAuthenticated(token: string, expiresAt?: string | number | Date): void {
  const decoded = decodeAccessToken(token);
  accessToken = token;
  sessionExpiresAt = expiresAt !== undefined ? new Date(expiresAt).getTime() : sessionExpiresAt;
  userId = decoded.sub;
  sessionId = decoded.sid;
  generation += 1;
  status = 'authenticated';
  emit();
}

/**
 * The SILENT-CONTINUATION entry point: a background refresh (bootstrap,
 * visibility revalidation, or the 401-retry path's own refresh call) —
 * anywhere the caller does NOT already know whether the token it just
 * received genuinely continues this tab's existing identity. Decodes the new
 * token's `sub` and compares it against whatever this tab currently holds:
 *
 *   - Current is null (nothing established yet, e.g. the very first
 *     bootstrap on a fresh tab): accepted as a normal continuation, counted
 *     as the tab's first real transition (generation bumps once, from 0).
 *   - Current matches the decoded `sub`: a genuine same-identity refresh —
 *     token/expiry update, generation UNCHANGED. This is the common case and
 *     must stay cheap/non-disruptive — bumping generation here would make
 *     every in-flight request from the SAME ongoing session spuriously look
 *     stale on its own natural completion.
 *   - Current is a DIFFERENT non-null value: the browser's ambient identity
 *     has changed under this tab (the exact §8.1 scenario — another login
 *     elsewhere changed the shared refresh cookie). This is still recorded
 *     here (the store now correctly reflects the browser's real current
 *     identity, generation bumps), but callers must NOT treat this return as
 *     "my original request may now be replayed" — see `api.ts`'s 401 handler
 *     and response interceptor, which compare their own CAPTURED identity
 *     (from dispatch time) against `getUserId()` taken fresh after this call
 *     returns, not against any flag this function itself returns.
 */
export function applyRefreshedToken(token: string, expiresAt?: string | number | Date): string {
  const decoded = decodeAccessToken(token);
  if (userId === null || decoded.sub !== userId) {
    generation += 1;
  }
  accessToken = token;
  sessionExpiresAt = expiresAt !== undefined ? new Date(expiresAt).getTime() : sessionExpiresAt;
  userId = decoded.sub;
  sessionId = decoded.sid;
  status = 'authenticated';
  emit();
  return token;
}

/**
 * P1C.1C-F — the cookie-first counterpart to `applyRefreshedToken`: same SILENT-CONTINUATION
 * generation semantics (bump only on a genuine identity CHANGE, never on an ordinary same-identity
 * re-bootstrap), but the identity comes from `GET /auth/me`'s response fields, never a decoded
 * JWT — this is the one function that lets `accessToken` stay `null` while `status` is still
 * `'authenticated'`. Explicitly clears any stale `accessToken` on use: a tab that resolves its
 * identity via the cookie has nothing to attach as a Bearer header any more, and must not keep
 * sending a leftover one from an earlier legacy-JWT bootstrap alongside the now-valid cookie.
 */
export function applyIdentityFromServer(identity: { userId: string; sessionId: string }, expiresAt?: string | number | Date): void {
  if (userId === null || identity.userId !== userId) {
    generation += 1;
  }
  accessToken = null;
  sessionExpiresAt = expiresAt !== undefined ? new Date(expiresAt).getTime() : sessionExpiresAt;
  userId = identity.userId;
  sessionId = identity.sessionId;
  status = 'authenticated';
  emit();
}

export function markUnauthenticated(): void {
  accessToken = null;
  sessionExpiresAt = null;
  userId = null;
  sessionId = null;
  generation += 1;
  status = 'unauthenticated';
  emit();
}
