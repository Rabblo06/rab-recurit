/**
 * Crewflow AI levels (docs/ai/TWENTY_UI_CONTRACT_DELTAS.md CD-1, owner decision TW-D1). CODE ONLY, never user text or
 * database content (rule 4.2): a level is an enum, and what runs behind it is decided here and by the one resolver
 * (`../ai-levels.ts` `resolveLevel`, over the Phase 1 `modelState` rules).
 *
 * Kept OUT of `ai-models.json` / `catalog.ts` on purpose: the effort facts are a reviewed overlay (like
 * `AI_MODEL_APPROVALS`), so changing what a level may send to a provider is a code review, not a JSON edit.
 */
import type { AiModelEffort, AiModelLevel, AiModelTier } from '@rab/shared';

import { AI_HAIKU_MODEL_ID } from './catalog';

/** Structurally the C1 contract `AiLevelDefinition` (modules/ai/contracts/models.ts); declared here because engine/ never imports modules/. */
export interface AiLevelDefinition {
  level: AiModelLevel;
  tier: AiModelTier;
  candidates: readonly string[];
  effort: AiModelEffort;
  maxOutputTokens: number;
}

/**
 * TW-D1. `extra_fast` = exactly the Phase 1 behaviour (Haiku 5.5, effort low, 1,500 output tokens per step).
 * `fast` = Haiku 5.5 at effort medium: usable only once `medium` is VERIFIED for Haiku in `AI_MODEL_VERIFIED_EFFORTS`.
 * The three higher levels have no approved model today and show "No approved model".
 */
export const AI_LEVEL_DEFINITIONS: Readonly<Record<AiModelLevel, AiLevelDefinition>> = Object.freeze({
  extra_fast: Object.freeze({ level: 'extra_fast', tier: 'fast', candidates: Object.freeze([AI_HAIKU_MODEL_ID, 'openai-gpt-6-luna-eu']), effort: 'low', maxOutputTokens: 1_500 }),
  fast: Object.freeze({ level: 'fast', tier: 'fast', candidates: Object.freeze([AI_HAIKU_MODEL_ID, 'openai-gpt-6-luna-eu']), effort: 'medium', maxOutputTokens: 4_000 }),
  balanced: Object.freeze({ level: 'balanced', tier: 'smart', candidates: Object.freeze(['anthropic-claude-sonnet-5-5', 'openai-gpt-6.1-sol-eu']), effort: 'low', maxOutputTokens: 4_000 }),
  smart: Object.freeze({ level: 'smart', tier: 'smart', candidates: Object.freeze(['anthropic-claude-sonnet-5-5', 'openai-gpt-6.1-sol-eu']), effort: 'high', maxOutputTokens: 8_000 }),
  extra_smart: Object.freeze({ level: 'extra_smart', tier: 'smart', candidates: Object.freeze(['anthropic-claude-opus-5-5']), effort: 'high', maxOutputTokens: 16_000 }),
}) as Readonly<Record<AiModelLevel, AiLevelDefinition>>;

/**
 * VERIFIED efforts per catalogue model (CD-1 `supportedEfforts`). An effort not listed is NOT supported, so a level that
 * needs it cannot resolve to that model (fail closed). Each entry names what verified it.
 *   - Haiku 5.5 `low`: the effort Phase 1 has sent on every call since P1-D12 (catalogue `providerOptions`).
 *   - Haiku 5.5 `medium` / `high`: NOT verified (no provider source recorded) — so the `fast` level is unavailable.
 * Every other catalogue model: nothing verified (none is approved either).
 */
export const AI_MODEL_VERIFIED_EFFORTS: Readonly<Record<string, { efforts: readonly AiModelEffort[]; verifiedBy: string }>> = Object.freeze({
  [AI_HAIKU_MODEL_ID]: Object.freeze({ efforts: Object.freeze(['low'] as const), verifiedBy: 'Phase 1 P1-D12: effort low sent on every Haiku 5.5 call (catalogue providerOptions)' }),
});

/** In-process test models (NODE_ENV=test only) accept every effort: they never leave the process. */
export function verifiedEfforts(model: { id: string; provider: string }): readonly AiModelEffort[] {
  if (model.provider === 'test') return ['low', 'medium', 'high'];
  return AI_MODEL_VERIFIED_EFFORTS[model.id]?.efforts ?? [];
}

/**
 * CD-2 fail-closed rule for later: once real (non-synthetic) data may be sent (the rule 3.7 checklist is complete), a
 * non-synthetic organisation may only resolve `eu` models whatever its residency setting. False today: EX-1 already
 * refuses every real provider for a non-synthetic organisation. Flipping it is a reviewed security change.
 */
export const AI_REAL_DATA_PERMITTED = false;
