/**
 * AI contracts C0 — MODEL SELECTION (docs/ai/AI_CONTRACTS.md §2.1). Types only: no behaviour, no runtime change.
 *
 * Phase 1 already ships the model-selection wire types in `./ai` (`AiModelTier`, `AiModelView`, `AiModelState`,
 * `AiTierSettingView`, `AiModelSettingsView`) and the resolver in the engine (`engine/core-modules/ai/ai-readiness.ts`
 * `resolveModel(tier, pins, ctx)`). They are unchanged. This file adds only what later phases need on top:
 *   - Phase 6: an agent's model is a TIER plus an optional catalogue LOOKUP KEY (`modelId`), never a free-form id (rule 4.2).
 *     The key is re-validated by the Phase 1 resolver at save and at every run; a stale key falls back to the tier.
 *   - Phase 7: the per-model prompt-cache fact (`ai-models.json` `promptCache`), shown in Settings → AI and the Admin Panel.
 *   - Phase 8: the "agent default" picker on the Models tab (shown only while agents are enabled).
 */
import type { AiModelSource, AiModelTier, AiModelView } from './ai';

/**
 * How a model caches a prompt prefix (Phase 7 catalogue fact, zod enum in `catalog.ts`). `anthropic-auto` = one
 * request-level `cacheControl: {type: 'ephemeral'}` with NO `ttl` (5 minutes). `openai-key` = a hashed
 * `promptCacheKey` (inert until an OpenAI SDK is approved). `none` = never cached.
 *
 * Owner decision 2026-10-25 (D7-4): caching ON for development + synthetic data only (EX-1); production only after the
 * release checklist records that the provider's zero-data-retention terms cover prompt caching.
 */
export type AiPromptCacheMode = 'anthropic-auto' | 'openai-key' | 'none';
export const AI_PROMPT_CACHE_MODES: readonly AiPromptCacheMode[] = ['anthropic-auto', 'openai-key', 'none'];

/** `AiModelView` plus the Phase 7 fact. Phase 1's `AiModelView` becomes this shape when Phase 7 (7a) merges. */
export interface AiModelViewV2 extends AiModelView {
  promptCache: AiPromptCacheMode;
}

/**
 * An agent's stored model choice (Phase 6 `ai_agent.model_tier` + `ai_agent.model_id`). `modelId` is a catalogue lookup
 * key or null ("use the tier"); it is never sent to a provider as-is and never accepted unless the catalogue knows it.
 */
export interface AiAgentModelSelection {
  tier: AiModelTier;
  modelId: string | null;
}

/** What an agent would run on right now (Settings → AI → Agents, and the run record). */
export interface AiAgentModelResolutionView {
  selection: AiAgentModelSelection;
  /** The stored `modelId` is unknown, unapproved, unavailable or of another tier: it is skipped, never called. */
  modelIdUnusable: boolean;
  resolved: { id: string; label: string; source: AiModelSource | 'agent' } | null;
}
