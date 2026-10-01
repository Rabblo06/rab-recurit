import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';

import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { ApproveReplacementRequestDto } from '../dto/approve-replacement-request.dto';
import { ReplacementRequestService } from '../services/replacement-request.service';

/**
 * PHASE 18 of the rab-worker migration — minimal API support for the
 * replacement-staff automation the worker prepares
 * (`replacement-staff.job.ts`). Gated on `OFFER_SEND`: approving a
 * replacement request ultimately sends an offer, the same permission every
 * other offer-send route already requires — no new permission flag was
 * introduced for this.
 */
@Controller('rest/v1/replacement-requests')
@UseGuards(JwtAuthGuard)
export class ReplacementRequestController {
  constructor(private readonly replacementRequestService: ReplacementRequestService) {}

  @Get()
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  list(@AuthUser() ctx: AuthContext) {
    return this.replacementRequestService.list(ctx);
  }

  @Get(':id')
  @UseGuards(PermissionGuard(PermissionFlag.SCHEDULE_VIEW))
  get(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.replacementRequestService.get(ctx, id);
  }

  @Post(':id/approve')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_SEND))
  approve(@AuthUser() ctx: AuthContext, @Param('id') id: string, @Body() dto: ApproveReplacementRequestDto) {
    return this.replacementRequestService.approve(ctx, id, dto);
  }

  @Post(':id/reject')
  @ManagerApplication()
  @UseGuards(PermissionGuard(PermissionFlag.OFFER_SEND))
  reject(@AuthUser() ctx: AuthContext, @Param('id') id: string) {
    return this.replacementRequestService.reject(ctx, id);
  }
}
