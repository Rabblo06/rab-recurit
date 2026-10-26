/**
 * The ONE level resolver (docs/ai/TWENTY_UI_CONTRACT_DELTAS.md CD-1 / CD-2; C1 contract `AiLevelResolver`). It wraps the
 * Phase 1 rules of `resolveModel` (ai-readiness.ts): every candidate must pass `modelState` (approved + in build + keyed +
 * not disabled + environment permits), AND be allowed by the organisation's data residency, AND support the level's
 * effort as a VERIFIED fact (`models/model-levels.ts`). There is no second resolver and no free-form model id.
 *
 * Order for one level: the level's pin → (legacy) the pin on its tier key → `AI_MODELS_DEFAULT_<TIER>` → the level's
 * code candidates (+ in-process test models of the tier, NODE_ENV=test only) → none. Never a silent jump to another
 * level: only the CHAT level may fall back, and only to the next LOWER available level (`source: 'nearest'`, shown in
 * the UI). A level named on submit never falls back (409 AI_LEVEL_UNAVAILABLE).
 */
import type { AiDataResidency, AiLevelUnavailableReason, AiModelEffort, AiModelLevel } from '@rab/shared';
import { AI_DEFAULT_ALLOWED_LEVELS, AI_DEFAULT_CHAT_LEVEL, AI_MODEL_LEVEL_KEYS } from '@rab/shared';

import { AiAvailabilityContext, AiResolutionSource, idList, isUsableState, modelState } from './ai-readiness';
import { AiCatalogueModel, catalogueEntry, isRealProvider } from './models/catalog';
import { AI_LEVEL_DEFINITIONS, AI_REAL_DATA_PERMITTED, verifiedEfforts } from './models/model-levels';

/** Structurally the C1 contract `AiModelPolicy`. */
export interface AiModelPolicyFacts {
  chatLevel: AiModelLevel;
  agentLevel: AiModelLevel;
  allowedLevels: readonly AiModelLevel[];
  dataResidency: AiDataResidency;
}

export const AI_DEFAULT_MODEL_POLICY: AiModelPolicyFacts = Object.freeze({
  chatLevel: AI_DEFAULT_CHAT_LEVEL,
  agentLevel: AI_DEFAULT_CHAT_LEVEL,
  allowedLevels: Object.freeze([...AI_DEFAULT_ALLOWED_LEVELS]),
  dataResidency: 'global',
});

export type AiLevelPinsFacts = Partial<Record<AiModelLevel, string>>;

export interface AiLevelResolutionFacts {
  level: AiModelLevel;
  model: AiCatalogueModel;
  effort: AiModelEffort;
  maxOutputTokens: number;
  source: AiResolutionSource;
}

export type AiLevelResult = { ok: true; resolution: AiLevelResolutionFacts } | { ok: false; level: AiModelLevel; reason: AiLevelUnavailableReason };

/** Who the turn's data belongs to, for the post-3.7 residency rule (CD-2). */
export interface AiResidencyFacts {
  synthetic: boolean;
}

export function isAiModelLevel(value: unknown): value is AiModelLevel {
  return typeof value === 'string' && (AI_MODEL_LEVEL_KEYS as readonly string[]).includes(value);
}

/**
 * CD-2: residency only NARROWS. `eu` → region `eu`; `global` → `global` or `eu`. A `us` model is never allowed (rule 3.7).
 * Once real data is permitted (`AI_REAL_DATA_PERMITTED`), a non-synthetic organisation resolves `eu` models only.
 */
export function residencyAllows(model: Pick<AiCatalogueModel, 'region'>, residency: AiDataResidency, facts: AiResidencyFacts = { synthetic: true }): boolean {
  if (model.region === 'us') return false;
  if (AI_REAL_DATA_PERMITTED && !facts.synthetic && model.region !== 'eu') return false;
  return residency === 'eu' ? model.region === 'eu' : model.region === 'global' || model.region === 'eu';
}

type CandidateVerdict = 'ok' | 'unusable' | 'residency' | 'effort';

function verdict(model: AiCatalogueModel | null, effort: AiModelEffort, residency: AiDataResidency, ctx: AiAvailabilityContext, facts: AiResidencyFacts): CandidateVerdict {
  if (!model || !isUsableState(modelState(model, ctx))) return 'unusable';
  if (!residencyAllows(model, residency, facts)) return 'residency';
  if (!verifiedEfforts(model).includes(effort)) return 'effort';
  return 'ok';
}

