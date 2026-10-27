import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../engine/guards/platform-admin.guard';
import { InviteCeoDto, ListCeoInvitationsDto, ResendCeoInviteDto } from '../dto/invite-ceo.dto';
import { OrganisationOnboardingService } from '../services/organisation-onboarding.service';

/**
 * P2.9B — Platform Super Admin only. `OrganisationOnboardingService` itself also re-checks
 * `isPlatformAdmin` on every method (CLAUDE.md's "layer 2 is the one people skip" — this class is
 * also reachable from any future non-HTTP caller), so this guard is layer 1, not the only layer.
 */
@ManagerApplication()
@Controller('rest/v1/admin/organisations')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class OrganisationOnboardingController {
  constructor(private readonly organisationOnboarding: OrganisationOnboardingService) {}

  @Get()
  list(@AuthUser() ctx: AuthContext) {
    return this.organisationOnboarding.listOrganisations(ctx);
  }

  @Get(':organisationId')
  get(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationOnboarding.getOrganisation(ctx, organisationId);
  }

  // Owner correction 2026-10-23: the former `POST /admin/organisations` (organisation name + CEO name + email, which
  // created the organisation before the CEO had done anything) is REMOVED, not hidden. A new organisation now exists only
  // once its invited CEO accepts (`OrganisationInvitationController` below → `/invitations/accept`).

  @Post(':organisationId/ceo-invite/resend')
  resendCeoInvite(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: ResendCeoInviteDto) {
    return this.organisationOnboarding.resendCeoInvite(ctx, organisationId, dto?.reason);
  }

  @Post(':organisationId/ceo-invite/revoke')
  revokeCeoInvite(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationOnboarding.revokeCeoInvite(ctx, organisationId);
  }

  // Organisation isolation (owner policy, 2026-10-15): the former `:organisationId/initial-manager-invite` routes (invite, resend,
  // revoke, replace — "Super Admin side, for an arbitrary organisation") are REMOVED, not hidden. A URL parameter must never grant
  // authority over another organisation's Initial Manager. Initial Manager onboarding exists only on `ManagerController`'s
  // same-organisation routes, where the organisation is the caller's own verified one.
}

/**
 * Owner correction 2026-10-23 — the ONE way a platform administrator starts a new organisation: an email-only CEO
 * invitation (Settings → Members → Add). `PlatformAdminGuard` here; `OrganisationOnboardingService` re-checks the claim
 * and the `core.organisation_invitation_*` functions check it a third time. No organisation name or CEO name is accepted
 * (the DTO whitelists `email` only: anything else is a 400). A malformed `:invitationId` is 404.
 */
@ManagerApplication()
@Controller('rest/v1/admin/organisation-invitations')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class OrganisationInvitationController {
  constructor(private readonly organisationOnboarding: OrganisationOnboardingService) {}

  @Get()
  list(@AuthUser() ctx: AuthContext, @Query() query: ListCeoInvitationsDto) {
    return this.organisationOnboarding.listCeoInvitations(ctx, query.page ?? 1, query.limit ?? 25);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  invite(@AuthUser() ctx: AuthContext, @Body() dto: InviteCeoDto) {
    return this.organisationOnboarding.inviteCeo(ctx, dto.email);
  }

  @Post(':invitationId/resend')
  @HttpCode(HttpStatus.OK)
  resend(@AuthUser() ctx: AuthContext, @Param('invitationId') invitationId: string) {
    return this.organisationOnboarding.resendCeoInvitation(ctx, invitationId);
  }

  @Post(':invitationId/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@AuthUser() ctx: AuthContext, @Param('invitationId') invitationId: string) {
    await this.organisationOnboarding.revokeCeoInvitation(ctx, invitationId);
    return { revoked: true };
  }
}
