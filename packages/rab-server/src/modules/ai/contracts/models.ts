/**
 * AI contracts C0 — MODEL SELECTION, server side (docs/ai/AI_CONTRACTS.md §2.1). Types only: no behaviour.
 *
 * The Phase 1 resolver is the single authority and is unchanged: `resolveModel(tier, pins, ctx)` in
 * engine/core-modules/ai/ai-readiness.ts (approved + in build + keyed + enabled + environment permits; org pin →
 * AI_MODELS_DEFAULT_<TIER> → nearest tier → any). Every model a turn, a title or an agent uses goes through it; nothing
 * builds a model from a free-form id (rule 4.2). The model is resolved once at Worker start and re-checked (never
 * re-resolved) before every step.
 */
import type { AiAgentModelSelection, AiDataResidency, AiLevelUnavailableReason, AiModelEffort, AiModelLevel, AiModelSource, AiModelTier, AiPromptCacheMode } from '@rab/shared';

import type { AiAvailabilityContext, AiModelPins, AiModelResolution } from '../../../engine/core-modules/ai/ai-readiness';
import type { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';

/** What a model call is for. Each use maps to a tier; an agent's tier comes from its stored selection. */
export type AiModelUse = 'chat' | 'title' | 'agent';

/** Fixed tiers for the non-agent uses (chat = Phase 1; titles = P2 §2.5 "the fast model"). */
export const AI_MODEL_TIER_FOR_USE: Readonly<Record<Exclude<AiModelUse, 'agent'>, AiModelTier>> = Object.freeze({
  chat: 'fast',
  title: 'fast',
});

/**
 * Phase 6: an agent's model. `selection.modelId` is tried first as if it were the pin of `selection.tier` (same usable +
 * same-tier rule); otherwise the normal `resolveModel(selection.tier, orgPins, ctx)` applies. null = nothing usable → the
 * run is refused. Implemented by Agent 6 as a thin wrapper over `resolveModel`, never a second resolver.
 */
export type AiAgentModelResolver = (selection: AiAgentModelSelection, orgPins: AiModelPins, ctx: AiAvailabilityContext) => AiModelResolution | null;

/** Phase 7 catalogue fact added to `ai-models.json` (zod enum in catalog.ts; a static test refuses any `ttl`). */
export interface AiCatalogueCacheFact {
  promptCache: AiPromptCacheMode;
}

// ---------------------------------------------------------------------------------------------------------------------
// C1 (CD-1 / CD-2): the level resolver. ONE resolver: `resolveLevel` wraps the Phase 1 `resolveModel` rules and adds the
// level's effort (must be VERIFIED for the model) and the residency filter. `AiAgentModelResolver` becomes a wrapper.
// ---------------------------------------------------------------------------------------------------------------------

/** Code-only definition of a level (`engine/core-modules/ai/models/model-levels.ts` `AI_LEVEL_DEFINITIONS`, TW-D1). */
export interface AiLevelDefinition {
  level: AiModelLevel;
  tier: AiModelTier;
  /** Catalogue ids in code order (the level's own fallback list, after a pin and the env default list). */
  candidates: readonly string[];
  effort: AiModelEffort;
  /** Per-step output ceiling; feeds `turnTokenReservation` and the cost worst case. */
  maxOutputTokens: number;
}

/** `core.organisation_ai_model_policy` (no row = `AI_DEFAULT_MODEL_POLICY`). */
export interface AiModelPolicy {
  chatLevel: AiModelLevel;
  agentLevel: AiModelLevel;
  allowedLevels: readonly AiModelLevel[];
  dataResidency: AiDataResidency;
}

/** Level pins: `organisation_ai_model_preference` rows whose key is a level (`fast`/`smart` rows stay valid as level keys). */
export type AiLevelPins = Partial<Record<AiModelLevel, string>>;

export interface AiLevelResolution {
  level: AiModelLevel;
  model: AiCatalogueModel;
  effort: AiModelEffort;
  maxOutputTokens: number;
  source: AiModelSource;
}

export type AiLevelResolutionResult = { ok: true; resolution: AiLevelResolution } | { ok: false; level: AiModelLevel; reason: AiLevelUnavailableReason };

/**
 * `resolveLevel(level, pins, policy, ctx)`: level pin → `AI_MODELS_DEFAULT_<TIER>` → the level's candidates → none. Every
 * candidate passes `modelState` (approved + in build + keyed + enabled + environment) AND region ∈ residency AND effort ∈
 * the model's VERIFIED efforts. Never a silent jump to another level: callers that may fall back (the chat level only)
 * walk to the next LOWER available level and report `source: 'nearest'`; a level named on submit never falls back
 * (409 AI_LEVEL_UNAVAILABLE).
 */
export type AiLevelResolver = (level: AiModelLevel, pins: AiLevelPins, policy: AiModelPolicy, ctx: AiAvailabilityContext) => AiLevelResolutionResult;
