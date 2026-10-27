import { Body, Controller, Delete, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AiSettingsGuard } from './ai-settings.guard';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { UpdateAiAssistantDto } from '../dto/ai-assistant.dto';
import { AiAssistantService } from '../services/ai-assistant.service';

/**
 * Settings → AI assistant name and avatar (C1 / CD-3). Web console only; `ai.settings` declared here (layer 1); the
 * service re-checks it and requires the CEO and both AI switches (layer 2); RLS adds the organisation and CEO-writer
 * predicates. Transport only.
 */
@Controller('rest/v1/ai/settings')
@ManagerApplication()
@UseGuards(JwtAuthGuard, AiSettingsGuard)
export class AiAssistantController {
  constructor(private readonly assistant: AiAssistantService) {}

  @Get('assistant')
  get(@AuthUser() ctx: AuthContext) {
    return this.assistant.get(ctx);
  }

  @Put('assistant')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  update(@AuthUser() ctx: AuthContext, @Body() dto: UpdateAiAssistantDto) {
    return this.assistant.update(ctx, dto);
  }

  @Delete('assistant')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  reset(@AuthUser() ctx: AuthContext) {
    return this.assistant.reset(ctx);
  }
}
