/**
 * AI contracts C0 — MODEL SELECTION, server side (docs/ai/AI_CONTRACTS.md §2.1). Types only: no behaviour.
 *
 * The Phase 1 resolver is the single authority and is unchanged: `resolveModel(tier, pins, ctx)` in
 * engine/core-modules/ai/ai-readiness.ts (approved + in build + keyed + enabled + environment permits; org pin →
 * AI_MODELS_DEFAULT_<TIER> → nearest tier → any). Every model a turn, a title or an agent uses goes through it; nothing
 * builds a model from a free-form id (rule 4.2). The model is resolved once at Worker start and re-checked (never
 * re-resolved) before every step.
 */
import type { AiAgentModelSelection, AiModelTier, AiPromptCacheMode } from '@rab/shared';

import type { AiAvailabilityContext, AiModelPins, AiModelResolution } from '../../../engine/core-modules/ai/ai-readiness';

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
