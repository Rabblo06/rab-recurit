import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ShiftTeamService } from '../services/shift-team.service';
import { RequireWorkspaceGuard } from '../../../engine/core-modules/tenant/guards/require-workspace.guard';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PaginationDto } from '../../../engine/dto/pagination.dto';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { CheckInDto } from '../dto/check-in.dto';
import { ClockInDto } from '../dto/clock-in.dto';
import { ClockOutDto } from '../dto/clock-out.dto';
import { CorrectAttendanceDto } from '../dto/correct-attendance.dto';
import { GeofenceExitDto } from '../dto/geofence-exit.dto';
import { AttendancePerUserThrottleGuard } from '../guards/attendance-per-user-throttle.guard';
import { ListAttendanceDto } from '../dto/list-attendance.dto';
import { AttendanceService } from '../services/attendance.service';
import { MobileApplication } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';

@Controller('rest/v1/attendance')
@UseGuards(JwtAuthGuard)
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService, private readonly shiftTeamService: ShiftTeamService) {}

  @MobileApplication('staff_app')
  @Get('me/shift/:shiftId/team')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), RequireWorkspaceGuard)
  getTeam(@AuthUser() ctx: AuthContext, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.shiftTeamService.list(ctx, shiftId);
  }

  /**
   * Staff CHECK IN (arrival evidence, not worked time). 200 with the booking's check-in state; a repeat returns the
   * original check-in unchanged (`alreadyCheckedIn: true`). Clock In then requires it for bookings with
   * `checkInRequired`. Error codes: see `AttendanceService.checkIn` / attendance.exceptions.ts.
   */
  @MobileApplication('staff_app')
  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  checkIn(@AuthUser() ctx: AuthContext, @Body() dto: CheckInDto) {
    return this.attendanceService.checkIn(ctx, dto);
  }

  @MobileApplication('staff_app')
  @Get('me/shift/:shiftId/check-in')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  getCheckIn(@AuthUser() ctx: AuthContext, @Param('shiftId', ParseUUIDPipe) shiftId: string) {
    return this.attendanceService.getCheckIn(ctx, shiftId);
  }

  @MobileApplication('staff_app')

  @Post('clock-in')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  clockIn(@AuthUser() ctx: AuthContext, @Body() dto: ClockInDto) {
    return this.attendanceService.clockIn(ctx, dto);
  }

  @MobileApplication('staff_app')

  @Post('clock-out')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  clockOut(@AuthUser() ctx: AuthContext, @Body() dto: ClockOutDto) {
    return this.attendanceService.clockOut(ctx, dto);
  }

  /** Part 37 — mobile-detected geofence exit while clocked in. Synchronous: the attendance state change commits in this request, never queued through a worker. */
  @MobileApplication('staff_app')
  @Post('geofence-exit')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK), AttendancePerUserThrottleGuard)
  geofenceExit(@AuthUser() ctx: AuthContext, @Body() dto: GeofenceExitDto) {
    return this.attendanceService.autoClockOutOnGeofenceExit(ctx, dto);
  }

  @MobileApplication('staff_app')

  @Get('me/active')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  getActive(@AuthUser() ctx: AuthContext) {
    return this.attendanceService.getActive(ctx);
  }

  @MobileApplication('staff_app')

  @Get('me/history')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_CLOCK))
  getHistory(@AuthUser() ctx: AuthContext, @Query() pagination: PaginationDto) {
    return this.attendanceService.getHistory(ctx, pagination);
  }

  @MobileApplication('staff_app')

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
  @MobileApplication('venue_manager_app')
  @Post(':attendanceId/correct')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  correct(@AuthUser() ctx: AuthContext, @Param('attendanceId') attendanceId: string, @Body() dto: CorrectAttendanceDto) {
    return this.attendanceService.correct(ctx, attendanceId, dto);
  }
}
