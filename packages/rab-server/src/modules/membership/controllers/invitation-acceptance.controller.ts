import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { resolveClientIp } from '../../../engine/utils/client-ip.util';
import { AcceptMemberInvitationDto, ResolveMemberInvitationDto } from '../dto/member-invitation.dto';
import { INVALID_INVITATION_MESSAGE, MemberInvitationService } from '../services/member-invitation.service';
import { OrganisationOnboardingService } from '../../manager/services/organisation-onboarding.service';
import { RateLimitRequired } from '../../../engine/core-modules/throttler/rab-throttler.guard';

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
    private readonly organisations: OrganisationOnboardingService,
    private readonly env: EnvironmentService,
  ) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @Throttle(REDEEM_THROTTLE)
  @RateLimitRequired()
  async resolve(@Body() dto: ResolveMemberInvitationDto, @Req() req: Request) {
    const ip = resolveClientIp(req, this.env.trustedProxyCidrs);
    // Owner correction 2026-10-23: the same page and endpoints accept a platform administrator's CEO (organisation)
    // invitation. Not one → the workspace-member path, unchanged (it meters and answers exactly as before).
    const organisation = await this.organisations.resolveCeoInvitation(dto.token, ip);
    return organisation ?? this.invitations.resolve(dto.token, ip);
  }

  @Post('accept')
  @HttpCode(HttpStatus.OK)
  @Throttle(REDEEM_THROTTLE)
  @RateLimitRequired()
  async accept(@Body() dto: AcceptMemberInvitationDto, @Req() req: Request) {
    const ip = resolveClientIp(req, this.env.trustedProxyCidrs);
    const organisation = await this.organisations.acceptCeoInvitation(
      { token: dto.token, firstName: dto.firstName, lastName: dto.lastName, organisationName: dto.organisationName ?? '', newPassword: dto.newPassword },
      ip,
    );
    if (organisation) return organisation;
    // A workspace-member invitation names no organisation: the field is refused rather than silently ignored.
    if (dto.organisationName !== undefined) throw new BadRequestException(INVALID_INVITATION_MESSAGE);
    return this.invitations.accept(dto, ip);
  }
}
