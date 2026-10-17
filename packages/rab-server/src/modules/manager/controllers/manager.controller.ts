import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { BulkEmailDto } from '../../staff/dto/bulk-email.dto';
import { AssignVenueDto } from '../dto/assign-venue.dto';
import { StepUpReauthDto } from '../../../engine/core-modules/auth/dto/step-up-reauth.dto';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { InviteInitialManagerDto } from '../dto/invite-initial-manager.dto';
import { ListManagersDto } from '../dto/list-managers.dto';
import { ReplaceInitialManagerDto } from '../dto/replace-initial-manager.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { CeoCreationGuard } from '../guards/ceo-creation.guard';
import { ManagerService } from '../services/manager.service';
import { OrganisationOnboardingService } from '../services/organisation-onboarding.service';
import { ChangeEmailDto } from '../../identity/dto/change-email.dto';

@ManagerApplication()
@Controller('rest/v1/managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.MANAGER_MANAGE))
export class ManagerController {
  constructor(
    private readonly managerService: ManagerService,
    private readonly organisationOnboarding: OrganisationOnboardingService,
  ) {}

  @Get()
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListManagersDto) {
    return this.managerService.list(ctx, dto);
  }

  @Get(':id')
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.get(ctx, id);
  }

  @Post()
  @UseGuards(CeoCreationGuard)
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateManagerDto) {
    return this.managerService.create(ctx, dto);
  }

  @Post('bulk-email')
  bulkEmail(@AuthUser() ctx: AuthContext, @Body() dto: BulkEmailDto) {
    return this.managerService.bulkEmail(ctx, dto);
  }

  @Patch(':id')
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateManagerDto) {
    return this.managerService.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  deactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.setActive(ctx, id, false);
  }

  @Post(':id/reactivate')
  reactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.setActive(ctx, id, true);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  resetPassword(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.resetPassword(ctx, id);
  }

  @Post(':id/resend-invite')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  resendInvite(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.resendInvite(ctx, id);
  }

  @Patch(':id/pending-email')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  changePendingEmail(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: ChangePendingEmailDto) {
    return this.managerService.changePendingEmail(ctx, id, dto);
  }

  @Post(':id/cancel-invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  cancelInvite(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.cancelInvite(ctx, id);
  }

  /** General "change email" — active or pending, one mutation either way. */
  @Patch(':id/email')
  changeEmail(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: ChangeEmailDto) {
    return this.managerService.changeEmail(ctx, id, dto);
  }

  @Get(':id/timeline')
  getTimeline(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.getTimeline(ctx, id);
  }

  @Get(':id/notes')
  listNotes(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.listNotes(ctx, id);
  }

  @Post(':id/notes')
  addNote(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AddNoteDto) {
    return this.managerService.addNote(ctx, id, dto);
  }

  @Get(':id/emails')
  listEmails(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.listEmails(ctx, id);
  }

  @Get(':id/venues')
  listVenues(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.listVenues(ctx, id);
  }

  @Post(':id/venues')
  @HttpCode(HttpStatus.NO_CONTENT)
  assignVenue(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AssignVenueDto) {
    return this.managerService.assignVenue(ctx, id, dto.venueId);
  }

  @Delete(':id/venues/:venueId')
  @HttpCode(HttpStatus.NO_CONTENT)
  unassignVenue(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Param('venueId') venueId: string) {
    return this.managerService.unassignVenue(ctx, id, venueId);
  }

  /** P2.8 — step-up reauth: `currentPassword` is required and verified before anything else runs. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: StepUpReauthDto) {
    return this.managerService.deleteUser(ctx, id, dto.currentPassword);
  }

  /**
   * The ONLY Initial Manager onboarding routes (organisation isolation, 2026-10-15): always the caller's OWN organisation, taken
   * from the verified session inside the service — there is no organisation argument. This class's own
   * `PermissionGuard(MANAGER_MANAGE)` is deliberately loose (any Manager holding that flag reaches the route) —
   * `OrganisationOnboardingService.assertActorCanManageOwnInitialManager` is the real, service-layer gate (CLAUDE.md's "layer 2
   * is the one people skip"): only this organisation's own CEO, or a platform admin within their own organisation, succeeds.
   */
  @Post('initial-manager-invite')
  inviteInitialManager(@AuthUser() ctx: AuthContext, @Body() dto: InviteInitialManagerDto) {
    return this.organisationOnboarding.inviteInitialManager(ctx, dto);
  }

  @Post('initial-manager-invite/resend')
  resendInitialManagerInvite(@AuthUser() ctx: AuthContext) {
    return this.organisationOnboarding.resendInitialManagerInvite(ctx);
  }

  @Post('initial-manager-invite/revoke')
  revokeInitialManagerInvite(@AuthUser() ctx: AuthContext) {
    return this.organisationOnboarding.revokeInitialManagerInvite(ctx);
  }

  /** P2.9 gap review, item 2 — replaces a never-activated, resend-exhausted Initial Manager invitation. Unlimited replacements (owner decision, 2026-10-15); see `OrganisationOnboardingService.replaceInitialManager`. */
  @Post('initial-manager-invite/replace')
  replaceInitialManager(@AuthUser() ctx: AuthContext, @Body() dto: ReplaceInitialManagerDto) {
    return this.organisationOnboarding.replaceInitialManager(ctx, dto);
  }
}
