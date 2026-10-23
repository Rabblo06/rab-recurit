import { CookieOptions, Request, Response } from 'express';

import {
  buildOAuthHandoffCookieOptions,
  buildOAuthTxCookieOptions,
  clearOAuthHandoffCookieOptions,
  clearOAuthTxCookieOptions,
  OAUTH_HANDOFF_COOKIE_NAME,
  OAUTH_HANDOFF_TTL_MS,
  OAUTH_TX_COOKIE_NAME,
  OAUTH_TX_TTL_MS,
} from './oauth-cookies.constants';
import { buildRefreshCookieOptions, clearRefreshCookieOptions, REFRESH_COOKIE_NAME } from './refresh-cookie.constants';
import { buildWebSessionCookieOptions, clearWebSessionCookieOptions, WEB_SESSION_COOKIE_NAME } from './web-session-cookie.constants';

/**
 * Wave 2 lane A2 (B3) — the ONE place that decides each browser auth cookie's name and attributes.
 *
 * Two modes, selected by AUTH_COOKIE_HOST_PREFIX_ENABLED (default false):
 *   legacy (flag off): exactly today's cookies — `crewflow_session` Path=/rest/v1, `rab_rt` Path=/rest/v1/auth,
 *                      `crewflow_oauth_tx` Path=/rest/v1/auth, `crewflow_oauth_handoff` Path=/rest/v1/auth/oauth; Secure
 *                      only in production; SameSite None (production) / Lax (dev), and Lax for the OAuth tx cookie.
 *   host (flag on):    the same names with the `__Host-` prefix. The browser then enforces Secure, Path=/ and no Domain,
 *                      so neither a sibling subdomain nor plain-http content can set, overwrite or shadow them (cookie
 *                      tossing). SameSite is unchanged from legacy (see WAVE2_LANE_A2_REPORT.md §5). Path=/ is required
 *                      by the prefix; every API route is under /rest/v1 and the only non-/rest/v1 route (/healthz) never
 *                      reads cookies, so the credential reaches no new handler.
 *
 * Migration (host mode): login and OAuth completion set `__Host-` cookies and clear any legacy ones the browser sent.
 * Ordinary requests read ONLY the `__Host-` session cookie (JwtAuthGuard) — a legacy session cookie is never a
 * credential in host mode. `/auth/refresh` (Origin-checked) may read a legacy `rab_rt` once, while
 * AUTH_COOKIE_LEGACY_MIGRATION_ENABLED=true and no `__Host-rab_rt` is present: the refresh token is single-use, so the
 * legacy value dies in that rotation, and the rotated one is issued only under `__Host-rab_rt`. The legacy session
 * cookie is promoted to `__Host-crewflow_session` only if it resolves to the SAME session as that refresh family
 * (AuthCookieMigrationService). When both names are present the `__Host-` one wins and the legacy one is ignored and
 * cleared; a duplicated legacy name (a tossed copy) is never migrated.
 *
 * Per-workspace hosts (future, not built): every cookie here is host-only, so a session issued by
 * `<workspace>.<base>` would be scoped to that host alone. The `__Host-` prefix is what makes that safe — another
 * workspace's host is same-site and could otherwise plant a Domain=<base> cookie with the same name.
 */
export const HOST_COOKIE_PREFIX = '__Host-';

export type AuthCookieKind = 'session' | 'refresh' | 'oauthTx' | 'oauthHandoff';

export interface AuthCookieMode {
  isProduction: boolean;
  hostPrefix: boolean;
  /** Host mode only: may `/auth/refresh` still read legacy-named cookies once? */
  legacyMigration: boolean;
}

interface EnvLike {
  isProduction: boolean;
  get(key: 'AUTH_COOKIE_HOST_PREFIX_ENABLED' | 'AUTH_COOKIE_LEGACY_MIGRATION_ENABLED'): boolean | undefined;
}

export function authCookieModeFromEnv(env: EnvLike): AuthCookieMode {
  return {
    isProduction: env.isProduction,
    hostPrefix: env.get('AUTH_COOKIE_HOST_PREFIX_ENABLED') === true,
    legacyMigration: env.get('AUTH_COOKIE_LEGACY_MIGRATION_ENABLED') !== false,
  };
}

const LEGACY_NAMES: Record<AuthCookieKind, string> = {
  session: WEB_SESSION_COOKIE_NAME,
  refresh: REFRESH_COOKIE_NAME,
  oauthTx: OAUTH_TX_COOKIE_NAME,
  oauthHandoff: OAUTH_HANDOFF_COOKIE_NAME,
};

const DEFAULT_MAX_AGE: Partial<Record<AuthCookieKind, number>> = { oauthTx: OAUTH_TX_TTL_MS, oauthHandoff: OAUTH_HANDOFF_TTL_MS };

export function legacyAuthCookieName(kind: AuthCookieKind): string {
  return LEGACY_NAMES[kind];
}

