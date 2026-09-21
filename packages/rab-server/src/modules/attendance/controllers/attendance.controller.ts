import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ClockInDto } from '../dto/clock-in.dto';
import { ClockOutDto } from '../dto/clock-out.dto';
import { CorrectAttendanceDto } from '../dto/correct-attendance.dto';
import { GeofenceExitDto } from '../dto/geofence-exit.dto';
import { AttendancePerUserThrottleGuard } from '../guards/attendance-per-user-throttle.guard';
import { ListAttendanceDto } from '../dto/list-attendance.dto';
import { AttendanceService } from '../services/attendance.service';

@Controller('rest/v1/attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Post('clock-in')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  clockIn(@AuthUser() ctx: AuthContext, @Body() dto: ClockInDto) {
    return this.attendanceService.clockIn(ctx, dto);
  }

  @Post('clock-out')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  clockOut(@AuthUser() ctx: AuthContext, @Body() dto: ClockOutDto) {
    return this.attendanceService.clockOut(ctx, dto);
  }

  /** Part 37 — mobile-detected geofence exit while clocked in. Synchronous: the attendance state change commits in this request, never queued through a worker. */
  @Post('geofence-exit')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  geofenceExit(@AuthUser() ctx: AuthContext, @Body() dto: GeofenceExitDto) {
    return this.attendanceService.autoClockOutOnGeofenceExit(ctx, dto);
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
  list(@AuthUser() ctx: AuthContext, @Query() dto: ListAttendanceDto) {
    return this.attendanceService.list(ctx, dto);
  }

  /** Manager correction (Parts 42-44) — `attendance.edit`, pre-provisioned since AttendanceSchema, wired to an endpoint for the first time here. */
  @Post(':attendanceId/correct')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  correct(@AuthUser() ctx: AuthContext, @Param('attendanceId') attendanceId: string, @Body() dto: CorrectAttendanceDto) {
    return this.attendanceService.correct(ctx, attendanceId, dto);
  }
}
