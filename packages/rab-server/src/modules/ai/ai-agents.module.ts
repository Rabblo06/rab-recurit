import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { IdentityModule } from '../identity/identity.module';
import { AiCoreModule } from './ai-core.module';
import { AiAgentController } from './controllers/ai-agent.controller';
import { AiAgentsSwitchGuard } from './controllers/ai-agents-switch.guard';
import { AiAgentAuthority } from './services/ai-agent-authority.service';
import { AiAgentPrincipalService } from './services/ai-agent-principal.service';
import { AiAgentRoleService } from './services/ai-agent-role.service';
import { AiAgentTriggerService } from './services/ai-agent-trigger.service';
import { AiAgentService } from './services/ai-agent.service';

/**
 * AI Phase 6a — agent DEFINITIONS AND STORAGE (docs/ai/PHASE6_TWENTY_PLAN.md; owner decision 2026-10-25: EX-3 deferred,
 * execution OFF). A module of its own (PL-13) so the phase registers with ONE line in `AiModule.imports`. API graph only:
 * it is never imported by the Worker, registers no queue, processor, scan job or scheduler, and offers no tool.
 *
 * `AiAgentPrincipalService` is provided (so 6b's wiring is proven by the DI graph) but has no consumer and refuses before
 * any read while `AI_AGENT_EXECUTION_APPROVED` is false (static test `ai-agents-no-execution.spec.ts`).
 */
@Module({
  imports: [AiCoreModule, AuthModule, IdentityModule],
  controllers: [AiAgentController],
  providers: [AiAgentAuthority, AiAgentService, AiAgentTriggerService, AiAgentRoleService, AiAgentPrincipalService, AiAgentsSwitchGuard],
  exports: [AiAgentAuthority],
})
export class AiAgentsModule {}