export function authCookieName(kind: AuthCookieKind, mode: AuthCookieMode): string {
  return mode.hostPrefix ? `${HOST_COOKIE_PREFIX}${LEGACY_NAMES[kind]}` : LEGACY_NAMES[kind];
}

function sameSiteFor(kind: AuthCookieKind, isProduction: boolean): CookieOptions['sameSite'] {
  // Unchanged from the legacy builders: the OAuth tx cookie must survive the provider's top-level redirect (Lax); the
  // others are presented by the web app's credentialed fetch to a cross-site API in production (None; Secure).
  if (kind === 'oauthTx') return 'lax';
  return isProduction ? 'none' : 'lax';
}

function legacySetOptions(kind: AuthCookieKind, isProduction: boolean, maxAgeMs: number): CookieOptions {
  switch (kind) {
    case 'session':
      return buildWebSessionCookieOptions(isProduction, maxAgeMs);
    case 'refresh':
      return buildRefreshCookieOptions(isProduction, maxAgeMs);
    case 'oauthTx':
      return buildOAuthTxCookieOptions(isProduction, maxAgeMs);
    case 'oauthHandoff':
      return buildOAuthHandoffCookieOptions(isProduction, maxAgeMs);
  }
}

export function legacyAuthCookieClearOptions(kind: AuthCookieKind, isProduction: boolean): CookieOptions {
  switch (kind) {
    case 'session':
      return clearWebSessionCookieOptions(isProduction);
    case 'refresh':
      return clearRefreshCookieOptions(isProduction);
    case 'oauthTx':
      return clearOAuthTxCookieOptions(isProduction);
    case 'oauthHandoff':
      return clearOAuthHandoffCookieOptions(isProduction);
  }
}

/** Set-Cookie options for `kind` in this mode. Host mode: HttpOnly, Secure, Path=/, no Domain (the `__Host-` contract). */
export function authCookieSetOptions(kind: AuthCookieKind, mode: AuthCookieMode, maxAgeMs?: number): CookieOptions {
  const maxAge = maxAgeMs ?? DEFAULT_MAX_AGE[kind];
  if (maxAge === undefined) throw new Error(`authCookieSetOptions: ${kind} needs an explicit maxAge.`);
  if (!mode.hostPrefix) return legacySetOptions(kind, mode.isProduction, maxAge);
  return { httpOnly: true, secure: true, sameSite: sameSiteFor(kind, mode.isProduction), path: '/', maxAge };
}

export function authCookieClearOptions(kind: AuthCookieKind, mode: AuthCookieMode): CookieOptions {
  if (!mode.hostPrefix) return legacyAuthCookieClearOptions(kind, mode.isProduction);
  return { httpOnly: true, secure: true, sameSite: sameSiteFor(kind, mode.isProduction), path: '/' };
}

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

/** Number of `name=` pairs in a raw Cookie header (duplicates included, which the cookie parser hides). */
export function countCookieOccurrences(header: string | undefined, name: string): number {
  if (!header) return 0;
  return header.split(';').filter((part) => part.trim().split('=')[0] === name).length;
}

/** The value of this mode's cookie for `kind` (host mode never falls back to the legacy name). */
export function readAuthCookie(request: RequestWithCookies, kind: AuthCookieKind, mode: AuthCookieMode): string | undefined {
  const value = request.cookies?.[authCookieName(kind, mode)];
  return typeof value === 'string' ? value : undefined;
}

/** Host mode: was a legacy-named copy of `kind` sent? (Always false in legacy mode, where the legacy name IS the name.) */
export function hasLegacyAuthCookie(request: RequestWithCookies, kind: AuthCookieKind, mode: AuthCookieMode): boolean {
  return mode.hostPrefix && countCookieOccurrences(request.headers.cookie, LEGACY_NAMES[kind]) > 0;
}

/** Host mode: expire a legacy-named copy of `kind` if the browser sent one. No-op in legacy mode (no extra headers). */
export function clearLegacyAuthCookieIfPresent(request: RequestWithCookies, response: Response, kind: AuthCookieKind, mode: AuthCookieMode): void {
  if (hasLegacyAuthCookie(request, kind, mode)) response.clearCookie(LEGACY_NAMES[kind], legacyAuthCookieClearOptions(kind, mode.isProduction));
}

/**
 * Every web-session credential this browser presented (for supersede-on-login). Legacy mode: the one cookie, as today.
 * Host mode: the `__Host-` value and, if different, a legacy one — revoking is never "accepting", so an old legacy
 * session the browser still holds is ended too rather than left alive.
 */
export function presentedWebSessionTokens(request: RequestWithCookies, mode: AuthCookieMode): string[] {
  const values = [readAuthCookie(request, 'session', mode)];
  if (mode.hostPrefix) values.push(request.cookies?.[LEGACY_NAMES.session]);
  return [...new Set(values.filter((v): v is string => typeof v === 'string'))];
}
