import { PermissionFlag } from '@rab/shared';
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ListStaffReviewsDto } from '../dto/list-staff-reviews.dto';
import { StaffReviewInsightsService } from '../services/staff-review-insights.service';

/**
 * Web console "Staff reviews" tab (read-only). `@ManagerApplication()`: mobile app credentials are refused, so a Venue
 * Manager's phone never reads other managers' reviews. The service re-checks the permission and owner scope (404).
 */
@Controller('rest/v1/staff/:staffProfileId/reviews')
@UseGuards(JwtAuthGuard)
@ManagerApplication()
export class StaffReviewsController {
  constructor(private readonly insights: StaffReviewInsightsService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  summary(@AuthUser() ctx: AuthContext, @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string, @Query() dto: ListStaffReviewsDto) {
    return this.insights.summary(ctx, staffProfileId, dto);
  }

  @Get(':reviewId')
  @UseGuards(PermissionGuard(PermissionFlag.STAFF_VIEW))
  detail(
    @AuthUser() ctx: AuthContext,
    @Param('staffProfileId', ParseUUIDPipe) staffProfileId: string,
    @Param('reviewId', ParseUUIDPipe) reviewId: string,
  ) {
    return this.insights.detail(ctx, staffProfileId, reviewId);
  }
}
