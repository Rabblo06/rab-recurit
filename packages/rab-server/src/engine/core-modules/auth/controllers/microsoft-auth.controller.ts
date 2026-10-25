import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthUser } from '../../../decorators/auth-user.decorator';
import { AuthContext } from '../../tenant/auth-context.interface';
import { SsoReauthStartDto } from '../dto/sso-reauth.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { ManagerApplication } from '../guards/manager-application.decorator';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { ProviderInvitationStartDto } from '../dto/provider-invitation-start.dto';
import { AuthProviderEnabledGuard } from '../guards/auth-provider-enabled.guard';
import { OAuthSignInFlowService } from '../services/oauth-sign-in-flow.service';
import { RateLimitRequired } from '../../throttler/rab-throttler.guard';

/** Same shape/rate as AuthController's own AUTH_THROTTLE — a redirect endpoint is still an unauthenticated entry point. */
const OAUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 } };

/**
 * Server-initiated Microsoft sign-in. Transport only — the flow (browser-bound state, PKCE, nonce, ID-token validation,
 * account resolution, one-time handoff or legacy direct session) is `OAuthSignInFlowService`, shared with the other
 * provider so the two can never drift. Both routes are system-gated (`AuthProviderEnabledGuard`); the
 * organisation-level gate runs inside `AuthService.resolveProviderUser` once the account is known.
 *
 * No access token, refresh token, session or handoff secret ever appears in a redirect URL, query string or fragment.
 */
@Controller('rest/v1/auth/microsoft')
export class MicrosoftAuthController {
  constructor(private readonly flow: OAuthSignInFlowService) {}

  @Get()
  @UseGuards(AuthProviderEnabledGuard('microsoft'))
  @Throttle(OAUTH_THROTTLE)
  @RateLimitRequired()
  async start(@Query('returnTo') returnTo: string | undefined, @Res() res: Response): Promise<void> {
    await this.flow.start('microsoft', res, { returnTo: typeof returnTo === 'string' ? returnTo : undefined });
  }

  /**
   * "Accept invitation with Microsoft": a top-level form POST (the invitation token travels in the body, never in a URL or
   * access log). The token's hash is stored in the OAuth transaction; the invitation is validated at the callback and
   * accepted only when the web app completes the handoff.
   */
  @Post('invitation')
  @UseGuards(AuthProviderEnabledGuard('microsoft'))
  @Throttle(OAUTH_THROTTLE)
  @RateLimitRequired()
  async startInvitation(@Body() dto: ProviderInvitationStartDto, @Res() res: Response): Promise<void> {
    await this.flow.start('microsoft', res, { intent: 'accept_invitation', invitationToken: dto.token });
  }

  /**
   * Account security step 1 (P6): re-authenticate the SIGNED-IN user with Microsoft (step-up for an account without a
   * password). A top-level form POST from the web console: JwtAuthGuard authenticates it and enforces a trusted Origin for
   * the cookie credential; manager_web only. Answers a 302 to the provider (`prompt=login`, `max_age=0`), or to the fixed
   * return path with `?reauth=failed`. The callback below finishes it — it never signs anyone in.
   */
  @Post('reauthenticate')
  @ManagerApplication()
  @UseGuards(AuthProviderEnabledGuard('microsoft'), JwtAuthGuard)
  @Throttle(OAUTH_THROTTLE)
  @RateLimitRequired()
  async reauthenticate(@AuthUser() ctx: AuthContext, @Body() dto: SsoReauthStartDto, @Res() res: Response): Promise<void> {
    await this.flow.startReauthentication(ctx, 'microsoft', res, dto.returnTo);
  }

  @Get('callback')
  @UseGuards(AuthProviderEnabledGuard('microsoft'))
  @Throttle(OAUTH_THROTTLE)
  @RateLimitRequired()
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.flow.callback('microsoft', req, res);
  }
}
