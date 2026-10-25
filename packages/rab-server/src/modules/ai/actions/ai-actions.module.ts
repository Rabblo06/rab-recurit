import { Module } from '@nestjs/common';

import { AuthModule } from '../../../engine/core-modules/auth/auth.module';
import { SchedulingModule } from '../../scheduling/scheduling.module';
import { StaffModule } from '../../staff/staff.module';
import { AiCoreModule } from '../ai-core.module';
import { AiProposalController } from '../controllers/ai-proposal.controller';
import { AiProposalAccessService } from './ai-proposal-access.service';
import { AiProposalExecutorService } from './ai-proposal-executor.service';
import { AiProposalService } from './ai-proposal.service';
import { AiWriteToolsService } from './ai-write-tools';

/**
 * AI Phase 5a — write proposals, API side: the write-tool definitions, the proposal service, the executor (the only
 * `apply()` caller) and the approval controller. Imported by `AiModule` (API only). In 5b the turn runner (Worker, in
 * `AiCoreModule`) calls `AiProposalService.createFromTool`; then these providers move into `AiCoreModule` (one module,
 * no import cycle) — see REQUEST.md "5b design notes".
 */
@Module({
  imports: [AiCoreModule, AuthModule, SchedulingModule, StaffModule],
  controllers: [AiProposalController],
  providers: [AiWriteToolsService, AiProposalAccessService, AiProposalExecutorService, AiProposalService],
  exports: [AiProposalService],
})
export class AiActionsModule {}
