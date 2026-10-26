import { AI_SKILL_LIMITS, AiModelLevel, AiProviderKeyStatus } from '@rab/shared';
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';

import { recordedRuntimeDatabase } from '../../../database/typeorm/core/runtime-database-guard';
import {
  AiAvailabilityContext,
  AiEnvFacts,
  AiModelPins,
  AiModelResolution,
  AiModelStateCode,
  AiRuntimeDatabaseFacts,
  aiConfigurationWarnings,
  aiPlatformReadiness,
  idList,
  isUsableState,
  LegacyAiEnvFacts,
  modelState,
  NO_LEGACY_AI_ENV,
  resolveModel,
  setupNeeded,
} from '../../../engine/core-modules/ai/ai-readiness';
import { AiLevelPinsFacts, AiLevelResult, AiModelPolicyFacts, AiResidencyFacts, resolveChatLevel, resolveLevel } from '../../../engine/core-modules/ai/ai-levels';
import { AI_MODEL_CATALOGUE, AiCatalogueModel, AiModelTierName, catalogueEntry, validateTestModels } from '../../../engine/core-modules/ai/models/catalog';
import { usdToMicros } from '../../../engine/core-modules/ai/models/cost';
import { AI_PROVIDER_REGISTRY, AI_REAL_PROVIDERS, ANTHROPIC_API_KEY_ENV, GOOGLE_API_KEY_ENV, MISTRAL_API_KEY_ENV, OPENAI_API_KEY_ENV, XAI_API_KEY_ENV } from '../../../engine/core-modules/ai/models/provider-keys';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AI_STEP_INPUT_TOKEN_ALLOWANCE, AI_TEST_MODEL_CATALOGUE } from '../constants/ai.constants';

/**
 * Typed, read-only view of the validated AI_* configuration plus the model catalogue (docs/ai/PHASE1_TWENTY_PLAN.md
 * §4–§7). Provider key VALUES are not exposed here: only ModelGatewayService resolves a key, at the moment it builds a
 * provider client (`providerApiKey(config.envFacts(), model)`); this service answers "configured or not" only.
 *
 * Everything is recomputed on every call — the rules are pure and cheap — so the gate every AI entry point runs, the
 * Worker and the gateway can never disagree. On module start it logs, names only, why AI is not configured (owner
 * requirement 1: misconfiguration fails the AI subsystem closed; the process keeps running).
 *
 * The effective catalogue is the production catalogue, plus the in-process test models a TEST module provides through
 * AI_TEST_MODEL_CATALOGUE — honoured ONLY when NODE_ENV=test (production code provides `null`).
 */
@Injectable()
export class AiConfigService implements OnModuleInit {
  private readonly logger = new Logger('AiConfig');
  readonly catalogue: readonly AiCatalogueModel[];

  constructor(
    private readonly env: EnvironmentService,
    @Optional() @Inject(AI_TEST_MODEL_CATALOGUE) testModels?: readonly AiCatalogueModel[] | null,
  ) {
    this.catalogue = env.get('NODE_ENV') === 'test' && testModels && testModels.length > 0 ? Object.freeze([...AI_MODEL_CATALOGUE, ...validateTestModels(testModels)]) : AI_MODEL_CATALOGUE;
  }

  onModuleInit(): void {
    for (const warning of aiConfigurationWarnings(this.envFacts(), this.legacy(), this.catalogue)) this.logger.warn(warning);
    const readiness = this.platformReadiness();
    if (readiness.enabled && !readiness.ready) {
      // Fixed text + catalogue ids + variable names only. Some facts (the runtime database) are re-evaluated per request.
      this.logger.warn(`AI is not configured (fails closed): ${readiness.problems.map((p) => p.code).join(', ')}. ${readiness.problems.map((p) => p.message).join(' ')}`);
    }
  }

