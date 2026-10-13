import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../../engine/guards/platform-admin.guard';
import { CreateOrganisationDto } from '../dto/create-organisation.dto';
import { InviteInitialManagerDto } from '../dto/invite-initial-manager.dto';
import { ReplaceInitialManagerDto } from '../dto/replace-initial-manager.dto';
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

  @Post()
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateOrganisationDto) {
    return this.organisationOnboarding.createOrganisationWithCeoInvite(ctx, dto);
  }

  @Post(':organisationId/ceo-invite/resend')
  resendCeoInvite(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationOnboarding.resendCeoInvite(ctx, organisationId);
  }

  @Post(':organisationId/ceo-invite/revoke')
  revokeCeoInvite(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationOnboarding.revokeCeoInvite(ctx, organisationId);
  }

  /** P2.9C — Super Admin side, for an arbitrary organisation. The CEO's own equivalent is `ManagerController`'s `initial-manager-invite` routes (organisationId implied by their own session, not a URL param). */
  @Post(':organisationId/initial-manager-invite')
  inviteInitialManager(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: InviteInitialManagerDto) {
    return this.organisationOnboarding.inviteInitialManager(ctx, organisationId, dto);
  }

  @Post(':organisationId/initial-manager-invite/resend')
  resendInitialManagerInvite(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationOnboarding.resendInitialManagerInvite(ctx, organisationId);
  }

  @Post(':organisationId/initial-manager-invite/revoke')
  revokeInitialManagerInvite(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string) {
    return this.organisationOnboarding.revokeInitialManagerInvite(ctx, organisationId);
  }

  /** P2.9 gap review, item 2 — Super Admin side, for an arbitrary organisation. Uncapped (see `OrganisationOnboardingService.replaceInitialManager`'s own doc comment for why). */
  @Post(':organisationId/initial-manager-invite/replace')
  replaceInitialManager(@AuthUser() ctx: AuthContext, @Param('organisationId') organisationId: string, @Body() dto: ReplaceInitialManagerDto) {
    return this.organisationOnboarding.replaceInitialManager(ctx, organisationId, dto);
  }
}
