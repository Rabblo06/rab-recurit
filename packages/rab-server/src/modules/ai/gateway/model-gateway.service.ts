import type { LanguageModelV3 } from '@ai-sdk/provider';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { asSchema, JSONValue, ModelMessage, StepResult, stepCountIs, streamText, ToolSet } from 'ai';

import type { AiModelEffort } from '@rab/shared';

import { providerApiKey } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel, isRealProvider } from '../../../engine/core-modules/ai/models/catalog';
import { maxInputTokensFromBytes } from '../../../engine/core-modules/ai/models/cost';
import { verifiedEfforts } from '../../../engine/core-modules/ai/models/model-levels';
import { AI_STEP_TIMEOUT_MS } from '../constants/ai.constants';
import { AiConfigService } from '../services/ai-config.service';
import { AiModelNotConfiguredError, AiStepRefusedError } from './ai-gateway-errors';
import { applyContextBudget, contextBudgetLimit } from './context-budget';
import { scanOutgoingPayload } from './outgoing-payload-guard';
import { createProviderModel, providerCallOptions } from './provider-factory';

export { AiModelNotConfiguredError, AiStepRefusedError } from './ai-gateway-errors';

/**
 * Builds the language model for a USABLE catalogue entry. Injectable so test modules can substitute a recorded, scripted
 * or deterministic in-process model through Nest's `overrideProvider` (src/__tests__/support/ai/) — production code only
 * ever resolves the default factory below, which builds a real provider SDK object and nothing else. There is no mock
 * in the running app (PHASE1_TWENTY_PLAN §5, C6): an in-process `test` model with no test factory is refused.
 */
export const AI_LANGUAGE_MODEL_FACTORY = Symbol('AI_LANGUAGE_MODEL_FACTORY');
export type AiLanguageModelFactory = (model: AiCatalogueModel, apiKey: string | null) => LanguageModelV3;

/** The default factory: the provider SDK through the one provider factory (explicit key, fixed endpoint). */
export const defaultAiLanguageModelFactory: AiLanguageModelFactory = (model, apiKey) => createProviderModel({ model, apiKey });

/** Telemetry is OFF on every call (security 4.4): no span, no recorded prompt, no recorded output. */
export const AI_TELEMETRY_OFF = Object.freeze({ isEnabled: false, recordInputs: false, recordOutputs: false });

/** What the per-step hook receives before EVERY model call (budget reservation, kill switch / access re-check). */
export interface AiBeforeStepInfo {
  stepNumber: number;
  model: AiCatalogueModel;
  /** Upper bound of this call's input tokens (UTF-8 bytes of system + messages + tool schemas + framing). */
  maxInputTokens: number;
  maxOutputTokens: number;
  /** 7b (C1 CD-6): the per-step context limit this request was held under (`contextBudgetLimit`), for the usage ledger. */
  contextLimitTokens: number;
}

/**
 * 7b (P7 §2.4, D7-4): whether the gateway may ask for the provider's automatic prompt caching on this call. Only a model
 * whose catalogue fact is `anthropic-auto`, and only:
 *   - a REAL provider in NODE_ENV=development on the EX-1 path (`realProviderPermitted`: the organisation is verifiably
 *     synthetic and the database is not a test target) — never production, never real customer data;
 *   - or an in-process TEST model in NODE_ENV=test (so the request shape is provable without a live call).
 * Production stays off until the release checklist records that the provider's zero-retention terms cover caching.
 */
export function promptCachePermitted(entry: Pick<AiCatalogueModel, 'promptCache' | 'provider'>, facts: { nodeEnv: string; realProviderPermitted: boolean }): boolean {
  if (entry.promptCache !== 'anthropic-auto' || facts.nodeEnv === 'production') return false;
  if (isRealProvider(entry)) return facts.nodeEnv === 'development' && facts.realProviderPermitted === true;
  return facts.nodeEnv === 'test';
}

/** The request-level cache marker: the provider's default lifetime only (no lifetime key, ever — T7-S1). */
const ANTHROPIC_AUTO_CACHE = Object.freeze({ type: 'ephemeral' as const });

