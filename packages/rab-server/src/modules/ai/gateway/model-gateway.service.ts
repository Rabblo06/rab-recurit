import type { LanguageModelV3 } from '@ai-sdk/provider';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { asSchema, ModelMessage, StepResult, stepCountIs, streamText, ToolSet } from 'ai';

import { resolveProviderApiKey } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { maxInputTokensFromBytes } from '../../../engine/core-modules/ai/models/cost';
import { AI_STEP_TIMEOUT_MS } from '../constants/ai.constants';
import { AiConfigService } from '../services/ai-config.service';
import { AiModelNotConfiguredError, AiStepRefusedError } from './ai-gateway-errors';
import { DeterministicMockModel } from './deterministic-mock-model';
import { scanOutgoingPayload } from './outgoing-payload-guard';
import { createProviderModel } from './provider-factory';

export { AiModelNotConfiguredError, AiStepRefusedError } from './ai-gateway-errors';

/**
 * Builds the language model for a READY catalogue entry. Injectable so integration tests can substitute a recorded or
 * scripted model (`MockLanguageModelV3` from `ai/test`) through Nest's `overrideProvider` — production code only ever
 * resolves the factory below. Tests never receive a real provider SDK object.
 */
export const AI_LANGUAGE_MODEL_FACTORY = Symbol('AI_LANGUAGE_MODEL_FACTORY');
export type AiLanguageModelFactory = (model: AiCatalogueModel, apiKey: string | null) => LanguageModelV3;

/** The default factory: the in-process mock, or the provider SDK through the one provider factory. */
export const defaultAiLanguageModelFactory: AiLanguageModelFactory = (model, apiKey) => {
  if (model.provider === 'mock' && model.devOnly) return new DeterministicMockModel(model.id);
  return createProviderModel({ model, apiKey });
};

/** Telemetry is OFF on every call (security 4.4): no span, no recorded prompt, no recorded output. */
export const AI_TELEMETRY_OFF = Object.freeze({ isEnabled: false, recordInputs: false, recordOutputs: false });

/** What the per-step hook receives before EVERY model call (budget reservation, kill switch / access re-check). */
export interface AiBeforeStepInfo {
  stepNumber: number;
  model: AiCatalogueModel;
  /** Upper bound of this call's input tokens (UTF-8 bytes of system + messages + tool schemas + framing). */
  maxInputTokens: number;
  maxOutputTokens: number;
}

export interface AiGatewayStreamInput {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  abortSignal: AbortSignal;
  /**
   * The turn's own real-provider clearance (AiAccessService: organisation `synthetic_data`, database not a test target).
   * The gateway refuses to build a real-provider model without it, whatever the platform readiness says.
   */
  realProviderPermitted: boolean;
  /** Runs before every step; throwing (AiStepRefusedError) stops the turn before that model call is made. */
  beforeStep?: (info: AiBeforeStepInfo) => Promise<void>;
  /**
   * Owner-approved Part A exception, control (a) — REQUIRED for a real provider (absent ⇒ refused): re-verifies at request
   * time that the turn's organisation is still synthetic. Throws AiStepRefusedError to refuse.
   */
  realRequestGuard?: () => Promise<void>;
  /** The user's input BEFORE masking: scanned too, so a detected item refuses the request instead of being masked away. */
  unmaskedUserTexts?: readonly string[];
  /** Told (categories only) when the gateway itself refuses a real-provider request, before the error is thrown. */
  onRefused?: (error: AiStepRefusedError) => void;
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
}

const TOOL_SCHEMA_ALLOWANCE_BYTES = 4_096;

