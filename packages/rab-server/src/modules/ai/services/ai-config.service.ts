import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { recordedRuntimeDatabase } from '../../../database/typeorm/core/runtime-database-guard';
import { AiEnvFacts, AiReadiness, AiReadinessCode, AiRuntimeDatabaseFacts, aiConfigurationWarnings, aiReadiness, resolveProviderApiKey } from '../../../engine/core-modules/ai/ai-readiness';
import { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import { usdToMicros } from '../../../engine/core-modules/ai/models/cost';
import { ANTHROPIC_API_KEY_ENV } from '../../../engine/core-modules/ai/models/provider-keys';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AI_STEP_INPUT_TOKEN_ALLOWANCE } from '../constants/ai.constants';

/**
 * Typed, read-only view of the validated AI_* configuration plus the model catalogue. The provider API key is NOT exposed
 * here: only ModelGatewayService resolves it, at the moment it builds a real provider client.
 *
 * Readiness (engine/core-modules/ai/ai-readiness.ts) is recomputed on every call — it is pure and cheap — so the gate
 * every AI entry point runs can never disagree with the gateway. On module start it logs, names only, why AI is
 * unavailable (owner requirement 1: misconfiguration fails the AI subsystem closed; the process keeps running).
 */
@Injectable()
export class AiConfigService implements OnModuleInit {
  private readonly logger = new Logger('AiConfig');

  constructor(private readonly env: EnvironmentService) {}

  onModuleInit(): void {
    for (const warning of aiConfigurationWarnings(this.envFacts())) this.logger.warn(warning);
    const readiness = this.readiness();
    if (readiness.enabled && !readiness.ready) {
      // Fixed text + catalogue ids + variable names only. Some facts (the runtime database) are re-evaluated per request.
      this.logger.warn(`AI is unavailable (fails closed): ${readiness.problems.map((p) => p.code).join(', ')}. ${readiness.problems.map((p) => p.message).join(' ')}`);
    }
  }

  /** The values the readiness rules read. Never logged as a whole (it holds the keys). */
  envFacts(): AiEnvFacts {
    return {
      NODE_ENV: this.env.get('NODE_ENV'),
      AI_ENABLED: this.env.get('AI_ENABLED'),
      AI_PROVIDER: this.env.get('AI_PROVIDER'),
      AI_MODEL: this.env.get('AI_MODEL'),
      AI_PROVIDER_API_KEY: this.env.get('AI_PROVIDER_API_KEY'),
      [ANTHROPIC_API_KEY_ENV]: this.env.get(ANTHROPIC_API_KEY_ENV),
      AI_DEV_ALLOW_REAL_PROVIDERS: this.env.get('AI_DEV_ALLOW_REAL_PROVIDERS') === true,
      AI_MODELS_DEFAULT_DISABLED: this.env.get('AI_MODELS_DEFAULT_DISABLED'),
    };
  }

  /** What the runtime database guard recorded at boot (null when it never ran ⇒ not the development database). */
  runtimeDatabase(): AiRuntimeDatabaseFacts | null {
    return recordedRuntimeDatabase();
  }

  readiness(): AiReadiness {
    return aiReadiness(this.envFacts(), this.runtimeDatabase());
  }

  /** Platform kill switch. */
  get enabled(): boolean {
    return this.env.get('AI_ENABLED') === true;
  }
  /** Deprecated env value (the catalogue entry decides the provider). */
  get provider(): string | null {
    return this.env.get('AI_PROVIDER') ?? null;
  }
  /** The resolved catalogue id (AI_MODEL, or the catalogue default). Stamped on `ai_message.model`. */
  get model(): string {
    return this.readiness().modelId ?? '';
  }
  get modelEntry(): AiCatalogueModel | null {
    return this.readiness().model;
  }
  /** The model is in the catalogue and allowed to run in this environment class (approved, or the in-process mock). */
  get modelAllowlisted(): boolean {
    const r = this.readiness();
    return Boolean(r.model && !r.problems.some((p) => p.code === AiReadinessCode.MODEL_UNKNOWN || p.code === AiReadinessCode.MODEL_NOT_APPROVED || p.code === AiReadinessCode.MODEL_DISABLED));
  }
  /** Whether the resolved model's provider key is configured (never the key itself). False for the mock. */
  get credentialsConfigured(): boolean {
    const model = this.modelEntry;
    return Boolean(model && resolveProviderApiKey(this.envFacts(), model).key);
  }
  /** Per model call: the lower of the catalogue ceiling and AI_MAX_OUTPUT_TOKENS. */
  get maxOutputTokens(): number {
    const configured = this.env.get('AI_MAX_OUTPUT_TOKENS');
    const ceiling = this.modelEntry?.maxOutputTokens;
    return ceiling ? Math.min(ceiling, configured) : configured;
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
    return Math.min(this.orgDailyTokenBudget, this.maxSteps * (this.maxOutputTokens + AI_STEP_INPUT_TOKEN_ALLOWANCE));
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
