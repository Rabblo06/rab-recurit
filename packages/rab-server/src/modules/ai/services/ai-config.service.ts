import { Injectable } from '@nestjs/common';

import { AI_MODEL_ALLOWLIST } from '../../../engine/core-modules/environment/env.validation';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { AI_STEP_INPUT_TOKEN_ALLOWANCE } from '../constants/ai.constants';

/**
 * Typed, read-only view of the validated AI_* configuration (EnvironmentVariables + env.validation cross-field rules,
 * which already refused to boot on a bad value). The provider API key is deliberately NOT exposed here: only
 * ModelGatewayService reads it, at the moment it builds a real provider client.
 */
@Injectable()
export class AiConfigService {
  constructor(private readonly env: EnvironmentService) {}

  /** Platform kill switch. */
  get enabled(): boolean {
    return this.env.get('AI_ENABLED') === true;
  }
  get provider(): string | null {
    return this.env.get('AI_PROVIDER') ?? null;
  }
  get model(): string | null {
    return this.env.get('AI_MODEL') ?? null;
  }
  /** Provider + model are both set and on the allowlist (boot already refuses a configured model that is not). */
  get modelAllowlisted(): boolean {
    const provider = this.provider as keyof typeof AI_MODEL_ALLOWLIST | null;
    return Boolean(provider && this.model && (AI_MODEL_ALLOWLIST[provider] ?? []).includes(this.model));
  }
  get credentialsConfigured(): boolean {
    return Boolean(this.env.get('AI_PROVIDER_API_KEY'));
  }
  get maxOutputTokens(): number {
    return this.env.get('AI_MAX_OUTPUT_TOKENS');
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
