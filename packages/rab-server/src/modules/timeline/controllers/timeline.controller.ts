import { PermissionFlag } from '@rab/shared';
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { TimelineQueryDto } from '../dto/timeline-query.dto';
import { TimelineService } from '../services/timeline.service';

/**
 * Wave 5 — read-only per-entity timelines over the immutable audit log. GET only: there is no write, update or delete
 * route here (route-table test). Each route's flag is re-checked in TimelineService with the entity's own read rule.
 */
@ManagerApplication()
@Controller('rest/v1/timeline')
@UseGuards(JwtAuthGuard)
export class TimelineController {
  constructor(private readonly timeline: TimelineService) {}

  @Get('shifts/:id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  shift(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: TimelineQueryDto) {
    return this.timeline.forShift(ctx, id, query);
  }

  @Get('offers/:id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  offer(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: TimelineQueryDto) {
    return this.timeline.forOffer(ctx, id, query);
  }

  @Get('staff/:id')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  staff(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: TimelineQueryDto) {
    return this.timeline.forStaff(ctx, id, query);
  }

  @Get('attendance/:id')
  @UseGuards(PermissionGuard(PermissionFlag.ATTENDANCE_VIEW))
  attendance(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: TimelineQueryDto) {
    return this.timeline.forAttendance(ctx, id, query);
  }

  @Get('payroll-records/:id')
  @UseGuards(PermissionGuard(PermissionFlag.PAYROLL_VIEW))
  payrollRecord(@AuthUser() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() query: TimelineQueryDto) {
    return this.timeline.forPayrollRecord(ctx, id, query);
  }
}