export interface AiGatewayStreamInput {
  /** The catalogue entry this turn was resolved to (Worker start). The gateway re-checks it is usable before EVERY step. */
  model: AiCatalogueModel;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  abortSignal: AbortSignal;
  /**
   * The turn's own real-provider clearance (AiAccessService: organisation `synthetic_data`, database not a test target).
   * The gateway refuses to build a real-provider model without it, whatever the platform availability says.
   */
  realProviderPermitted: boolean;
  /** Runs before every step; throwing (AiStepRefusedError) stops the turn before that model call is made. */
  beforeStep?: (info: AiBeforeStepInfo) => Promise<void>;
  /**
   * Owner-approved exception EX-1, control 6 — REQUIRED for a real provider (absent ⇒ refused): re-verifies at request
   * time that the turn's organisation is still synthetic. Throws AiStepRefusedError to refuse.
   */
  realRequestGuard?: () => Promise<void>;
  /** The user's input BEFORE masking: scanned too, so a detected item refuses the request instead of being masked away. */
  unmaskedUserTexts?: readonly string[];
  /** Told when the gateway itself refuses a step (content categories, or the model became unavailable), before it throws. */
  onRefused?: (error: AiStepRefusedError) => void;
  onStepFinish?: (step: StepResult<ToolSet>) => void | Promise<void>;
  /**
   * C1 / CD-1: the turn's level effort. Must be VERIFIED for this model (`verifiedEfforts`), else the call is refused
   * before any model object is built (fail closed). Absent = the catalogue's fixed `providerOptions` (Phase 1, D12).
   */
  effort?: AiModelEffort;
  /**
   * GW-1 per-call overrides. Each can only LOWER the platform bound, never raise it: `maxOutputTokens` ≤ min(catalogue,
   * AI_MAX_OUTPUT_TOKENS); `maxSteps` ≤ AI_MAX_STEPS; `stepTimeoutMs` ≤ the 60 s step timeout. Non-finite or < 1 ⇒ refused.
   */
  maxOutputTokens?: number;
  maxSteps?: number;
  stepTimeoutMs?: number;
  /** 5b: evaluated after every step; true ends the loop there (a `propose_action` paused the turn). Can only stop early. */
  shouldStop?: () => boolean;
}

