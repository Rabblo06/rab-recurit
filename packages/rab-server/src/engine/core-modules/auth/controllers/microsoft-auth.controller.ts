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

const OAUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/** P1C.1B — Microsoft equivalent of GoogleAuthController; see that file's own doc comment for the full shape/rationale. */
@Controller('rest/v1/auth/microsoft')
export class MicrosoftAuthController {
  constructor(
    private readonly oidcLogin: OidcLoginService,
    private readonly authService: AuthService,
    private readonly env: EnvironmentService,
  ) {}

  @Get()
  @UseGuards(AuthProviderEnabledGuard('microsoft'))
  @Throttle(OAUTH_THROTTLE)
  async start(@Query('returnTo') returnTo: string | undefined, @Res() res: Response): Promise<void> {
    const url = await this.oidcLogin.buildAuthorizationUrl('microsoft', returnTo);
    res.redirect(url);
  }

  @Get('callback')
  @UseGuards(AuthProviderEnabledGuard('microsoft'))
  @Throttle(OAUTH_THROTTLE)
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const appUrl = this.env.get('APP_URL');
    try {
      const { identity, returnToPath } = await this.oidcLogin.handleCallback('microsoft', req.query as Record<string, string>);
      const meta = { ip: resolveClientIp(req, this.env.trustedProxyCidrs), userAgent: req.headers['user-agent'] };
      const result = await this.authService.signInWithProvider('microsoft', identity, meta);

      const maxAgeMs = Math.max(0, result.refreshExpiresAt.getTime() - Date.now());
      res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, buildRefreshCookieOptions(this.env.isProduction, maxAgeMs));
      if (result.webSessionToken) {
        const sessionMaxAgeMs = Math.max(0, result.sessionExpiresAt.getTime() - Date.now());
        res.cookie(WEB_SESSION_COOKIE_NAME, result.webSessionToken, buildWebSessionCookieOptions(this.env.isProduction, sessionMaxAgeMs));
      }
      res.redirect(`${appUrl}/oauth/callback-complete?mustResetPassword=${result.mustResetPassword}&returnTo=${encodeURIComponent(returnToPath)}`);
    } catch {
      res.redirect(`${appUrl}/login?oauthError=1`);
    }
  }
}
