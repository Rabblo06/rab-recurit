import { Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';

import { EnvironmentService } from '../../environment/environment.service';
import { OAuthSignInFlowService } from '../services/oauth-sign-in-flow.service';
import { RateLimitRequired } from '../../throttler/rab-throttler.guard';

const HANDOFF_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * One-time Google/Microsoft login handoff (AUTH_OAUTH_HANDOFF_ENABLED). Public routes: the only credential is the
 * HttpOnly `crewflow_oauth_handoff` cookie set by the provider callback in THIS browser. Unsafe methods require a
 * trusted `Origin` (a missing Origin is refused), so another site cannot complete or cancel a sign-in on the
 * user's behalf. The session is issued only by `complete`, as HttpOnly cookies — never in the response body.
 */
@Controller('rest/v1/auth/oauth')
export class OAuthHandoffController {
  constructor(
    private readonly flow: OAuthSignInFlowService,
    private readonly env: EnvironmentService,
  ) {}

  @Get('handoff')
  @Throttle(HANDOFF_THROTTLE)
  @RateLimitRequired()
  describe(@Req() req: Request) {
    return this.flow.describeHandoff(req);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @Throttle(HANDOFF_THROTTLE)
  @RateLimitRequired()
  complete(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.assertTrustedOrigin(req);
    return this.flow.completeHandoff(req, res);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle(HANDOFF_THROTTLE)
  @RateLimitRequired()
  async cancel(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.assertTrustedOrigin(req);
    await this.flow.cancelHandoff(req, res);
  }

  private assertTrustedOrigin(req: Request): void {
    if (!this.env.isTrustedOrigin(req.headers.origin)) throw new ForbiddenException('Untrusted origin.');
  }
}
