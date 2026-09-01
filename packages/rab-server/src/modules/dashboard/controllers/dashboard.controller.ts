import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { DashboardService } from '../services/dashboard.service';

/**
 * No blanket `PermissionGuard` here on purpose — each field of the summary
 * is independently gated inside `DashboardService` against the SAME
 * permission its own full-list endpoint already requires (`STAFF_VIEW`,
 * `MANAGER_MANAGE`, `VENUE_VIEW`, `SCHEDULE_VIEW`), so this aggregate can
 * never reveal a count the caller couldn't already see via `/staff`,
 * `/managers`, `/venues`, or `/shifts`+`/offers` themselves.
 */
@Controller('rest/v1/dashboard')
@UseGuards(JwtAuthGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  summary(@AuthUser() ctx: AuthContext) {
    return this.dashboardService.getSummary(ctx);
  }
}
