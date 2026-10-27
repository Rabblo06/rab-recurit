import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PlatformAdminGuard } from '../../../engine/guards/platform-admin.guard';
import { AiUsageQueryDto, UpdateAiOrganisationSettingDto } from '../dto/ai-admin.dto';
import { AiAdminService } from '../services/ai-admin.service';

/**
 * Platform-administrator AI controls and usage METADATA (the Admin Panel integration reads these in a later stage).
 * Never conversation content: there is deliberately no admin route that reads a transcript.
 */
@Controller('rest/v1/admin/ai')
@ManagerApplication()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AiAdminController {
  constructor(private readonly admin: AiAdminService) {}

  @Get('overview')
  overview(@AuthUser() ctx: AuthContext) {
    return this.admin.overview(ctx);
  }

  @Get('usage')
  usage(@AuthUser() ctx: AuthContext, @Query() dto: AiUsageQueryDto) {
    return this.admin.usageSummary(ctx, dto.from.slice(0, 10), dto.to.slice(0, 10), dto.limit ?? 50);
  }

  @Get('organisations/:organisationId/setting')
  getSetting(@AuthUser() ctx: AuthContext, @Param('organisationId', ParseUUIDPipe) organisationId: string) {
    return this.admin.getOrganisationSetting(ctx, organisationId);
  }

  @Put('organisations/:organisationId/setting')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  setSetting(@AuthUser() ctx: AuthContext, @Param('organisationId', ParseUUIDPipe) organisationId: string, @Body() dto: UpdateAiOrganisationSettingDto) {
    return this.admin.setOrganisationSetting(ctx, organisationId, dto.enabled, dto.reason);
  }
}
