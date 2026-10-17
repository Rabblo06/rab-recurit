import { CookieOptions } from 'express';

/**
 * Google/Microsoft sign-in cookies (OAuthBrowserBindingAndHandoff1786717000000). Both are HttpOnly, host-only and
 * short-lived; neither is ever an authentication credential for ordinary API routes.
 *
 * `crewflow_oauth_tx` — set when the flow starts; its SHA-256 must match the OAuth transaction row at the
 * callback, so only the browser that started a sign-in can finish it. `SameSite=Lax`: the callback is a top-level
 * GET navigation from the provider, for which Lax cookies are sent; cross-site subrequests never carry it.
 *
 * `crewflow_oauth_handoff` — set on the callback redirect, carrying the one-time handoff secret (never in the URL).
 * It is presented by the web app's credentialed `fetch` to `/rest/v1/auth/oauth/*`, so it uses the same SameSite
 * policy as `crewflow_session` (cross-site API in production ⇒ `None; Secure`).
 */
export const OAUTH_TX_COOKIE_NAME = 'crewflow_oauth_tx';
export const OAUTH_TX_COOKIE_PATH = '/rest/v1/auth';
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

export const OAUTH_HANDOFF_COOKIE_NAME = 'crewflow_oauth_handoff';
export const OAUTH_HANDOFF_COOKIE_PATH = '/rest/v1/auth/oauth';
/** Twenty's SSO exchange token default (SHORT_TERM_TOKEN_EXPIRES_IN = 5m). */
export const OAUTH_HANDOFF_TTL_MS = 5 * 60 * 1000;

/** 32 random bytes, base64url: exactly 43 characters. */
export function isWellFormedOAuthSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && /^[A-Za-z0-9_-]+$/.test(value);
}

export function buildOAuthTxCookieOptions(isProduction: boolean, maxAgeMs = OAUTH_TX_TTL_MS): CookieOptions {
  return { httpOnly: true, secure: isProduction, sameSite: 'lax', path: OAUTH_TX_COOKIE_PATH, maxAge: maxAgeMs };
}

export function clearOAuthTxCookieOptions(isProduction: boolean): CookieOptions {
  return { httpOnly: true, secure: isProduction, sameSite: 'lax', path: OAUTH_TX_COOKIE_PATH };
}

export function buildOAuthHandoffCookieOptions(isProduction: boolean, maxAgeMs = OAUTH_HANDOFF_TTL_MS): CookieOptions {
  return { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: OAUTH_HANDOFF_COOKIE_PATH, maxAge: maxAgeMs };
}

export function clearOAuthHandoffCookieOptions(isProduction: boolean): CookieOptions {
  return { httpOnly: true, secure: isProduction, sameSite: isProduction ? 'none' : 'lax', path: OAUTH_HANDOFF_COOKIE_PATH };
}
