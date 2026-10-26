import { PermissionFlag } from '@rab/shared';
import { Body, Controller, Delete, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PermissionGuard } from '../../../engine/guards/permission.guard';
import { DeleteAiInstructionsDto, UpdateAiInstructionsDto } from '../dto/ai-instructions.dto';
import { AiInstructionsService } from '../services/ai-instructions.service';

const WRITE_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/**
 * Settings → AI → Instructions (C1 / CD-4; route table AI_API_ROUTES). Web console only; `ai.settings` declared here
 * (layer 1); the service re-checks it and requires the CEO and both AI switches (layer 2), then the step-up
 * `organisation.ai.instructions.update` and a reason for every write. Transport only.
 *
 *   GET    /ai/settings/instructions   the current text (CEO)
 *   PUT    /ai/settings/instructions   set or replace { content, reason }
 *   DELETE /ai/settings/instructions   clear { reason }
 */
@Controller('rest/v1/ai/settings')
@ManagerApplication()
@UseGuards(JwtAuthGuard, PermissionGuard(PermissionFlag.AI_SETTINGS))
export class AiInstructionsController {
  constructor(private readonly instructions: AiInstructionsService) {}

  @Get('instructions')
  get(@AuthUser() ctx: AuthContext) {
    return this.instructions.get(ctx);
  }

  @Put('instructions')
  @Throttle(WRITE_THROTTLE)
  update(@AuthUser() ctx: AuthContext, @Body() dto: UpdateAiInstructionsDto) {
    return this.instructions.update(ctx, dto);
  }

  @Delete('instructions')
  @HttpCode(200)
  @Throttle(WRITE_THROTTLE)
  clear(@AuthUser() ctx: AuthContext, @Body() dto: DeleteAiInstructionsDto) {
    return this.instructions.clear(ctx, dto);
  }
}
