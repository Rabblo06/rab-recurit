import { AiUsageView } from '@rab/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { AiSettingsGuard } from './ai-settings.guard';
import { JwtAuthGuard } from '../../../engine/core-modules/auth/guards/jwt-auth.guard';
import { ManagerApplication } from '../../../engine/core-modules/auth/guards/manager-application.decorator';
import { AuthContext } from '../../../engine/core-modules/tenant/auth-context.interface';
import { AuthUser } from '../../../engine/decorators/auth-user.decorator';
import { AiUsageQueryDto } from '../dto/ai-usage-query.dto';
import { AiUsageSettingsService } from '../services/ai-usage-settings.service';

/**
 * Settings → AI → Usage (Phase 7; per-phase controller under the shared prefix, resolution X-11). Web console only;
 * `ai.settings` declared here (layer 1); the service re-checks it, requires the organisation's CEO and both AI switches,
 * refuses Admin Inspect and audits the read (layer 2); RLS adds the organisation and own-or-CEO predicates (layers 4–5).
 * Transport only. The Settings tab stays hidden (`AiSettingsOverview.features.usage`) until 7b.
 */
@Controller('rest/v1/ai/settings')
@ManagerApplication()
@UseGuards(JwtAuthGuard, AiSettingsGuard)
export class AiUsageSettingsController {
  constructor(private readonly usage: AiUsageSettingsService) {}

  @Get('usage')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  view(@AuthUser() ctx: AuthContext, @Query() query: AiUsageQueryDto): Promise<AiUsageView> {
    return this.usage.view(ctx, query.period);
  }
}
