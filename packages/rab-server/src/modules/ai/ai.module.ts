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
import { AiUsageSettingsController } from './controllers/ai-usage-settings.controller';
import { AiUsageSettingsService } from './services/ai-usage-settings.service';
// AI Phase 4 (skills): the Settings → AI → Skills API + the composer tag list, in a module of its own (PL-13).
import { AiSkillsModule } from './ai-skills.module';

/**
 * AI Phase 1 — the API side (docs/ai/PHASE1_PLAN.md): the conversation/SSE/admin controllers plus the services only the
 * API needs (the BullMQ producer, conversation lifecycle, SSE relay, admin controls, Settings → AI model choice). The shared core (tools, gateway,
 * quotas, step loop) comes from `AiCoreModule`, which the Worker imports too.
 *
 * Phase 2 (P2-C11): the queue producer moved into `AiCoreModule`, and NOTHING here can call a model — the gateway, the
 * model factory, the step loop and the title service are in `AiWorkerCoreModule`, which only the Worker imports.
 */
@Module({
  imports: [AiCoreModule, AuthModule, AiActionsModule, AiSkillsModule],
  controllers: [AiConversationController, AiAdminController, AiSettingsController, AiModelPolicyController, AiAssistantController, AiUsageSettingsController],
  providers: [AiConversationService, AiSseService, AiAdminService, AiModelSettingsService, AiAssistantService, AiAvailableGuard, AiStreamAccessGuard, AiUsageSettingsService],
  exports: [AiConversationService, AiCoreModule],
})
export class AiModule {}
