/**
 * C1 / TWENTY_UI_CONTRACT_DELTAS CD-1 / CD-2: the one level resolver. Pure, no DB, no model call.
 */
import { AI_MODEL_LEVEL_KEYS } from '@rab/shared';

import { AiAvailabilityContext, AiEnvFacts, NO_LEGACY_AI_ENV } from '../ai-readiness';
import { AI_DEFAULT_MODEL_POLICY, AiModelPolicyFacts, levelPinsFromRows, policyFromRow, residencyAllows, resolveChatLevel, resolveLevel } from '../ai-levels';
import { AI_HAIKU_MODEL_ID, AI_MODEL_CATALOGUE, AiCatalogueModel, catalogueEntry } from '../models/catalog';
import { AI_LEVEL_DEFINITIONS, AI_MODEL_VERIFIED_EFFORTS, verifiedEfforts } from '../models/model-levels';

const KEY = 'test-only-anthropic-key-'.padEnd(40, 'x');
const DEV_DB = { runtimeEnvironment: 'development', classification: 'LOCAL' };
const devEnv = (extra: Partial<AiEnvFacts> = {}): AiEnvFacts => ({ NODE_ENV: 'development', AI_ENABLED: true, ANTHROPIC_API_KEY: KEY, AI_DEV_ALLOW_REAL_PROVIDERS: true, ...extra });
const ctxOf = (env: AiEnvFacts, catalogue: readonly AiCatalogueModel[] = AI_MODEL_CATALOGUE): AiAvailabilityContext => ({ env, runtimeDb: DEV_DB, legacy: NO_LEGACY_AI_ENV, catalogue });
const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;
const policy = (p: Partial<AiModelPolicyFacts> = {}): AiModelPolicyFacts => ({ ...AI_DEFAULT_MODEL_POLICY, ...p });
const fake = (id: string, over: Partial<AiCatalogueModel>): AiCatalogueModel => Object.freeze({ ...haiku, id, approved: true, ...over }) as AiCatalogueModel;

describe('CD-1 level definitions (TW-D1)', () => {
  it('five levels; extra_fast = Phase 1 (Haiku, low, 1,500); caps grow with the level', () => {
    expect(Object.keys(AI_LEVEL_DEFINITIONS)).toEqual([...AI_MODEL_LEVEL_KEYS]);
    expect(AI_LEVEL_DEFINITIONS.extra_fast).toMatchObject({ tier: 'fast', effort: 'low', maxOutputTokens: 1500, candidates: [AI_HAIKU_MODEL_ID, 'openai-gpt-6-luna-eu'] });
    expect(AI_LEVEL_DEFINITIONS.fast).toMatchObject({ tier: 'fast', effort: 'medium', maxOutputTokens: 4000 });
    expect(AI_LEVEL_DEFINITIONS.extra_smart).toMatchObject({ tier: 'smart', effort: 'high', maxOutputTokens: 16000, candidates: ['anthropic-claude-opus-5-5'] });
    for (const def of Object.values(AI_LEVEL_DEFINITIONS)) for (const id of def.candidates) expect(catalogueEntry(id)?.tier).toBe(def.tier);
  });

  it('only verified efforts count: Haiku low only; nothing else is verified', () => {
    expect(verifiedEfforts(haiku)).toEqual(['low']);
    expect(Object.keys(AI_MODEL_VERIFIED_EFFORTS)).toEqual([AI_HAIKU_MODEL_ID]);
    for (const m of AI_MODEL_CATALOGUE.filter((x) => x.id !== AI_HAIKU_MODEL_ID)) expect(verifiedEfforts(m)).toEqual([]);
  });
});

