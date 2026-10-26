import { Module } from '@nestjs/common';

import { AiCoreModule } from './ai-core.module';
import { AI_LANGUAGE_MODEL_FACTORY, defaultAiLanguageModelFactory, ModelGatewayService } from './gateway/model-gateway.service';
import { AiTitleService } from './services/ai-title.service';
import { AiTurnRunnerService } from './services/ai-turn-runner.service';

/**
 * The ONLY module that can call a language model (docs/ai/PHASE2_TWENTY_PLAN.md P2-C11): the model gateway (the one
 * `streamText`), the provider model factory, the turn step loop and the thread-title service. Imported ONLY by the Worker
 * (`rab-worker/src/worker.module.ts`); the API graph (`AppModule` → `AiModule` → `AiCoreModule`) has none of them, so no
 * request can reach a model except through the `rab-ai` queue, the org slot and the turn lease. Enforced by
 * `__tests__/static/ai-worker-only-model.spec.ts`. Test modules may import it next to `AppModule` to run the Worker step
 * loop in-process (the AI integration kit).
 */
@Module({
  imports: [AiCoreModule],
  providers: [
    // The provider model factory (overridable in tests with a recorded/scripted model; production resolves this one).
    { provide: AI_LANGUAGE_MODEL_FACTORY, useValue: defaultAiLanguageModelFactory },
    ModelGatewayService,
    AiTurnRunnerService,
    AiTitleService,
  ],
  exports: [AiCoreModule, ModelGatewayService, AiTurnRunnerService, AiTitleService],
})
export class AiWorkerCoreModule {}
