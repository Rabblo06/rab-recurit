import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AiCapabilitiesService } from '../services/ai-capabilities.service';
import { AiAvailableGuard } from './ai-available.guard';

/**
 * `GET /rest/v1/ai/capabilities` (route table AI_API_ROUTES, CD-8; Batch 3 S4). Web console only. Transport only: layer 1
 * is `AiAvailableGuard` (ai.use and every AI gate → the uniform 404); `AiCapabilitiesService` re-checks it (layer 2).
 */
@Controller('rest/v1/ai')
@ManagerApplication()
export class AiCapabilitiesController {
  constructor(private readonly capabilities: AiCapabilitiesService) {}

  @Get('capabilities')
  @UseGuards(JwtAuthGuard, AiAvailableGuard)
  view(@AuthUser() ctx: AuthContext) {
    return this.capabilities.view(ctx);
  }
}
