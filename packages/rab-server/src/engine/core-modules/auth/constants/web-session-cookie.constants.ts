import { CookieOptions } from 'express';

/**
 * P1C.1C — the Twenty-style opaque web session credential's HttpOnly cookie. Distinct from
 * `rab_rt` (refresh-cookie.constants.ts): `rab_rt` rotates on every `/auth/refresh` and is
 * presented only to that one route; `crewflow_session` is the PRIMARY per-request authentication
 * credential for every ordinary manager_web API call, set once at genuine login and never rotated
 * (a refresh operation must not touch it — FULL-ARCHITECTURE-UPGRADE-PLAN.md §33.9).
 *
 * `Path=/rest/v1` (not `/rest/v1/auth` like `rab_rt`, and not `/`): this credential's job is every
 * authenticated API route, not just the auth subtree, but it is still never sent to anything
 * outside the API surface (static assets, the SPA's own HTML shell, etc.).
 *
 * Same conditional Secure/SameSite logic as `rab_rt` (not Twenty's own dual-cookie-name `__Host-`
 * scheme) — this codebase's already-proven, already-production-reasoned pattern, not a new one.
 */
export const WEB_SESSION_COOKIE_NAME = 'crewflow_session';
export const WEB_SESSION_COOKIE_PATH = '/rest/v1';

/** `crewflow_sess_` + 32 random bytes, base64url — see `RefreshTokenService`'s own token-shape doc comment for why this prefix/length/encoding was chosen. Used by the guard to reject an obviously-malformed cookie before ever hashing/querying it. */
export const WEB_SESSION_TOKEN_PREFIX = 'crewflow_sess_';
const WEB_SESSION_TOKEN_BODY_LENGTH = 43; // base64url(32 random bytes) is always exactly 43 chars, no padding
export const WEB_SESSION_TOKEN_LENGTH = WEB_SESSION_TOKEN_PREFIX.length + WEB_SESSION_TOKEN_BODY_LENGTH;

export function isWellFormedWebSessionToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === WEB_SESSION_TOKEN_LENGTH && value.startsWith(WEB_SESSION_TOKEN_PREFIX) && /^[A-Za-z0-9_-]+$/.test(value.slice(WEB_SESSION_TOKEN_PREFIX.length));
}

export function buildWebSessionCookieOptions(isProduction: boolean, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: WEB_SESSION_COOKIE_PATH,
    maxAge: maxAgeMs,
    // No `domain` — host-only, same reasoning as `rab_rt` (never widens to a future workspace
    // subdomain by accident).
  };
}

export function clearWebSessionCookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: WEB_SESSION_COOKIE_PATH,
  };
}