/** One level, no fallback to another level. */
export function resolveLevel(level: AiModelLevel, pins: AiLevelPinsFacts, policy: AiModelPolicyFacts, ctx: AiAvailabilityContext, facts: AiResidencyFacts = { synthetic: true }): AiLevelResult {
  const def = AI_LEVEL_DEFINITIONS[level];
  const seen: CandidateVerdict[] = [];
  const attempt = (id: string | undefined, source: AiResolutionSource, requireTier: boolean): AiLevelResult | null => {
    const model = catalogueEntry(id, ctx.catalogue);
    if (!model) return null;
    if (requireTier && model.tier !== def.tier) return null;
    const v = verdict(model, def.effort, policy.dataResidency, ctx, facts);
    seen.push(v);
    return v === 'ok' ? { ok: true, resolution: { level, model, effort: def.effort, maxOutputTokens: def.maxOutputTokens, source } } : null;
  };
  const tierKey = def.tier as AiModelLevel;
  const steps: Array<[string | undefined, AiResolutionSource, boolean]> = [
    [pins[level], 'pin', true],
    ...(tierKey !== level ? ([[pins[tierKey], 'pin', true]] as Array<[string | undefined, AiResolutionSource, boolean]>) : []),
    ...idList(def.tier === 'fast' ? ctx.env.AI_MODELS_DEFAULT_FAST : ctx.env.AI_MODELS_DEFAULT_SMART).map((id) => [id, 'default', true] as [string, AiResolutionSource, boolean]),
    ...def.candidates.map((id) => [id, 'any', true] as [string, AiResolutionSource, boolean]),
    // In-process test models of this tier (present only in the NODE_ENV=test catalogue; `modelState` refuses them elsewhere).
    ...ctx.catalogue.filter((m) => !isRealProvider(m) && m.tier === def.tier).map((m) => [m.id, 'any', true] as [string, AiResolutionSource, boolean]),
  ];
  for (const [id, source, requireTier] of steps) {
    const hit = attempt(id, source, requireTier);
    if (hit) return hit;
  }
  const reason: AiLevelUnavailableReason = seen.includes('effort') ? 'effort_unverified' : seen.includes('residency') ? 'residency' : 'no_approved_model';
  return { ok: false, level, reason };
}

/**
 * The chat turn's level: the requested level (policy chat level by default). With `allowLowerFallback` (the organisation's
 * chat level only — never a level the user named on submit), an unavailable level falls to the next LOWER level that
 * resolves, reported as `source: 'nearest'`.
 */
export function resolveChatLevel(
  pins: AiLevelPinsFacts,
  policy: AiModelPolicyFacts,
  ctx: AiAvailabilityContext,
  facts: AiResidencyFacts = { synthetic: true },
  requested?: AiModelLevel,
): AiLevelResult {
  const level = requested ?? policy.chatLevel;
  const first = resolveLevel(level, pins, policy, ctx, facts);
  if (first.ok || requested) return first;
  const index = AI_MODEL_LEVEL_KEYS.indexOf(level);
  for (let i = index - 1; i >= 0; i -= 1) {
    const lower = AI_MODEL_LEVEL_KEYS[i]!;
    const next = resolveLevel(lower, pins, policy, ctx, facts);
    if (next.ok) return { ok: true, resolution: { ...next.resolution, source: 'nearest' } };
  }
  return first;
}

/** Normalises a stored policy row (defensive: an unknown value falls back to the safe default, never to a wider one). */
export function policyFromRow(row: { chat_level?: unknown; agent_level?: unknown; allowed_levels?: unknown; data_residency?: unknown } | null | undefined): AiModelPolicyFacts {
  if (!row) return AI_DEFAULT_MODEL_POLICY;
  const allowed = Array.isArray(row.allowed_levels) ? row.allowed_levels.filter(isAiModelLevel) : [];
  const allowedLevels = allowed.length ? allowed : [...AI_DEFAULT_MODEL_POLICY.allowedLevels];
  const chatLevel = isAiModelLevel(row.chat_level) && allowedLevels.includes(row.chat_level) ? row.chat_level : AI_DEFAULT_CHAT_LEVEL;
  return {
    chatLevel,
    agentLevel: isAiModelLevel(row.agent_level) ? row.agent_level : AI_DEFAULT_CHAT_LEVEL,
    allowedLevels,
    // Anything but an explicit `global` is treated as the narrower `eu`.
    dataResidency: row.data_residency === 'global' ? 'global' : 'eu',
  };
}

/** Level pins from `organisation_ai_model_preference` rows (key = level key; legacy `fast` / `smart` rows included). */
export function levelPinsFromRows(rows: ReadonlyArray<{ tier: string; model_id: string }> | Record<string, unknown> | null | undefined): AiLevelPinsFacts {
  const pins: AiLevelPinsFacts = {};
  if (!rows) return pins;
  const entries: Array<[string, unknown]> = Array.isArray(rows) ? rows.map((r) => [r.tier, r.model_id]) : Object.entries(rows);
  for (const [key, id] of entries) if (isAiModelLevel(key) && typeof id === 'string') pins[key] = id;
  return pins;
}
