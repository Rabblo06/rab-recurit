import type { LanguageModelV3 } from '@ai-sdk/provider';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModelMessage, StepResult, stepCountIs, streamText, ToolSet } from 'ai';

import { AI_MODEL_ALLOWLIST } from '../../../engine/core-modules/environment/env.validation';
import { AiConfigService } from '../services/ai-config.service';
import { DeterministicMockModel } from './deterministic-mock-model';

/**
 * Builds the language model for an allowlisted (provider, model). Injectable so integration tests can substitute a
 * recorded/scripted model (`MockLanguageModelV3` from `ai/test`) through Nest's `overrideProvider` — production code
 * only ever resolves the factory below.
 */
export const AI_LANGUAGE_MODEL_FACTORY = Symbol('AI_LANGUAGE_MODEL_FACTORY');
export type AiLanguageModelFactory = (provider: string, model: string) => LanguageModelV3;

export class AiModelNotConfiguredError extends Error {
  constructor() {
    super('No allowlisted AI provider/model is configured');
    this.name = 'AiModelNotConfiguredError';
  }
}

/**
 * The default factory. Phase 1 knows exactly one provider: the deterministic `mock` model. Adding a real provider is a
 * reviewed code change (docs/ai/CREWFLOW_AI_IMPLEMENTATION_REPORT.md §"Configuring a real provider"): its SDK package,
 * one branch here that reads `AI_PROVIDER_API_KEY` (server/Worker only) and its models in `AI_MODEL_ALLOWLIST`. There is
 * no user-configurable endpoint, base URL or model id: anything not on the allowlist throws.
 */
export const defaultAiLanguageModelFactory: AiLanguageModelFactory = (provider, model) => {
  if (provider === 'mock' && AI_MODEL_ALLOWLIST.mock.includes(model)) return new DeterministicMockModel(model);
  throw new AiModelNotConfiguredError();
};

export interface AiGatewayStreamInput {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  abortSignal: AbortSignal;
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
}

/**
 * The ONE place Crewflow calls a language model (Vercel AI SDK `ai@6.0.303`, verified against the installed types):
 * `streamText` with the allowlisted model, `stopWhen: stepCountIs(AI_MAX_STEPS)`, `maxOutputTokens` per step, the
 * caller's abort signal (timeout / cancel / shutdown / token ceiling), and telemetry OFF (no prompt or output recording).
 * `onError` is replaced with a no-op: the SDK's default prints the raw error, which for a provider failure can include
 * the request (i.e. the prompt). Failures surface to the caller through the stream and are mapped to fixed error codes.
 */
@Injectable()
export class ModelGatewayService {
  constructor(
    private readonly config: AiConfigService,
    @Optional() @Inject(AI_LANGUAGE_MODEL_FACTORY) private readonly factory?: AiLanguageModelFactory,
  ) {}

  /** The allowlisted model, or AiModelNotConfiguredError (fail closed). */
  model(): LanguageModelV3 {
    const provider = this.config.provider;
    const model = this.config.model;
    if (!provider || !model || !this.config.modelAllowlisted) throw new AiModelNotConfiguredError();
    return (this.factory ?? defaultAiLanguageModelFactory)(provider, model);
  }

  stream(input: AiGatewayStreamInput) {
    return streamText({
      model: this.model(),
      system: input.system,
      messages: input.messages,
      tools: input.tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(this.config.maxSteps),
      maxOutputTokens: this.config.maxOutputTokens,
      maxRetries: 1,
      abortSignal: input.abortSignal,
      experimental_telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
      onStepFinish: input.onStepFinish,
      onError: () => undefined,
    });
  }
}
