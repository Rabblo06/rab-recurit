import { PermissionFlag } from '@rab/shared';
import { Controller, Get, HttpCode, HttpStatus, Param, Patch, UseGuards } from '@nestjs/common';

import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ShiftReportService } from '../services/shift-report.service';

@Controller('rest/v1/attendance/report')
@UseGuards(JwtAuthGuard)
export class ShiftReportController {
  constructor(private readonly shiftReportService: ShiftReportService) {}

  /** `report.view` — already provisioned, already what mobile's `VenueManagerProvider.allows('report.view')` checks. No new permission flag. */
  @Get('shift/:shiftId')
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_VIEW))
  getReport(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string) {
    return this.shiftReportService.getReport(ctx, shiftId);
  }

  /** `report.export` — finalising triggers a worker-rendered PDF + email, closer to an "export" action than a "view" one. */
  @Patch('shift/:shiftId/finalise')
  @HttpCode(HttpStatus.OK)
  @UseGuards(PermissionGuard(PermissionFlag.REPORT_EXPORT))
  async finalise(@AuthUser() ctx: AuthContext, @Param('shiftId') shiftId: string) {
    await this.shiftReportService.finalise(ctx, shiftId);
    return this.shiftReportService.getReport(ctx, shiftId);
  }
}
