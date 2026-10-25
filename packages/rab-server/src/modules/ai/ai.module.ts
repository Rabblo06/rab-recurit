import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { AiCoreModule } from './ai-core.module';
import { AiAdminController } from './controllers/ai-admin.controller';
import { AiAvailableGuard } from './controllers/ai-available.guard';
import { AiConversationController } from './controllers/ai-conversation.controller';
import { AiStreamAccessGuard } from './controllers/ai-stream-access.guard';
import { AiAdminService } from './services/ai-admin.service';
import { AiConversationService } from './services/ai-conversation.service';
import { AiSseService } from './services/ai-sse.service';
import { AiTurnQueueService } from './services/ai-turn-queue.service';

/**
 * AI Phase 1 — the API side (docs/ai/PHASE1_PLAN.md): the conversation/SSE/admin controllers plus the services only the
 * API needs (the BullMQ producer, conversation lifecycle, SSE relay, admin controls). The shared core (tools, gateway,
 * quotas, step loop) comes from `AiCoreModule`, which the Worker imports too.
 */
@Module({
  imports: [AiCoreModule, AuthModule],
  controllers: [AiConversationController, AiAdminController],
  providers: [AiTurnQueueService, AiConversationService, AiSseService, AiAdminService, AiAvailableGuard, AiStreamAccessGuard],
  exports: [AiConversationService, AiTurnQueueService],
})
export class AiModule {}