async function toolSchemaBytes(tools: ToolSet): Promise<number> {
  let bytes = 0;
  for (const [name, t] of Object.entries(tools)) {
    bytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(String((t as { description?: string }).description ?? ''), 'utf8');
    try {
      const schema = await asSchema((t as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema).jsonSchema;
      bytes += Buffer.byteLength(JSON.stringify(schema), 'utf8');
    } catch {
      bytes += TOOL_SCHEMA_ALLOWANCE_BYTES;
    }
  }
  return bytes;
}

/**
 * The ONE place Crewflow calls a language model (Vercel AI SDK `ai@6.0.303`): `streamText` with
 *   - a model OBJECT for a ready catalogue entry (never a string id — that would route through the Vercel AI Gateway);
 *   - `maxOutputTokens` = the lower of the catalogue ceiling and AI_MAX_OUTPUT_TOKENS, per step;
 *   - `stopWhen: stepCountIs(AI_MAX_STEPS)` and a 60 s per-step timeout;
 *   - the caller's abort signal (turn timeout, cancel, shutdown, token ceiling, kill switch / access re-check);
 *   - a `prepareStep` hook that runs, BEFORE every model call: for a real provider the owner-approved Part A checks
 *     (synthetic re-verification + outgoing payload scan), then the caller's checks (budget reservation, access);
 *   - telemetry OFF (`experimental_telemetry: { isEnabled: false }`), system messages only from `system`;
 *   - `onError` replaced with a no-op: the SDK's default prints the raw error, which for a provider failure can include
 *     the request (i.e. the prompt). Failures reach the caller through the stream and are mapped to fixed error codes.
 */
@Injectable()
export class ModelGatewayService {
  constructor(
    private readonly config: AiConfigService,
    @Optional() @Inject(AI_LANGUAGE_MODEL_FACTORY) private readonly factory?: AiLanguageModelFactory,
  ) {}

  /** The model object for the ready catalogue entry, or AiModelNotConfiguredError (fail closed). */
  model(opts: { realProviderPermitted: boolean }): { model: LanguageModelV3; entry: AiCatalogueModel } {
    const readiness = this.config.readiness();
    const entry = readiness.model;
    if (!readiness.ready || !entry) throw new AiModelNotConfiguredError();
    const real = isRealProvider(entry);
    if (real && !opts.realProviderPermitted) throw new AiModelNotConfiguredError();
    const apiKey = real ? resolveProviderApiKey(this.config.envFacts(), entry).key : null;
    if (real && !apiKey) throw new AiModelNotConfiguredError();
    const model = (this.factory ?? defaultAiLanguageModelFactory)(entry, apiKey);
    if (!model || typeof model !== 'object' || model.specificationVersion !== 'v3') throw new AiModelNotConfiguredError();
    return { model, entry };
  }

  stream(input: AiGatewayStreamInput) {
    const { model, entry } = this.model({ realProviderPermitted: input.realProviderPermitted });
    const real = isRealProvider(entry);
    // The key itself is a canary for the payload scan (it must never travel in a prompt).
    const canary = real ? resolveProviderApiKey(this.config.envFacts(), entry).key : null;
    const refuse = (error: AiStepRefusedError): never => {
      input.onRefused?.(error);
      throw error;
    };
    const maxOutputTokens = this.config.maxOutputTokens;
    const systemBytes = Buffer.byteLength(input.system, 'utf8');
    let toolBytes: number | null = null;
    return streamText({
      model,
      system: input.system,
      messages: input.messages,
      allowSystemInMessages: false,
      tools: input.tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(this.config.maxSteps),
      maxOutputTokens,
      maxRetries: 1,
      abortSignal: input.abortSignal,
      timeout: { stepMs: AI_STEP_TIMEOUT_MS },
      experimental_telemetry: AI_TELEMETRY_OFF,
      prepareStep: async ({ stepNumber, messages }) => {
        if (input.abortSignal.aborted) throw new AiStepRefusedError('access_revoked');
        if (real) {
          // Owner-approved Part A exception — immediately before EVERY real-provider request (each step), in this order:
          //   (a) the organisation is re-verified as synthetic at request time (never a cached marker);
          //   (b) the outgoing payload exactly as it will be sent (system prompt, history, user message, tool results) plus
          //       the unmasked user input is scanned; any sensitive category refuses the request.
          if (!input.realRequestGuard) refuse(new AiStepRefusedError('content_refused', ['no_request_guard']));
          await input.realRequestGuard!();
          const categories = scanOutgoingPayload({ system: input.system, messages, extraTexts: input.unmaskedUserTexts }, { secrets: [canary] });
          if (categories.length > 0) refuse(new AiStepRefusedError('content_refused', categories));
        }
        toolBytes ??= await toolSchemaBytes(input.tools);
        const bytes = systemBytes + Buffer.byteLength(JSON.stringify(messages), 'utf8') + toolBytes;
        await input.beforeStep?.({ stepNumber, model: entry, maxInputTokens: maxInputTokensFromBytes(bytes), maxOutputTokens });
        return {};
      },
      onStepFinish: input.onStepFinish,
      onError: () => undefined,
    });
  }
}
