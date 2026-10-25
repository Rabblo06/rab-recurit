import { Module } from '@nestjs/common';

import { AuthModule } from '../../engine/core-modules/auth/auth.module';
import { AiCoreModule } from './ai-core.module';
import { AiAvailableGuard } from './controllers/ai-available.guard';
import { AiSkillsController } from './controllers/ai-skills.controller';
import { AiSettingsAuthority } from './services/ai-settings-authority.service';
import { AiSkillService } from './services/ai-skill.service';

/**
 * AI Phase 4 — skills (docs/ai/PHASE4_TWENTY_PLAN.md): the Settings → AI → Skills API, the composer's tag list and the
 * `AiSkillReader` (exported for the 4w runner wiring and the Phase 8 prompt preview). A module of its own (PL-13) so the
 * phase registers with ONE line in `AiModule.imports`. It provides no tool and touches no registry: the `load_skills`
 * handler (skills/load-skills.tool.ts) is registered by the 4w wiring, not here.
 */
@Module({
  imports: [AiCoreModule, AuthModule],
  controllers: [AiSkillsController],
  providers: [AiSettingsAuthority, AiSkillService, AiAvailableGuard],
  exports: [AiSkillService],
})
export class AiSkillsModule {}
