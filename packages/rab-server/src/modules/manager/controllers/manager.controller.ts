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
import { CreateManagerDto } from '../dto/create-manager.dto';
import { ListManagersDto } from '../dto/list-managers.dto';
import { UpdateManagerDto } from '../dto/update-manager.dto';
import { CeoCreationGuard } from '../guards/ceo-creation.guard';
import { ManagerService } from '../services/manager.service';

@Controller('rest/v1/managers')
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.MANAGER_MANAGE))
export class ManagerController {
  constructor(private readonly managerService: ManagerService) {}

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
  changeEmail(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: ChangePendingEmailDto) {
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteUser(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.managerService.deleteUser(ctx, id);
  }
}