/** GW-1: an override may only lower `ceiling`; anything that is not a finite number ≥ 1 is refused (never ignored). */
function lowerBound(ceiling: number, override: number | undefined): number {
  if (override === undefined) return ceiling;
  if (typeof override !== 'number' || !Number.isFinite(override) || override < 1) throw new AiModelNotConfiguredError();
  return Math.min(ceiling, Math.floor(override));
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
 *   - a model OBJECT for the turn's resolved, usable catalogue entry (never a string id — that would route through the
 *     Vercel AI Gateway); the SDK receives only the catalogue's `providerModelId` and its FIXED `providerOptions`
 *     (e.g. Haiku `anthropic.effort: 'low'`, D12) — nothing from a user, a pin or a request;
 *   - `maxOutputTokens` = the lower of the catalogue ceiling and AI_MAX_OUTPUT_TOKENS, per step;
 *   - `stopWhen: stepCountIs(AI_MAX_STEPS)` and a 60 s per-step timeout;
 *   - the caller's abort signal (turn timeout, cancel, shutdown, token ceiling, kill switch / access re-check);
 *   - a `prepareStep` hook that runs, BEFORE every model call: the model must still be usable (approved, in the build,
 *     keyed, not disabled, environment permits — a model that became unavailable mid-turn is never called again); for a
 *     real provider the EX-1 checks (synthetic re-verification + outgoing payload scan); then the caller's checks
 *     (budget reservation, access);
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

  /** The model object for a usable catalogue entry, or AiModelNotConfiguredError (fail closed). */
  model(entry: AiCatalogueModel, opts: { realProviderPermitted: boolean }): LanguageModelV3 {
    if (!entry || !this.config.entry(entry.id) || !this.config.isModelUsable(entry)) throw new AiModelNotConfiguredError();
    const real = isRealProvider(entry);
    if (real && !opts.realProviderPermitted) throw new AiModelNotConfiguredError();
    const apiKey = real ? providerApiKey(this.config.envFacts(), entry) : null;
    if (real && !apiKey) throw new AiModelNotConfiguredError();
    const model = (this.factory ?? defaultAiLanguageModelFactory)(entry, apiKey);
    if (!model || typeof model !== 'object' || model.specificationVersion !== 'v3') throw new AiModelNotConfiguredError();
    return model;
  }

  stream(input: AiGatewayStreamInput) {
    // Always the catalogue's own frozen entry (a caller-built object with the same id never reaches the SDK).
    const entry = this.config.entry(input.model?.id);
    if (!entry) throw new AiModelNotConfiguredError();
    // GW-1 + CD-1, before any model object is built: overrides only lower the bounds; the effort must be verified.
    const maxOutputTokens = lowerBound(this.config.maxOutputTokensFor(entry), input.maxOutputTokens);
    const maxSteps = lowerBound(this.config.maxSteps, input.maxSteps);
    const stepMs = lowerBound(AI_STEP_TIMEOUT_MS, input.stepTimeoutMs);
    if (input.effort !== undefined && !verifiedEfforts(entry).includes(input.effort)) throw new AiModelNotConfiguredError();
    const base = providerCallOptions(entry, input.effort);
    // 7b: automatic prompt caching ONLY where `promptCachePermitted` says so (development + synthetic EX-1 path, or a test
    // model under NODE_ENV=test); everything else gets exactly the catalogue's fixed options.
    const cache = promptCachePermitted(entry, { nodeEnv: this.config.envFacts().NODE_ENV, realProviderPermitted: input.realProviderPermitted });
    const providerOptions: Record<string, Record<string, JSONValue>> | undefined = cache
      ? { ...(base ?? {}), anthropic: { ...(base?.anthropic ?? {}), cacheControl: { ...ANTHROPIC_AUTO_CACHE } } }
      : base;
    const model = this.model(entry, { realProviderPermitted: input.realProviderPermitted });
    const real = isRealProvider(entry);
    // The key itself is a canary for the payload scan (it must never travel in a prompt).
    const canary = real ? providerApiKey(this.config.envFacts(), entry) : null;
    const refuse = (error: AiStepRefusedError): never => {
      input.onRefused?.(error);
      throw error;
    };
    const systemBytes = Buffer.byteLength(input.system, 'utf8');
    let toolBytes: number | null = null;
    // 7b: the per-step context limit under the platform's per-turn ceiling (INTEGRATION-7B §2); the turn's own reservation
    // is enforced separately after every step (token_limit).
    const turnCeilingTokens = this.config.turnTokenReservation;
    const contextLimitTokens = contextBudgetLimit({ contextWindowTokens: entry.contextWindowTokens, turnCeilingTokens, maxOutputTokens });
    // The previous step's UNTRIMMED messages (bytes) and whether what was sent then equalled them: the "previous input
    // tokens + appended bytes" estimate is an upper bound only when the previous request was not trimmed.
    let previousBytes: number | null = null;
    let previousTrimmed = false;
    return streamText({
      model,
      system: input.system,
      messages: input.messages,
      allowSystemInMessages: false,
      tools: input.tools,
      toolChoice: 'auto',
      stopWhen: [stepCountIs(maxSteps), () => input.shouldStop?.() === true],
      maxOutputTokens,
      maxRetries: 1,
      abortSignal: input.abortSignal,
      timeout: { stepMs },
      experimental_telemetry: AI_TELEMETRY_OFF,
      ...(providerOptions ? { providerOptions } : {}),
      prepareStep: async ({ stepNumber, messages, steps }) => {
        if (input.abortSignal.aborted) throw new AiStepRefusedError('access_revoked');
        // The turn's model must STILL be usable (key removed, disabled, approval revoked ⇒ never called again).
        if (!this.config.isModelUsable(entry)) refuse(new AiStepRefusedError('not_ready'));
        // 7b, in THIS order: (1) the context budget, (2) the EX-1 checks + payload scan on exactly what it returns, (3) the
        // caller's reservation sized on it. Nothing here ever summarises; over the limit with nothing left ⇒ context_full.
        toolBytes ??= await toolSchemaBytes(input.tools);
        const messagesBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
        const lastInput = steps.length > 0 ? steps[steps.length - 1]!.usage.inputTokens : undefined;
        const usable = !previousTrimmed && previousBytes !== null && typeof lastInput === 'number' && Number.isFinite(lastInput);
        const budget = applyContextBudget(
          {
            messages,
            previousStepInputTokens: usable ? lastInput! : null,
            appendedBytesSincePrevious: usable ? Math.max(0, messagesBytes - previousBytes!) : 0,
            contextWindowTokens: entry.contextWindowTokens,
            turnCeilingTokens,
            maxOutputTokens,
          },
          { prefixBytes: systemBytes + toolBytes },
        );
        if (budget.action === 'context_full') refuse(new AiStepRefusedError('context_full'));
        const sent = (budget as Exclude<typeof budget, { action: 'context_full' }>).messages as ModelMessage[];
        previousBytes = messagesBytes;
        previousTrimmed = budget.action === 'trimmed';
        if (real) {
          // Owner-approved exception EX-1 — immediately before EVERY real-provider request (each step), in this order:
          //   (a) the organisation is re-verified as synthetic at request time (never a cached marker);
          //   (b) the outgoing payload exactly as it will be sent (system prompt, history, user message, tool results) plus
          //       the unmasked user input is scanned; any sensitive category refuses the request.
          if (!input.realRequestGuard) refuse(new AiStepRefusedError('content_refused', ['no_request_guard']));
          await input.realRequestGuard!();
          const categories = scanOutgoingPayload({ system: input.system, messages: sent, extraTexts: input.unmaskedUserTexts }, { secrets: [canary] });
          if (categories.length > 0) refuse(new AiStepRefusedError('content_refused', categories));
        }
        const bytes = systemBytes + Buffer.byteLength(JSON.stringify(sent), 'utf8') + toolBytes;
        await input.beforeStep?.({ stepNumber, model: entry, maxInputTokens: maxInputTokensFromBytes(bytes), maxOutputTokens, contextLimitTokens });
        return { messages: sent };
      },
      onStepFinish: input.onStepFinish,
      onError: () => undefined,
    });
  }
}
