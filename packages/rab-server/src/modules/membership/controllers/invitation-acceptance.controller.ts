import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { resolveClientIp } from '../../../engine/utils/client-ip.util';
import { AcceptMemberInvitationDto, ResolveMemberInvitationDto } from '../dto/member-invitation.dto';
import { MemberInvitationService } from '../services/member-invitation.service';

/** Same per-IP route throttle as `/auth/activate-account`; the service adds a distributed per-IP token bucket on top. */
const REDEEM_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

/**
 * Public (pre-authentication) half of email-first invitations. The raw token in the body is the only thing the
 * server trusts; it is hashed and resolved through the narrow SECURITY DEFINER lookup, then every check runs under
 * the invitation's own tenant context. Every failure that would reveal token state returns the same generic 400.
 * Neither endpoint issues a session: after accepting, the person signs in through the normal login flow.
 */
@Controller('rest/v1/invitations')
export class InvitationAcceptanceController {
  constructor(
    private readonly invitations: MemberInvitationService,
    private readonly env: EnvironmentService,
  ) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @Throttle(REDEEM_THROTTLE)
  resolve(@Body() dto: ResolveMemberInvitationDto, @Req() req: Request) {
    return this.invitations.resolve(dto.token, resolveClientIp(req, this.env.trustedProxyCidrs));
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Throttle(REDEEM_THROTTLE)
  accept(@Body() dto: AcceptMemberInvitationDto, @Req() req: Request) {
    return this.invitations.accept(dto, resolveClientIp(req, this.env.trustedProxyCidrs));
  }
}