  /** The values the availability rules read. Never logged as a whole (it holds the keys). */
  envFacts(): AiEnvFacts {
    return {
      NODE_ENV: this.env.get('NODE_ENV'),
      AI_ENABLED: this.env.get('AI_ENABLED'),
      [ANTHROPIC_API_KEY_ENV]: this.env.get(ANTHROPIC_API_KEY_ENV),
      [OPENAI_API_KEY_ENV]: this.env.get(OPENAI_API_KEY_ENV),
      [GOOGLE_API_KEY_ENV]: this.env.get(GOOGLE_API_KEY_ENV),
      [MISTRAL_API_KEY_ENV]: this.env.get(MISTRAL_API_KEY_ENV),
      [XAI_API_KEY_ENV]: this.env.get(XAI_API_KEY_ENV),
      AI_DEV_ALLOW_REAL_PROVIDERS: this.env.get('AI_DEV_ALLOW_REAL_PROVIDERS') === true,
      AI_MODELS_DEFAULT_DISABLED: this.env.get('AI_MODELS_DEFAULT_DISABLED'),
      AI_MODELS_DEFAULT_FAST: this.env.get('AI_MODELS_DEFAULT_FAST'),
      AI_MODELS_DEFAULT_SMART: this.env.get('AI_MODELS_DEFAULT_SMART'),
    };
  }

  /** The retired AI names (presence / stand-in verdict only). */
  legacy(): LegacyAiEnvFacts {
    return typeof this.env.legacyAiEnv === 'function' ? this.env.legacyAiEnv() : NO_LEGACY_AI_ENV;
  }

  /** What the runtime database guard recorded at boot (null when it never ran ⇒ not the development database). */
  runtimeDatabase(): AiRuntimeDatabaseFacts | null {
    return recordedRuntimeDatabase();
  }

  availabilityContext(): AiAvailabilityContext {
    return { env: this.envFacts(), runtimeDb: this.runtimeDatabase(), legacy: this.legacy(), catalogue: this.catalogue };
  }

  entry(id: string | null | undefined): AiCatalogueModel | null {
    return catalogueEntry(id, this.catalogue);
  }

  modelState(model: AiCatalogueModel, ctx: AiAvailabilityContext = this.availabilityContext()): AiModelStateCode {
    return modelState(model, ctx);
  }

  /** The model may run right now (approved for this environment, in the build, keyed, not disabled). */
  isModelUsable(model: AiCatalogueModel): boolean {
    return isUsableState(this.modelState(model));
  }

  /** The model a turn on `tier` uses, given the organisation's pins (org pin → env default → nearest tier → any). */
  resolve(tier: AiModelTierName, pins: AiModelPins): AiModelResolution | null {
    return resolveModel(tier, pins, this.availabilityContext());
  }

  /**
   * C1 / CD-1: the chat turn's level resolution — the organisation's chat level (falling only to a LOWER level), or the
   * level the user named on submit (no fallback). The one resolver (`engine/core-modules/ai/ai-levels.ts`).
   */
  resolveChat(policy: AiModelPolicyFacts, pins: AiLevelPinsFacts, facts: AiResidencyFacts, requested?: AiModelLevel): AiLevelResult {
    return resolveChatLevel(pins, policy, this.availabilityContext(), facts, requested);
  }

  /** One level, no fallback (settings view, submit validation). */
  resolveLevel(level: AiModelLevel, policy: AiModelPolicyFacts, pins: AiLevelPinsFacts, facts: AiResidencyFacts): AiLevelResult {
    return resolveLevel(level, pins, policy, this.availabilityContext(), facts);
  }

  /** What is missing when a level does not resolve: residency first (the EU filter emptied it), else provider / model. */
  levelSetupNeeded(result: AiLevelResult): 'provider' | 'model' | 'residency' {
    if (!result.ok && result.reason === 'residency') return 'residency';
    return this.setupNeeded();
  }

  /** What is missing when nothing resolves: no usable provider at all (`provider`) or no usable model (`model`). */
  setupNeeded(): 'provider' | 'model' {
    return setupNeeded(this.availabilityContext());
  }

  platformReadiness() {
    return aiPlatformReadiness(this.availabilityContext());
  }

  /** Per provider: its key variable NAME, whether it is configured (boolean) and whether its SDK is in this build. */
  providerKeyStatus(): AiProviderKeyStatus[] {
    const env = this.envFacts();
    return AI_REAL_PROVIDERS.map((provider) => {
      const { keyEnv, sdkInstalled } = AI_PROVIDER_REGISTRY[provider];
      return { provider, envName: keyEnv, configured: typeof env[keyEnv] === 'string' && (env[keyEnv] as string).length > 0, sdkInstalled };
    });
  }

  /** The env id lists (catalogue ids only — never a key). */
  defaultLists(): { fast: string[]; smart: string[]; disabled: string[] } {
    const env = this.envFacts();
    return { fast: idList(env.AI_MODELS_DEFAULT_FAST), smart: idList(env.AI_MODELS_DEFAULT_SMART), disabled: idList(env.AI_MODELS_DEFAULT_DISABLED) };
  }

