import { PermissionFlag } from '@rab/shared';
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AVATAR_MAX_BYTES, singleImageUploadOptions } from '../../../engine/core-modules/storage/upload-limits';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { AssignVenueDto } from '../dto/assign-venue.dto';
import { CreateVenueManagerDto } from '../dto/create-venue-manager.dto';
import { ListVenueManagersDto } from '../dto/list-venue-managers.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangeEmailDto } from '../../identity/dto/change-email.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { BulkEmailDto } from '../../staff/dto/bulk-email.dto';
import { AssignVenueTeamStaffDto } from '../dto/assign-venue-team-staff.dto';
import { StepUpReauthDto } from '../../../engine/core-modules/auth/dto/step-up-reauth.dto';
import { VenueManagerService } from '../services/venue-manager.service';

/** Normal Manager flow: a Venue Manager inside the caller's own workspace. See VenueManagerService. */
@ManagerApplication()
@Controller('rest/v1/venue-managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.VENUE_MANAGER_CREATE), RequireWorkspaceGuard)
export class VenueManagerController {
  constructor(private readonly venueManagers: VenueManagerService) {}

  /** The Venue Managers of the caller's own workspace, with their venues. */
  @Get()
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListVenueManagersDto) {
    return this.venueManagers.listInOwnWorkspace(ctx, dto);
  }

  /** One Venue Manager of the caller's own workspace, with their venues (404 otherwise). */
  @Get(':id')
  get(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.getInOwnWorkspace(ctx, id);
  }

  @Post('bulk-email')
  bulkEmail(@AuthUser() ctx: AuthContext, @Body() dto: BulkEmailDto) {
    return this.venueManagers.bulkEmail(ctx, dto);
  }

  @Patch(':id')
  update(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateManagerDto) {
    return this.venueManagers.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  deactivate(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.setActive(ctx, id, false);
  }

  @Post(':id/reactivate')
  reactivate(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.setActive(ctx, id, true);
  }

  @Post(':id/reset-password')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.resetPassword(ctx, id);
  }

  @Post(':id/resend-invite')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  resendInvite(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.resendInvite(ctx, id);
  }

  @Patch(':id/pending-email')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  changePendingEmail(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangePendingEmailDto) {
    return this.venueManagers.changePendingEmail(ctx, id, dto);
  }

  @Post(':id/cancel-invite')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  @HttpCode(HttpStatus.NO_CONTENT)
  cancelInvite(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.cancelInvite(ctx, id);
  }

  @Patch(':id/email')
  changeEmail(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChangeEmailDto) {
    return this.venueManagers.changeEmail(ctx, id, dto);
  }

  @Get(':id/timeline')
  timeline(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.getTimeline(ctx, id);
  }

  @Get(':id/notes')
  listNotes(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.listNotes(ctx, id);
  }

  @Post(':id/notes')
  addNote(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddNoteDto) {
    return this.venueManagers.addNote(ctx, id, dto);
  }

  @Get(':id/emails')
  listEmails(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.listEmails(ctx, id);
  }

  /** Step-up reauth: `currentPassword` is verified (in ManagerService.deleteUser) before anything else runs. */
  @Delete(':id')
  deleteUser(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StepUpReauthDto) {
    return this.venueManagers.deleteUser(ctx, id, dto.currentPassword);
  }

  /** Profile photo, same limits as the Staff avatar (size and image type checked again by the storage layer). */
  @Post(':id/avatar')
  @UseInterceptors(FileInterceptor('file', singleImageUploadOptions(AVATAR_MAX_BYTES)))
  uploadAvatar(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    return this.venueManagers.uploadAvatar(ctx, id, file.buffer);
  }

  @Delete(':id/avatar')
  removeAvatar(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.removeAvatar(ctx, id);
  }

  /** The Staff this Venue Manager can see and select (workspace owner only). */
  @Get(':id/staff')
  listTeam(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.venueManagers.listTeam(ctx, id);
  }

  @Post(':id/staff')
  assignTeamStaff(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignVenueTeamStaffDto) {
    return this.venueManagers.assignTeamStaff(ctx, id, dto);
  }

  @Delete(':id/staff/:staffId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeTeamStaff(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.venueManagers.removeTeamStaff(ctx, id, staffId);
  }

  @Post()
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateVenueManagerDto) {
    return this.venueManagers.createInOwnWorkspace(ctx, dto);
  }

  /** Link one of the caller's own-workspace Venue Managers to one of the caller's own-workspace Venues. */
  @Post(':id/venues')
  @HttpCode(HttpStatus.NO_CONTENT)
  assignVenue(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignVenueDto) {
    return this.venueManagers.assignVenueInOwnWorkspace(ctx, id, dto.venueId);
  }
}
