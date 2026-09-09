import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { AddNoteDto } from '../../identity/dto/add-note.dto';
import { ChangePendingEmailDto } from '../../identity/dto/change-pending-email.dto';
import { BulkEmailDto } from '../dto/bulk-email.dto';
import { CreateStaffDto } from '../dto/create-staff.dto';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { StaffService } from '../services/staff.service';

@Controller('rest/v1/staff')
@UseGuards(JwtAuthGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.staffService.list(ctx, pagination);
  }

  // Declared before `:id` — Nest matches routes in declaration order, so
  // this must come first or `:id` would swallow "next-reference" as a param.
  @Get('next-reference')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_CREATE))
  suggestNextStaffRef(@AuthUser() ctx: AuthContext) {
    return this.staffService.suggestNextStaffRef(ctx);
  }

  @Get(':id')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.get(ctx, id);
  }

  @Post()
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_CREATE), RequireWorkspaceGuard)
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateStaffDto) {
    return this.staffService.create(ctx, dto);
  }

  @Post('bulk-email')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  bulkEmail(@AuthUser() ctx: AuthContext, @Body() dto: BulkEmailDto) {
    return this.staffService.bulkEmail(ctx, dto);
  }

  @Patch(':id')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  update(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: UpdateStaffDto) {
    return this.staffService.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_DEACTIVATE))
  deactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.deactivate(ctx, id);
  }

  @Post(':id/reactivate')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_DEACTIVATE))
  reactivate(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.reactivate(ctx, id);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  resetPassword(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.resetPassword(ctx, id);
  }

  @Post(':id/resend-invite')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  resendInvite(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.resendInvite(ctx, id);
  }

  @Patch(':id/pending-email')
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  changePendingEmail(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: ChangePendingEmailDto) {
    return this.staffService.changePendingEmail(ctx, id, dto);
  }

  /** General "change email" — active or pending, one mutation either way (see `StaffService.changeEmail`'s own doc comment). */
  @Patch(':id/email')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  changeEmail(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: ChangePendingEmailDto) {
    return this.staffService.changeEmail(ctx, id, dto);
  }

  @Get(':id/timeline')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  getTimeline(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.getTimeline(ctx, id);
  }

  @Get(':id/notes')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  listNotes(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.listNotes(ctx, id);
  }

  @Get(':id/emails')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  listEmails(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.listEmails(ctx, id);
  }

  @Post(':id/notes')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_EDIT))
  addNote(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: AddNoteDto) {
    return this.staffService.addNote(ctx, id, dto);
  }

  @Post(':id/cancel-invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard(PermissionFlag.USER_RESET_PASSWORD))
  cancelInvite(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.cancelInvite(ctx, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_DEACTIVATE))
  deleteUser(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.deleteUser(ctx, id);
  }
}
