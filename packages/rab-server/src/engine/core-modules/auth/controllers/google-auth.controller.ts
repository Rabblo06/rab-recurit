import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { resolveClientIp } from '../../../utils/client-ip.util';
import { EnvironmentService } from '../../environment/environment.service';
import { buildRefreshCookieOptions, REFRESH_COOKIE_NAME } from '../constants/refresh-cookie.constants';
import { buildWebSessionCookieOptions, WEB_SESSION_COOKIE_NAME } from '../constants/web-session-cookie.constants';
import { AuthProviderEnabledGuard } from '../guards/auth-provider-enabled.guard';
import { AuthService } from '../services/auth.service';
import { OidcLoginService } from '../services/oidc-login.service';

/** Same shape/rate as AuthController's own AUTH_THROTTLE — a redirect endpoint is still an unauthenticated entry point. */
const OAUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * P1C.1B — server-initiated Google login. `/rest/v1/auth/google` starts the redirect;
 * `/rest/v1/auth/google/callback` completes it. Both routes are system-gated
 * (`AuthProviderEnabledGuard('google')`); the ORGANISATION-level gate runs inside
 * `AuthService.signInWithProvider` once an identity is resolved (that's the only point the
 * organisation is known) — see OrganisationAuthProvidersService's own doc comment.
 *
 * Mirrors `AuthController.login`'s own web cookie-setting shape exactly: the refresh cookie is
 * set on this redirect response before anything else happens, then the browser is sent to a
 * frontend route that calls the EXISTING `bootstrapSession()` (api.ts) — the same silent
 * cookie-to-access-token exchange a page reload already performs. No access token, JWT, or any
 * other credential ever appears in a redirect URL, query string, or fragment.
 */
@Controller('rest/v1/auth/google')
export class GoogleAuthController {
  constructor(
    private readonly oidcLogin: OidcLoginService,
    private readonly authService: AuthService,
    private readonly env: EnvironmentService,
  ) {}

  @Get()
  @UseGuards(AuthProviderEnabledGuard('google'))
  @Throttle(OAUTH_THROTTLE)
  async start(@Query('returnTo') returnTo: string | undefined, @Res() res: Response): Promise<void> {
    const url = await this.oidcLogin.buildAuthorizationUrl('google', returnTo);
    res.redirect(url);
  }

  @Get('callback')
  @UseGuards(AuthProviderEnabledGuard('google'))
  @Throttle(OAUTH_THROTTLE)
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const appUrl = this.env.get('APP_URL');
    try {
      const { identity, returnToPath } = await this.oidcLogin.handleCallback('google', req.query as Record<string, string>);
      const meta = { ip: resolveClientIp(req, this.env.trustedProxyCidrs), userAgent: req.headers['user-agent'] };
      const result = await this.authService.signInWithProvider('google', identity, meta);

      const maxAgeMs = Math.max(0, result.refreshExpiresAt.getTime() - Date.now());
      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, buildRefreshCookieOptions(this.env.isProduction, maxAgeMs));
      // P1C.1C: the SAME crewflow_session cookie password login sets — signInWithProvider()
      // converges on completeLogin(), so a brand-new manager_web family (the only kind this
      // controller ever creates) always carries a fresh webSessionToken here too.
      if (result.webSessionToken) {
        const sessionMaxAgeMs = Math.max(0, result.sessionExpiresAt.getTime() - Date.now());
        res.cookie(WEB_SESSION_COOKIE_NAME, result.webSessionToken, buildWebSessionCookieOptions(this.env.isProduction, sessionMaxAgeMs));
      }
      res.redirect(`${appUrl}/oauth/callback-complete?mustResetPassword=${result.mustResetPassword}&returnTo=${encodeURIComponent(returnToPath)}`);
    } catch {
      // Generic, never distinguishing WHY (email unverified, no account, provider disabled,
      // expired/replayed state, signature failure, ...) — the specific reason is whatever the
      // underlying service already threw with (itself always generic text); nothing additional
      // is logged here beyond what those services' own callers already audit.
      res.redirect(`${appUrl}/login?oauthError=1`);
    }
  }
}
