import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateStaffDto } from '../dto/create-staff.dto';
import { UpdateStaffDto } from '../dto/update-staff.dto';
import { StaffService } from '../services/staff.service';

@Controller('rest/v1/staff')
@UseGuards(JwtAuthGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  list(@AuthUser() ctx: AuthContext) {
    return this.staffService.list(ctx);
  }

  @Get(':id')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.staffService.get(ctx, id);
  }

  @Post()
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_CREATE))
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateStaffDto) {
    return this.staffService.create(ctx, dto);
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
}
