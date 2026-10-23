import { Request, Response } from 'express';

import {
  authCookieClearOptions,
  authCookieModeFromEnv,
  authCookieName,
  authCookieSetOptions,
  clearLegacyAuthCookieIfPresent,
  hasLegacyAuthCookie,
  presentedWebSessionTokens,
  readAuthCookie,
} from './auth-cookie-policy';
import { buildOAuthHandoffCookieOptions, buildOAuthTxCookieOptions, clearOAuthHandoffCookieOptions, clearOAuthTxCookieOptions } from './oauth-cookies.constants';
import { buildRefreshCookieOptions, clearRefreshCookieOptions } from './refresh-cookie.constants';
import { buildWebSessionCookieOptions, clearWebSessionCookieOptions } from './web-session-cookie.constants';

const legacy = (isProduction: boolean) => ({ isProduction, hostPrefix: false, legacyMigration: true });
const host = (isProduction: boolean) => ({ isProduction, hostPrefix: true, legacyMigration: true });

function req(cookieHeader: string): Request {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name && !(name in cookies)) cookies[name] = rest.join('=');
  }
  return { headers: { cookie: cookieHeader }, cookies } as unknown as Request;
}

function res(): Response & { cleared: Array<[string, unknown]> } {
  const cleared: Array<[string, unknown]> = [];
  return { cleared, clearCookie: (name: string, opts: unknown) => cleared.push([name, opts]) } as unknown as Response & { cleared: Array<[string, unknown]> };
}

describe('auth-cookie-policy (wave 2 lane A2)', () => {
  describe('flag OFF is identical to the pre-wave-2 cookies', () => {
    it.each([true, false])('names and options match the legacy builders exactly (production=%s)', (isProduction) => {
      const mode = legacy(isProduction);
      expect(authCookieName('session', mode)).toBe('crewflow_session');
      expect(authCookieName('refresh', mode)).toBe('rab_rt');
      expect(authCookieName('oauthTx', mode)).toBe('crewflow_oauth_tx');
      expect(authCookieName('oauthHandoff', mode)).toBe('crewflow_oauth_handoff');
      expect(authCookieSetOptions('session', mode, 1000)).toEqual(buildWebSessionCookieOptions(isProduction, 1000));
      expect(authCookieSetOptions('refresh', mode, 1000)).toEqual(buildRefreshCookieOptions(isProduction, 1000));
      expect(authCookieSetOptions('oauthTx', mode)).toEqual(buildOAuthTxCookieOptions(isProduction));
      expect(authCookieSetOptions('oauthHandoff', mode)).toEqual(buildOAuthHandoffCookieOptions(isProduction));
      expect(authCookieClearOptions('session', mode)).toEqual(clearWebSessionCookieOptions(isProduction));
      expect(authCookieClearOptions('refresh', mode)).toEqual(clearRefreshCookieOptions(isProduction));
      expect(authCookieClearOptions('oauthTx', mode)).toEqual(clearOAuthTxCookieOptions(isProduction));
      expect(authCookieClearOptions('oauthHandoff', mode)).toEqual(clearOAuthHandoffCookieOptions(isProduction));
    });

    it('never reports or clears a "legacy" cookie (no extra Set-Cookie headers)', () => {
      const r = req('crewflow_session=a; rab_rt=b');
      const out = res();
      expect(hasLegacyAuthCookie(r, 'session', legacy(true))).toBe(false);
      clearLegacyAuthCookieIfPresent(r, out, 'session', legacy(true));
      expect(out.cleared).toEqual([]);
      expect(presentedWebSessionTokens(r, legacy(true))).toEqual(['a']);
    });

    it('defaults from the environment: off, migration on', () => {
      expect(authCookieModeFromEnv({ isProduction: true, get: () => undefined })).toEqual({ isProduction: true, hostPrefix: false, legacyMigration: true });
      expect(authCookieModeFromEnv({ isProduction: false, get: (k) => (k === 'AUTH_COOKIE_HOST_PREFIX_ENABLED' ? true : false) })).toEqual({ isProduction: false, hostPrefix: true, legacyMigration: false });
    });
  });

  describe('flag ON: the __Host- contract', () => {
    it.each(['session', 'refresh', 'oauthTx', 'oauthHandoff'] as const)('%s: __Host- name, HttpOnly, Secure, Path=/, no Domain (even outside production)', (kind) => {
      for (const isProduction of [true, false]) {
        const opts = authCookieSetOptions(kind, host(isProduction), 60_000);
        expect(authCookieName(kind, host(isProduction)).startsWith('__Host-')).toBe(true);
        expect(opts).toMatchObject({ httpOnly: true, secure: true, path: '/', maxAge: 60_000 });
        expect(opts.domain).toBeUndefined();
        const clear = authCookieClearOptions(kind, host(isProduction));
        expect(clear).toMatchObject({ httpOnly: true, secure: true, path: '/' });
        expect(clear.domain).toBeUndefined();
      }
    });

    it('SameSite is unchanged from legacy: None in production, Lax in dev; the OAuth tx cookie stays Lax', () => {
      expect(authCookieSetOptions('session', host(true), 1).sameSite).toBe('none');
      expect(authCookieSetOptions('refresh', host(true), 1).sameSite).toBe('none');
      expect(authCookieSetOptions('oauthHandoff', host(true), 1).sameSite).toBe('none');
      expect(authCookieSetOptions('oauthTx', host(true), 1).sameSite).toBe('lax');
      expect(authCookieSetOptions('session', host(false), 1).sameSite).toBe('lax');
    });

    it('reads ONLY the __Host- name — a legacy cookie is never read as the current credential', () => {
      expect(readAuthCookie(req('crewflow_session=legacy-value'), 'session', host(true))).toBeUndefined();
      expect(readAuthCookie(req('__Host-crewflow_session=new; crewflow_session=old'), 'session', host(true))).toBe('new');
    });

    it('clears a legacy copy only when the browser sent one, with the legacy Path', () => {
      const out = res();
      clearLegacyAuthCookieIfPresent(req('__Host-rab_rt=x'), out, 'refresh', host(true));
      expect(out.cleared).toEqual([]);
      clearLegacyAuthCookieIfPresent(req('rab_rt=y'), out, 'refresh', host(true));
      expect(out.cleared).toEqual([['rab_rt', clearRefreshCookieOptions(true)]]);
    });

    it('supersede-on-login sees both the __Host- and a different legacy session value', () => {
      expect(presentedWebSessionTokens(req('__Host-crewflow_session=a; crewflow_session=b'), host(true))).toEqual(['a', 'b']);
      expect(presentedWebSessionTokens(req('__Host-crewflow_session=a; crewflow_session=a'), host(true))).toEqual(['a']);
      expect(presentedWebSessionTokens(req(''), host(true))).toEqual([]);
    });
  });
});
