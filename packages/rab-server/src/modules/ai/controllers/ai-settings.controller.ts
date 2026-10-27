import { Body, Controller, Delete, Get, HttpCode, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AiSettingsGuard } from './ai-settings.guard';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { PinAiModelDto, UnpinAiModelDto } from '../dto/ai-model-setting.dto';
import { AiModelSettingsService } from '../services/ai-model-settings.service';
import { AiPromptPreviewService } from '../services/ai-prompt-preview.service';
import { AiSettingsOverviewService } from '../services/ai-settings-overview.service';

/**
 * Settings → AI (docs/ai/PHASE1_TWENTY_PLAN.md §7; Phase 8 read endpoints, docs/ai/PHASE8_TWENTY_PLAN.md §2.1):
 * `GET settings` (feature flags + limits), `GET settings/tools`, `GET settings/prompt-preview`, and the Phase 1 model
 * choice. Web console only; `ai.settings` declared here (layer 1);
 * the service re-checks it, requires the organisation's CEO, both AI switches and — for a write — a recent step-up and a
 * reason (layer 2); RLS adds the organisation and CEO-writer predicates (layers 4–5). Transport only. Deliberately NOT
 * behind AiAvailableGuard: choosing a model is how an organisation leaves the "not configured" state.
 */
@Controller('rest/v1/ai/settings')
@ManagerApplication()
@UseGuards(JwtAuthGuard, AiSettingsGuard)
export class AiSettingsController {
  constructor(
    private readonly settings: AiModelSettingsService,
    private readonly overview: AiSettingsOverviewService,
    private readonly promptPreview: AiPromptPreviewService,
  ) {}

  /** Which Settings → AI tabs have an API on this server, and the limits shown beside them (CEO only). */
  @Get()
  features(@AuthUser() ctx: AuthContext) {
    return this.overview.overview(ctx);
  }

  /** The assistant's read tools: permission each needs and whether the caller holds it. Read-only. */
  @Get('tools')
  tools(@AuthUser() ctx: AuthContext) {
    return this.overview.tools(ctx);
  }

  /** The fixed prompt prefix for this caller. Read-only, audited, secret-scanned; no model is called (rule 10.5). */
  @Get('prompt-preview')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  preview(@AuthUser() ctx: AuthContext) {
    return this.promptPreview.preview(ctx);
  }

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
