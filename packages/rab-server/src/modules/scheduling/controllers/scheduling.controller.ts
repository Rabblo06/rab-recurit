import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CreateJobRoleDto } from '../dto/create-job-role.dto';
import { CreateShiftDto } from '../dto/create-shift.dto';
import { ListShiftsDto } from '../dto/list-shifts.dto';
import { SchedulingService } from '../services/scheduling.service';

@Controller('rest/v1')
@UseGuards(JwtAuthGuard)
export class SchedulingController {
  constructor(private readonly schedulingService: SchedulingService) {}

  @Get('job-roles')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  listJobRoles(@AuthUser() ctx: AuthContext) {
    return this.schedulingService.listJobRoles(ctx);
  }

  @Post('job-roles')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_CREATE), RequireWorkspaceGuard)
  createJobRole(@AuthUser() ctx: AuthContext, @Body() dto: CreateJobRoleDto) {
    return this.schedulingService.createJobRole(ctx, dto);
  }

  @Get('shifts')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListShiftsDto) {
    return this.schedulingService.list(ctx, dto);
  }

  @Get('shifts/:id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.get(ctx, id);
  }

  @Post('shifts')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_CREATE))
  create(@AuthUser() ctx: AuthContext, @Body() dto: CreateShiftDto) {
    return this.schedulingService.create(ctx, dto);
  }

  @Post('shifts/:id/publish')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_PUBLISH))
  publish(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.schedulingService.publish(ctx, id);
  }

  @Post('shifts/:id/cancel')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_CREATE))
  cancel(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body('reason') reason: string) {
    return this.schedulingService.cancel(ctx, id, reason);
  }
}
