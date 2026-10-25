import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { PinAiModelDto, UnpinAiModelDto } from '../dto/ai-model-setting.dto';
import { AiModelSettingsService } from '../services/ai-model-settings.service';

/**
 * Settings → AI "AI models" (docs/ai/PHASE1_TWENTY_PLAN.md §7). Web console only; `ai.settings` declared here (layer 1);
 * the service re-checks it, requires the organisation's CEO, both AI switches and — for a write — a recent step-up and a
 * reason (layer 2); RLS adds the organisation and CEO-writer predicates (layers 4–5). Transport only. Deliberately NOT
 * behind AiAvailableGuard: choosing a model is how an organisation leaves the "not configured" state.
 */
@Controller('rest/v1/ai/settings')
@ManagerApplication()
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
export class AiSettingsController {
  constructor(private readonly settings: AiModelSettingsService) {}

  @Get('models')
  models(@AuthUser() ctx: AuthContext) {
    return this.settings.view(ctx);
  }

  @Put('models/:tier')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  pin(@AuthUser() ctx: AuthContext, @Param('tier') tier: string, @Body() dto: PinAiModelDto) {
    return this.settings.pin(ctx, tier, dto.modelId, dto.reason);
  }

  @Delete('models/:tier')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  unpin(@AuthUser() ctx: AuthContext, @Param('tier') tier: string, @Body() dto: UnpinAiModelDto) {
    return this.settings.unpin(ctx, tier, dto.reason);
  }
}
