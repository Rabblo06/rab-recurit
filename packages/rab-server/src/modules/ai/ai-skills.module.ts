import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { AiCoreModule } from './ai-core.module';
import { AiAvailableGuard } from './controllers/ai-available.guard';
import { AiInstructionsController } from './controllers/ai-instructions.controller';
import { AiSkillsController } from './controllers/ai-skills.controller';
import { AiSkillSettingsGuard } from './controllers/ai-skill-settings.guard';
import { AiInstructionsService } from './services/ai-instructions.service';

/**
 * AI Phase 4 — skills (docs/ai/PHASE4_TWENTY_PLAN.md): the Settings → AI → Skills API, the composer's tag list and the
 * workspace instructions API. A module of its own (PL-13) so the phase registers with ONE line in `AiModule.imports`.
 * 4w: `AiSkillService` (the `AiSkillReader`), `AiSettingsAuthority` and `LoadSkillsTool` moved into `AiCoreModule` so the
 * Worker's turn runner and the registry's `load_skills` meta tool get them; this module keeps the HTTP surface only.
 */
@Module({
  imports: [AiCoreModule, AuthModule],
  // C1 / CD-4 (p4 merge): the workspace instructions API shares the settings authority and the content rules.
  controllers: [AiSkillsController, AiInstructionsController],
  providers: [AiInstructionsService, AiAvailableGuard, AiSkillSettingsGuard],
})
export class AiSkillsModule {}
