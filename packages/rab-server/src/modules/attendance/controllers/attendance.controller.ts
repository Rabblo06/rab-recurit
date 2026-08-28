import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ClockInDto } from '../dto/clock-in.dto';
import { AttendanceService } from '../services/attendance.service';

@Controller('rest/v1/attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('clock-in')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  clockIn(@AuthUser() ctx: AuthContext, @Body() dto: ClockInDto) {
    return this.attendanceService.clockIn(ctx, dto);
  }

  @Post('clock-out')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  clockOut(@AuthUser() ctx: AuthContext) {
    return this.attendanceService.clockOut(ctx);
  }

  @Get('me/active')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  getActive(@AuthUser() ctx: AuthContext) {
    return this.attendanceService.getActive(ctx);
  }

  @Get('me/history')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  getHistory(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.attendanceService.getHistory(ctx, pagination);
  }

  @Get('me/shift/:shiftId')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  getForShift(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string) {
    return this.attendanceService.getForShift(ctx, shiftId);
  }

  /** Manager/admin-facing: scoped by `ResourceScopeService`, same as `GET /shifts`/`GET /offers`. */
  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_VIEW))
  list(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.attendanceService.list(ctx, pagination);
  }
}