  /** Platform kill switch. */
  get enabled(): boolean {
    return this.env.get('AI_ENABLED') === true;
  }
  /** AI_MAX_OUTPUT_TOKENS (the per-call ceiling before the model's own limit is applied). */
  get maxOutputTokens(): number {
    return this.env.get('AI_MAX_OUTPUT_TOKENS');
  }
  /** Per model call: the lower of the catalogue ceiling and AI_MAX_OUTPUT_TOKENS. */
  maxOutputTokensFor(model: Pick<AiCatalogueModel, 'maxOutputTokens'>): number {
    return Math.min(model.maxOutputTokens, this.maxOutputTokens);
  }
  get maxSteps(): number {
    return this.env.get('AI_MAX_STEPS');
  }
  get maxInputChars(): number {
    return this.env.get('AI_MAX_INPUT_CHARS');
  }
  get orgDailyTokenBudget(): number {
    return this.env.get('AI_ORG_DAILY_TOKEN_BUDGET');
  }
  /** AI_DAILY_BUDGET_USD in integer micro-USD. */
  get dailyBudgetUsdMicros(): number {
    return usdToMicros(this.env.get('AI_DAILY_BUDGET_USD'));
  }
  get userRatePerMinute(): number {
    return this.env.get('AI_USER_RATE_PER_MIN');
  }
  get orgMaxActiveTurns(): number {
    return this.env.get('AI_ORG_MAX_ACTIVE_TURNS');
  }
  get turnTimeoutMs(): number {
    return this.env.get('AI_TURN_TIMEOUT_SECONDS') * 1000;
  }
  get retentionDays(): number {
    return this.env.get('AI_RETENTION_DAYS');
  }
  get retentionMode(): 'off' | 'report' | 'purge' {
    return this.env.get('AI_RETENTION_MODE');
  }
  get retentionIntervalMinutes(): number {
    return this.env.get('AI_RETENTION_INTERVAL_MINUTES');
  }

  /**
   * Tokens reserved for one turn before it is queued, and the hard per-turn ceiling the Worker enforces after every step:
   * every allowed step may consume its output limit plus a bounded input allowance. Never more than the daily budget.
   */
  get turnTokenReservation(): number {
    return this.turnTokenReservationFor(this.maxOutputTokens);
  }

  /** C1 / CD-1: the same bound for a turn whose per-step output cap is `perStepOutputTokens` (its level's, clamped). */
  turnTokenReservationFor(perStepOutputTokens: number): number {
    const perStep = Math.max(1, Math.min(this.maxOutputTokens, Math.floor(perStepOutputTokens)));
    return Math.min(this.orgDailyTokenBudget, this.maxSteps * (perStep + AI_STEP_INPUT_TOKEN_ALLOWANCE));
  }

  /**
   * 4w (Phase 4 D9): a turn that carries skill text (up to 24,000 characters) gains `maxSteps ×
   * AI_SKILL_LIMITS.tokenAllowancePerStep` on its reservation, still never above the daily token budget. `skills` = how
   * many skills the turn is known to load (the tagged ones; see the submit path for the provisional rule).
   */
  withSkillAllowance(reservation: number, skills: number): number {
    if (skills <= 0) return reservation;
    return Math.min(this.orgDailyTokenBudget, reservation + this.maxSteps * AI_SKILL_LIMITS.tokenAllowancePerStep);
  }

  /** C1 / CD-1: one step's output cap for a level on a model: the lowest of the level, the catalogue and AI_MAX_OUTPUT_TOKENS. */
  levelOutputTokens(model: Pick<AiCatalogueModel, 'maxOutputTokens'>, levelMaxOutputTokens: number): number {
    return Math.max(1, Math.min(this.maxOutputTokensFor(model), Math.floor(levelMaxOutputTokens)));
  }

  /** How long a per-organisation active-turn slot lives without a refresh (queue wait + turn + margin). */
  get slotTtlMs(): number {
    return this.turnTimeoutMs + 5 * 60_000;
  }

  /** `crewflow:<env>:ai:<parts…>` — a namespace of its own, like `crewflow:<env>:rt:` (realtime). */
  redisKey(...parts: string[]): string {
    return `crewflow:${this.env.get('NODE_ENV')}:ai:${parts.join(':')}`;
  }
}
