import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ShiftReportService } from '../services/shift-report.service';
import { MobileApplication } from '../../../engine/core-modules/auth/guards/mobile-application.decorator';
import { ListShiftReportsDto } from '../dto/list-shift-reports.dto';
import { FinaliseReportDto, SaveStaffReviewDto } from '../dto/staff-review.dto';
import { ShiftReviewService } from '../services/shift-review.service';
import { RecordAttendanceDto, ReopenNoShowDto } from '../dto/record-attendance.dto';
import { AttendanceService } from '../services/attendance.service';
import { OnBehalfPunchDto } from '../dto/check-in.dto';

@Controller('rest/v1/attendance/report')
@UseGuards(JwtAuthGuard)
export class ShiftReportController {
  constructor(
    private readonly shiftReportService: ShiftReportService,
    private readonly reviews: ShiftReviewService,
    private readonly attendance: AttendanceService,
  ) {}

  /**
   * Reports (`bucket=current`) / History (`bucket=history`) lists — server-side five-hour lifecycle (report-lifecycle.ts),
   * same scope rule as the single report. Declared before `shift/:shiftId` only for readability; the paths do not overlap.
   */
  @MobileApplication('venue_manager_app')
  @Get('shifts')
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_VIEW))
  listReports(@AuthUser() ctx: AuthContext, @Query() dto: ListShiftReportsDto) {
    return this.shiftReportService.listReports(ctx, dto);
  }

  /** `report.view` — already provisioned, already what mobile's `VenueManagerProvider.allows('report.view')` checks. No new permission flag. */
  @MobileApplication('venue_manager_app')
  @Get('shift/:shiftId')
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_VIEW))
  getReport(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string) {
    return this.shiftReportService.getReport(ctx, shiftId);
  }

  /** `report.export` — finalising triggers a worker-rendered PDF + email, closer to an "export" action than a "view" one. */
  @MobileApplication('venue_manager_app')
  @Patch('shift/:shiftId/finalise')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_EXPORT))
  async finalise(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string, @Body() dto: FinaliseReportDto) {
    await this.shiftReportService.finalise(ctx, shiftId, dto);
    return this.shiftReportService.getReport(ctx, shiftId);
  }

  /** Completes one seat's attendance review (resolved clock-out or confirmed no-show). `attendance.edit`, like corrections. */
  @MobileApplication('venue_manager_app')
  @Post('shift/:shiftId/staff/:staffProfileId/attendance-review')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  reviewAttendance(@AuthUser() ctx: AuthContext, @Param('shiftId', ParseUUIDPipe) shiftId: string, @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string) {
    return this.shiftReportService.reviewAttendance(ctx, shiftId, staffProfileId);
  }

  /**
   * "Record attendance" for one seat (manager-entered or manager-completed, owner rule 2026-10-21). The organisation,
   * workspace, seat and provenance come from the session and the route; the body carries only the verified times, the
   * break, the reason and the version last read. Returns the authoritative report. `attendance.edit`, like corrections.
   */
  @MobileApplication('venue_manager_app')
  @Post('shift/:shiftId/staff/:staffProfileId/record-attendance')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  recordAttendance(
    @AuthUser() ctx: AuthContext,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: RecordAttendanceDto,
  ) {
    return this.attendance.recordAttendance(ctx, shiftId, staffProfileId, dto);
  }

  /**
   * Venue Manager live clock-in ON BEHALF of a checked-in staff member (reason ≥ 10 words; manager, reason, provenance
   * and server time recorded). Returns the authoritative report. `attendance.edit`, like the other seat actions.
   */
  @MobileApplication('venue_manager_app')
  @Post('shift/:shiftId/staff/:staffProfileId/clock-in-on-behalf')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  clockInOnBehalf(
    @AuthUser() ctx: AuthContext,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: OnBehalfPunchDto,
  ) {
    return this.attendance.clockInOnBehalf(ctx, shiftId, staffProfileId, dto);
  }

  /** Venue Manager live clock-out ON BEHALF (after a valid clock-in; refused at geofence-enforcing venues). */
  @MobileApplication('venue_manager_app')
  @Post('shift/:shiftId/staff/:staffProfileId/clock-out-on-behalf')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  clockOutOnBehalf(
    @AuthUser() ctx: AuthContext,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: OnBehalfPunchDto,
  ) {
    return this.attendance.clockOutOnBehalf(ctx, shiftId, staffProfileId, dto);
  }

  /** "Confirm no-show": the manager's explicit decision on a seat with no attendance (the worker's mark is provisional). */
  @MobileApplication('venue_manager_app')
  @Post('shift/:shiftId/staff/:staffProfileId/confirm-no-show')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  confirmNoShow(@AuthUser() ctx: AuthContext, @Param('shiftId', ParseUUIDPipe) shiftId: string, @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string) {
    return this.shiftReportService.confirmNoShow(ctx, shiftId, staffProfileId);
  }

  /** Reopens a confirmed no-show back to provisional (audited, reason required) before finalisation. */
  @MobileApplication('venue_manager_app')
  @Post('shift/:shiftId/staff/:staffProfileId/reopen-no-show')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_EDIT))
  reopenNoShow(
    @AuthUser() ctx: AuthContext,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: ReopenNoShowDto,
  ) {
    return this.shiftReportService.reopenNoShow(ctx, shiftId, staffProfileId, dto.reason);
  }

  /** Staff review tab — `review.create`, the architecture's own permission for rating an assignment (venue_manager + manager defaults). */
  @MobileApplication('venue_manager_app')
  @Get('shift/:shiftId/reviews/:staffProfileId')
  @UseGuards(PermissionGuard(PermissionFlag.REVIEW_CREATE))
  getReview(@AuthUser() ctx: AuthContext, @Param('shiftId', ParseUUIDPipe) shiftId: string, @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string) {
    return this.reviews.get(ctx, shiftId, staffProfileId);
  }

  @MobileApplication('venue_manager_app')
  @Put('shift/:shiftId/reviews/:staffProfileId')
  @UseGuards(PermissionGuard(PermissionFlag.REVIEW_CREATE))
  saveReview(
    @AuthUser() ctx: AuthContext,
    @Param('shiftId', ParseUUIDPipe) shiftId: string,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Body() dto: SaveStaffReviewDto,
  ) {
    return this.reviews.save(ctx, shiftId, staffProfileId, dto);
  }
}
