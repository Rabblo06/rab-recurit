import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { DataSource } from 'typeorm';

import { EnvironmentService } from '../../environment/environment.service';
import {
  authCookieModeFromEnv,
  authCookieName,
  authCookieSetOptions,
  clearLegacyAuthCookieIfPresent,
  countCookieOccurrences,
  legacyAuthCookieName,
  readAuthCookie,
} from '../constants/auth-cookie-policy';
import { isWellFormedWebSessionToken } from '../constants/web-session-cookie.constants';

type RequestWithCookies = Request & { cookies?: Record<string, string | undefined> };

export type PresentedRefreshCookie =
  | { token: string; source: 'current' | 'legacy' }
  | { token: undefined; source: 'none' }
  | { token: undefined; source: 'duplicate-legacy' };

/**
 * Wave 2 lane A2 (B3) — the `/auth/refresh` half of the `__Host-` cookie migration. See auth-cookie-policy.ts for the
 * full rules. Nothing here runs in legacy mode (AUTH_COOKIE_HOST_PREFIX_ENABLED=false): every method returns the
 * pre-wave-2 behaviour.
 */
@Injectable()
export class AuthCookieMigrationService {
  private readonly logger = new Logger('AuthCookieMigration');

  constructor(
    private readonly env: EnvironmentService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Which refresh cookie a browser presented. Legacy mode: `rab_rt` (unchanged). Host mode: `__Host-rab_rt` if present
   * (authoritative, a legacy copy is ignored); otherwise, while AUTH_COOKIE_LEGACY_MIGRATION_ENABLED, exactly one legacy
   * `rab_rt` — a duplicated legacy name is treated as a tossed cookie and refused.
   */
  presentedRefreshCookie(request: RequestWithCookies): PresentedRefreshCookie {
    const mode = authCookieModeFromEnv(this.env);
    const current = readAuthCookie(request, 'refresh', mode);
    if (current !== undefined) return { token: current, source: 'current' };
    if (!mode.hostPrefix || !mode.legacyMigration) return { token: undefined, source: 'none' };
    const legacyName = legacyAuthCookieName('refresh');
    const count = countCookieOccurrences(request.headers.cookie, legacyName);
    if (count === 0) return { token: undefined, source: 'none' };
    if (count > 1) return { token: undefined, source: 'duplicate-legacy' };
    const legacy = request.cookies?.[legacyName];
    return typeof legacy === 'string' && legacy ? { token: legacy, source: 'legacy' } : { token: undefined, source: 'none' };
  }

  /**
   * After a SUCCESSFUL cookie refresh in host mode (the refresh cookie was already re-issued under `__Host-rab_rt`):
   *   - clears any legacy `crewflow_session` the browser sent;
   *   - promotes the legacy session cookie to `__Host-crewflow_session` (same value, same session row, Max-Age = the
   *     family's absolute deadline) only when: no `__Host-` session cookie was sent, migration is enabled, the legacy name
   *     appears exactly once, it is well formed, and it resolves to `refreshedSessionId` — the session whose single-use
   *     refresh token was just rotated. A value for any other session (a planted cookie) is cleared, never promoted.
   * No new secret is minted and no session identity changes, so this cannot fix a session onto the browser; it only
   * renames a credential this browser already held for this very session. Never throws (a refresh that succeeded is
   * not failed by cookie hygiene).
   */
  async completeRefreshMigration(request: RequestWithCookies, response: Response, refreshedSessionId: string, sessionExpiresAt: Date): Promise<void> {
    const mode = authCookieModeFromEnv(this.env);
    if (!mode.hostPrefix) return;
    // (A legacy `rab_rt` was already cleared by the controller when it re-issued the refresh cookie.)

    const legacyName = legacyAuthCookieName('session');
    const legacyCount = countCookieOccurrences(request.headers.cookie, legacyName);
    if (legacyCount === 0) return;
    clearLegacyAuthCookieIfPresent(request, response, 'session', mode);

    if (readAuthCookie(request, 'session', mode) !== undefined) return; // `__Host-` wins; the legacy copy is just cleared.
    if (!mode.legacyMigration || legacyCount > 1) return;
    const legacyValue = request.cookies?.[legacyName];
    if (!isWellFormedWebSessionToken(legacyValue)) return;

    try {
      const hash = createHash('sha256').update(legacyValue).digest('hex');
      const [found] = await this.dataSource.query<Array<{ sessionId: string }>>('SELECT * FROM core.auth_find_session_by_web_token_hash($1)', [hash]);
      if (!found || found.sessionId !== refreshedSessionId) {
        this.logger.warn('legacy_session_cookie_not_promoted reason=session_mismatch');
        return;
      }
      const maxAgeMs = Math.max(0, sessionExpiresAt.getTime() - Date.now());
      response.cookie(authCookieName('session', mode), legacyValue, authCookieSetOptions('session', mode, maxAgeMs));
      this.logger.log('legacy_session_cookie_promoted');
    } catch (error) {
      this.logger.warn(`legacy_session_cookie_not_promoted reason=${(error as Error).name}`);
    }
  }
}
