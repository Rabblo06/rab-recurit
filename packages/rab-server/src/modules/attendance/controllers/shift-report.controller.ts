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

@Controller('rest/v1/attendance/report')
@UseGuards(JwtAuthGuard)
export class ShiftReportController {
  constructor(
    private readonly shiftReportService: ShiftReportService,
    private readonly reviews: ShiftReviewService,
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
