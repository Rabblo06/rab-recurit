import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { AiActionsModule } from './actions/ai-actions.module';
import { AiCoreModule } from './ai-core.module';
import { AiAdminController } from './controllers/ai-admin.controller';
import { AiAssistantController } from './controllers/ai-assistant.controller';
import { AiAvailableGuard } from './controllers/ai-available.guard';
import { AiConversationController } from './controllers/ai-conversation.controller';
import { AiModelPolicyController } from './controllers/ai-model-policy.controller';
import { AiSettingsController } from './controllers/ai-settings.controller';
import { AiStreamAccessGuard } from './controllers/ai-stream-access.guard';
import { AiAdminService } from './services/ai-admin.service';
import { AiAssistantService } from './services/ai-assistant.service';
import { AiConversationService } from './services/ai-conversation.service';
import { AiModelSettingsService } from './services/ai-model-settings.service';
import { AiSseService } from './services/ai-sse.service';
import { AiTurnQueueService } from './services/ai-turn-queue.service';
import { AiUsageSettingsController } from './controllers/ai-usage-settings.controller';
import { AiUsageSettingsService } from './services/ai-usage-settings.service';

/**
 * AI Phase 1 — the API side (docs/ai/PHASE1_PLAN.md): the conversation/SSE/admin controllers plus the services only the
 * API needs (the BullMQ producer, conversation lifecycle, SSE relay, admin controls, Settings → AI model choice). The shared core (tools, gateway,
 * quotas, step loop) comes from `AiCoreModule`, which the Worker imports too.
 */
@Module({
  imports: [AiCoreModule, AuthModule, AiActionsModule],
  controllers: [AiConversationController, AiAdminController, AiSettingsController, AiModelPolicyController, AiAssistantController, AiUsageSettingsController],
  providers: [AiTurnQueueService, AiConversationService, AiSseService, AiAdminService, AiModelSettingsService, AiAssistantService, AiAvailableGuard, AiStreamAccessGuard, AiUsageSettingsService],
  exports: [AiConversationService, AiTurnQueueService],
})
export class AiModule {}
