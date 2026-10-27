import { Module } from '@nestjs/common';

import { AuthModule } from '../../../engine/core-modules/auth/auth.module';
import { AiCoreModule } from '../ai-core.module';
import { AiProposalController } from '../controllers/ai-proposal.controller';
import { AiDecidableGuard } from './ai-decidable.guard';

/**
 * AI Phase 5a — write proposals, API side: the write-tool definitions, the proposal service, the executor (the only
 * `apply()` caller) and the approval controller. Imported by `AiModule` (API only). In 5b the turn runner (Worker, in
 * `AiCoreModule`) calls `AiProposalService.createFromTool`; then these providers move into `AiCoreModule` (one module,
 * no import cycle) — see REQUEST.md "5b design notes".
 */
@Module({
  // 5b: the proposal providers moved into AiCoreModule (the Worker's propose_action needs them); this module keeps the
  // approval HTTP surface (controller + its layer-1 guard).
  imports: [AiCoreModule, AuthModule],
  controllers: [AiProposalController],
  providers: [AiDecidableGuard],
})
export class AiActionsModule {}
