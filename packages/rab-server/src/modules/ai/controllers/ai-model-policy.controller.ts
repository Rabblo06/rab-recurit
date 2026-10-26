import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { UpdateAiModelPolicyDto } from '../dto/ai-model-policy.dto';
import { AiModelSettingsService } from '../services/ai-model-settings.service';

/**
 * Settings → AI model policy (C1 / CD-1 / CD-2): chat level, agent level, allowed levels, data residency. Its own
 * controller (PL-13) so the Phase 1 / Phase 8 `ai-settings.controller.ts` stays Agent 8's. Layers as the model pins.
 */
@Controller('rest/v1/ai/settings')
@ManagerApplication()
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
export class AiModelPolicyController {
  constructor(private readonly settings: AiModelSettingsService) {}

  @Put('model-policy')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  update(@AuthUser() ctx: AuthContext, @Body() dto: UpdateAiModelPolicyDto) {
    return this.settings.updatePolicy(ctx, dto);
  }
}