describe('CD-1 resolveLevel (no silent cross-level fallback)', () => {
  const ctx = ctxOf(devEnv());

  it('extra_fast resolves to Haiku with effort low and the 1,500 cap', () => {
    const r = resolveLevel('extra_fast', {}, policy(), ctx);
    expect(r).toEqual({ ok: true, resolution: { level: 'extra_fast', model: haiku, effort: 'low', maxOutputTokens: 1500, source: 'any' } });
  });

  it('fast needs medium on Haiku, which is not verified: effort_unverified, never Haiku-at-low', () => {
    expect(resolveLevel('fast', {}, policy(), ctx)).toEqual({ ok: false, level: 'fast', reason: 'effort_unverified' });
    expect(resolveLevel('fast', { fast: AI_HAIKU_MODEL_ID }, policy(), ctx)).toEqual({ ok: false, level: 'fast', reason: 'effort_unverified' });
  });

  it('the higher levels have no approved model (Sonnet / Opus / GPT are not approved)', () => {
    for (const level of ['balanced', 'smart', 'extra_smart'] as const) expect(resolveLevel(level, {}, policy(), ctx)).toEqual({ ok: false, level, reason: 'no_approved_model' });
  });

  it('unapproved, unkeyed, disabled and environment-refused models are never chosen', () => {
    expect(resolveLevel('extra_fast', {}, policy(), ctxOf(devEnv({ ANTHROPIC_API_KEY: undefined }))).ok).toBe(false);
    expect(resolveLevel('extra_fast', {}, policy(), ctxOf(devEnv({ AI_MODELS_DEFAULT_DISABLED: AI_HAIKU_MODEL_ID }))).ok).toBe(false);
    expect(resolveLevel('extra_fast', {}, policy(), ctxOf(devEnv({ NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: false }))).ok).toBe(false);
    expect(resolveLevel('extra_fast', { extra_fast: 'anthropic-claude-sonnet-5-5' }, policy(), ctx)).toMatchObject({ ok: true, resolution: { model: haiku } });
  });

  it('a pin of the right tier wins; a legacy tier pin serves the other levels of that tier', () => {
    const other = fake('approved-fast-x', { tier: 'fast' });
    const c = ctxOf(devEnv(), [...AI_MODEL_CATALOGUE, other]);
    // `other` has no verified efforts → never usable, whatever the pin says.
    expect(resolveLevel('extra_fast', { extra_fast: other.id }, policy(), c)).toMatchObject({ ok: true, resolution: { model: haiku, source: 'any' } });
    expect(resolveLevel('extra_fast', { fast: AI_HAIKU_MODEL_ID }, policy(), ctx)).toMatchObject({ ok: true, resolution: { model: haiku, source: 'pin' } });
  });
});

describe('CD-2 residency (filter only narrows; no us)', () => {
  const ctx = ctxOf(devEnv());
  it('global allows global + eu; eu allows eu only; us never', () => {
    expect(residencyAllows({ region: 'global' }, 'global')).toBe(true);
    expect(residencyAllows({ region: 'eu' }, 'global')).toBe(true);
    expect(residencyAllows({ region: 'global' }, 'eu')).toBe(false);
    expect(residencyAllows({ region: 'eu' }, 'eu')).toBe(true);
    expect(residencyAllows({ region: 'us' }, 'global')).toBe(false);
    expect(residencyAllows({ region: 'us' }, 'eu')).toBe(false);
  });

  it('eu leaves no approved model today → residency (setup "No approved model is available in the EU")', () => {
    expect(resolveLevel('extra_fast', {}, policy({ dataResidency: 'eu' }), ctx)).toEqual({ ok: false, level: 'extra_fast', reason: 'residency' });
  });

  it('the real-data rule is inactive until the 3.7 checklist (non-synthetic orgs are refused by EX-1 anyway)', () => {
    expect(residencyAllows({ region: 'global' }, 'global', { synthetic: false })).toBe(true);
  });
});

describe('CD-1 chat level fallback: only to a LOWER level, only for the policy chat level', () => {
  const ctx = ctxOf(devEnv());
  it('chat level smart (unavailable) falls to extra_fast with source nearest', () => {
    const r = resolveChatLevel({}, policy({ chatLevel: 'smart', allowedLevels: ['extra_fast', 'smart'] }), ctx);
    expect(r).toMatchObject({ ok: true, resolution: { level: 'extra_fast', model: haiku, source: 'nearest' } });
  });
  it('a level named on submit never falls back', () => {
    expect(resolveChatLevel({}, policy(), ctx, { synthetic: true }, 'fast')).toEqual({ ok: false, level: 'fast', reason: 'effort_unverified' });
  });
  it('extra_fast is the floor: nothing lower to fall to', () => {
    expect(resolveChatLevel({}, policy(), ctxOf(devEnv({ ANTHROPIC_API_KEY: undefined }))).ok).toBe(false);
  });
});

describe('stored rows are normalised defensively', () => {
  it('no row = defaults; an unknown value narrows, never widens', () => {
    expect(policyFromRow(null)).toEqual(AI_DEFAULT_MODEL_POLICY);
    expect(policyFromRow({ chat_level: 'nope', agent_level: 'x', allowed_levels: ['zz'], data_residency: 'us' })).toEqual({ ...AI_DEFAULT_MODEL_POLICY, dataResidency: 'eu' });
    expect(policyFromRow({ chat_level: 'smart', allowed_levels: ['extra_fast'], data_residency: 'global' }).chatLevel).toBe('extra_fast');
    expect(levelPinsFromRows([{ tier: 'fast', model_id: 'a' }, { tier: 'bogus', model_id: 'b' }, { tier: 'extra_smart', model_id: 'c' }])).toEqual({ fast: 'a', extra_smart: 'c' });
  });
});
