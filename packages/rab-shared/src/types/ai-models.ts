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
import type { AiModelSource, AiModelTier, AiModelView, AiTierSettingView } from './ai';

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

/**
 * `AiModelView` plus the Phase 7 fact and the CD-1 effort facts. Phase 1's `AiModelView` becomes this shape at the CD-1
 * merge (Agent 9). `supportedEfforts` lists only VERIFIED efforts (an unverified effort is not supported); `sources` are
 * the provider pages the facts were checked against, `verifiedAt` the check date. No speed or intelligence figures exist
 * anywhere in the contract (no verified source; TW-D9).
 */
export interface AiModelViewV2 extends AiModelView {
  promptCache: AiPromptCacheMode;
  supportedEfforts: AiModelEffort[];
  sources: string[];
  verifiedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// C1 (TWENTY_UI_CONTRACT_DELTAS CD-1 / CD-2): five levels, effort, data residency. Levels are CODE, never user text
// (rule 4.2): a level is an enum; the model behind it is resolved by the one resolver over the Phase 1 rules.
// ---------------------------------------------------------------------------------------------------------------------

export type AiModelEffort = 'low' | 'medium' | 'high';
export const AI_MODEL_EFFORTS: readonly AiModelEffort[] = ['low', 'medium', 'high'];

export type AiModelLevel = 'extra_fast' | 'fast' | 'balanced' | 'smart' | 'extra_smart';

/** The five levels in display order (bars 1–5). `tier` maps a level to the Phase 1 tier (pins, env default lists). */
export const AI_MODEL_LEVELS: readonly { level: AiModelLevel; label: string; bars: 1 | 2 | 3 | 4 | 5; tier: AiModelTier }[] = [
  { level: 'extra_fast', label: 'Extra fast', bars: 1, tier: 'fast' },
  { level: 'fast', label: 'Fast', bars: 2, tier: 'fast' },
  { level: 'balanced', label: 'Balanced', bars: 3, tier: 'smart' },
  { level: 'smart', label: 'Smart', bars: 4, tier: 'smart' },
  { level: 'extra_smart', label: 'Extra smart', bars: 5, tier: 'smart' },
];
export const AI_MODEL_LEVEL_KEYS: readonly AiModelLevel[] = AI_MODEL_LEVELS.map((l) => l.level);

/** TW-D1 / TW-D2: the default chat level (= Phase 1 behaviour) and the default per-message choice. */
export const AI_DEFAULT_CHAT_LEVEL: AiModelLevel = 'extra_fast';
export const AI_DEFAULT_ALLOWED_LEVELS: readonly AiModelLevel[] = ['extra_fast', 'fast'];

/**
 * Data residency (CD-2 / TW-D3) — a FILTER that only narrows: `eu` → models with `region = 'eu'`; `global` → `global` +
 * `eu`. There is no `us` option (rule 3.7). UI copy for `global`: "Global (demo data only)".
 */
export type AiDataResidency = 'global' | 'eu';
export const AI_DATA_RESIDENCIES: readonly AiDataResidency[] = ['global', 'eu'];

/** What is missing when nothing resolves (Phase 1 `AiSetupNeeded` + `residency`: "No approved model is available in the EU"). */
export type AiSetupNeededV2 = 'provider' | 'model' | 'residency';

/** Why a level cannot run right now (first failing reason). */
export type AiLevelUnavailableReason =
  /** No catalogue candidate of this level is approved + in build + keyed + enabled + environment-permitted. */
  | 'no_approved_model'
  /** A candidate exists but the level's effort is not verified for it. */
  | 'effort_unverified'
  /** Candidates exist but none is in the organisation's residency. */
  | 'residency'
  /** Not in the organisation's `allowedLevels`. */
  | 'not_allowed';

/** Model-level HTTP error codes. Folded into `AiErrorCode` by Agent 9 at the CD-1 merge. */
export const AiModelErrorCode = {
  /** Submit named a level outside `allowedLevels` or one that cannot run now: 409, never a silent fallback. */
  LEVEL_UNAVAILABLE: 'AI_LEVEL_UNAVAILABLE',
} as const;
export type AiModelErrorCodeType = (typeof AiModelErrorCode)[keyof typeof AiModelErrorCode];

/** `core.organisation_ai_model_policy` as Settings → AI shows it (no row = the defaults). */
export interface AiModelPolicyView {
  chatLevel: AiModelLevel;
  /** Shown disabled while EX-3 is not approved. */
  agentLevel: AiModelLevel;
  allowedLevels: AiModelLevel[];
  dataResidency: AiDataResidency;
  updatedAt: string | null;
}

/** `PUT /rest/v1/ai/settings/model-policy` (CEO + `ai.settings`, step-up as for model pins, reason, audited). */
export interface AiModelPolicyUpdateRequest {
  chatLevel?: AiModelLevel;
  agentLevel?: AiModelLevel;
  allowedLevels?: AiModelLevel[];
  dataResidency?: AiDataResidency;
  reason: string;
}

/** One level row of Settings → AI → Models. Prices and estimates come from the catalogue only. */
export interface AiLevelView {
  level: AiModelLevel;
  label: string;
  bars: 1 | 2 | 3 | 4 | 5;
  tier: AiModelTier;
  effort: AiModelEffort;
  maxOutputTokens: number;
  allowed: boolean;
  /** The organisation's stored pin for this level, or null ("Choose automatically"). */
  pinnedModelId: string | null;
  pinUnusable: boolean;
  /** What a turn at this level would use now; null = cannot run (`unavailableReason`). */
  resolved: { id: string; label: string; source: AiModelSource } | null;
  unavailableReason: AiLevelUnavailableReason | null;
  /** The resolved model's charged price (USD per 1M tokens), or null. */
  priceUsdPerMTok: { input: number; cachedInput: number; cacheWrite: number | null; output: number } | null;
  contextWindowTokens: number | null;
  /** "Up to" cost of 100 questions at this level's ceilings (integer micro-USD), with the assumption text (TW-D13). */
  estimate: { per100QuestionsUpperBoundMicros: number; assumptions: string } | null;
  /** Blended price (3·input + output) / 4 relative to the chat level; null when either side cannot run. */
  priceRatio: number | null;
}

/**
 * `GET /rest/v1/ai/settings/models`, target shape (replaces `AiModelSettingsView` at the CD-1 merge). `tiers` (the Phase 1
 * shape) is kept for one release so the Phase 1 card keeps working; new UI reads `levels` + `policy`.
 */
export interface AiModelSettingsViewV2 {
  models: AiModelViewV2[];
  levels: AiLevelView[];
  policy: AiModelPolicyView;
  setup: AiSetupNeededV2 | null;
  /** @deprecated Phase 1 shape, one release. */
  tiers: AiTierSettingView[];
}

/** What the chat composer needs for the level picker (`GET /ai/availability`), for every `ai.use` user. */
export interface AiAvailabilityLevelsView {
  chatLevel: AiModelLevel;
  options: { level: AiModelLevel; label: string; bars: 1 | 2 | 3 | 4 | 5; available: boolean; unavailableReason: AiLevelUnavailableReason | null }[];
}

/** CD-11: an agent's model is a LEVEL plus an optional catalogue lookup key (replaces the tier form at the 6a merge). */
export interface AiAgentModelSelectionV2 {
  level: AiModelLevel;
  modelId: string | null;
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
