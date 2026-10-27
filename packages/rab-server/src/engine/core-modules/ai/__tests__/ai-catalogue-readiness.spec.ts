import * as fs from 'fs';
import * as path from 'path';

import { validate } from '../../environment/env.validation';
import {
  AiAvailabilityContext,
  aiBootProblems,
  aiConfigurationWarnings,
  AiEnvFacts,
  aiPlatformReadiness,
  approvedModelIds,
  legacyAiEnvFacts,
  modelState,
  NO_LEGACY_AI_ENV,
  PRODUCTION_LEGACY_AI_ENV_REFUSAL_CONFIRMED,
  providerApiKey,
  resolveModel,
  setupNeeded,
} from '../ai-readiness';
import { AI_CATALOGUE_IDS, AI_HAIKU_MODEL_ID, AI_MODEL_APPROVALS, AI_MODEL_CATALOGUE, AI_MODELS_FILE_SCHEMA, AiCatalogueModel, catalogueEntry, chargedMicros, loadAiModelCatalogue, validateTestModels } from '../models/catalog';
import { maxInputTokensFromBytes, stepCostUsdMicros, usdToMicros, worstCaseStepUsdMicros } from '../models/cost';
import { AI_PROVIDER_KEY_ENVS, ANTHROPIC_API_KEY_ENV, ANTHROPIC_FIXED_BASE_URL } from '../models/provider-keys';

const KEY = 'test-only-anthropic-key-'.padEnd(40, 'x');
const DEV_DB = { runtimeEnvironment: 'development', classification: 'LOCAL' };
const RAW_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, '../models/ai-models.json'), 'utf8')) as { models: Array<Record<string, unknown>> };
const SONNET = 'anthropic-claude-sonnet-5-5';
const OPUS = 'anthropic-claude-opus-5-5';
const LUNA = 'openai-gpt-6-luna-eu';
const SOL = 'openai-gpt-6.1-sol-eu';

const devEnv = (extra: Partial<AiEnvFacts> = {}): AiEnvFacts => ({ NODE_ENV: 'development', AI_ENABLED: true, ANTHROPIC_API_KEY: KEY, AI_DEV_ALLOW_REAL_PROVIDERS: true, ...extra });
const ctxOf = (env: AiEnvFacts, opts: { db?: typeof DEV_DB | null; catalogue?: readonly AiCatalogueModel[]; legacyKey?: boolean } = {}): AiAvailabilityContext => ({
  env,
  runtimeDb: opts.db === undefined ? DEV_DB : opts.db,
  legacy: opts.legacyKey ? { ...NO_LEGACY_AI_ENV, legacyKeySet: true } : NO_LEGACY_AI_ENV,
  catalogue: opts.catalogue ?? AI_MODEL_CATALOGUE,
});
const entry = (id: string) => catalogueEntry(id)!;
const BASE = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', APP_SECRET: 'a'.repeat(40) };

/** A pretend approved model, for resolver tests only (never part of the real catalogue). */
const fake = (id: string, over: Partial<AiCatalogueModel> = {}): AiCatalogueModel => ({ ...entry(AI_HAIKU_MODEL_ID), id, providerModelId: id, ...over });

// ── T-C1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T-C1 ai-models.json: facts only, zod-validated, approvals only in TypeScript', () => {
  it('the committed JSON passes the strict schema; ids are unique and regex-safe; the catalogue is frozen', () => {
    expect(AI_MODELS_FILE_SCHEMA.safeParse(RAW_JSON).success).toBe(true);
    expect(new Set(AI_CATALOGUE_IDS).size).toBe(AI_CATALOGUE_IDS.length);
    for (const id of AI_CATALOGUE_IDS) expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,99}$/);
    expect(Object.isFrozen(AI_MODEL_CATALOGUE)).toBe(true);
    for (const m of AI_MODEL_CATALOGUE) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.price)).toBe(true);
      for (const v of [m.price.inputUsdMicrosPerMTok, m.price.cachedInputUsdMicrosPerMTok, m.price.outputUsdMicrosPerMTok]) expect(Number.isInteger(v)).toBe(true);
      expect(m.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.sources.length).toBeGreaterThan(0);
      expect(['fast', 'smart']).toContain(m.tier);
      expect(['global', 'eu', 'us']).toContain(m.region);
      expect(typeof m.deprecated).toBe('boolean');
    }
  });

  it('the JSON carries NO approval key at any depth, and the schema refuses one (a JSON edit cannot approve a model)', () => {
    const text = JSON.stringify(RAW_JSON);
    expect(text).not.toMatch(/"approved"|"approval"|"productionApproved"|"devOnly"/);
    const tampered = JSON.parse(text) as { models: Array<Record<string, unknown>> };
    tampered.models[1]!.approved = true;
    expect(AI_MODELS_FILE_SCHEMA.safeParse(tampered).success).toBe(false);
    expect(() => loadAiModelCatalogue(tampered)).toThrow(/ai-models.json is invalid/);
  });

  it.each([
    ['an unknown provider', (m: Record<string, unknown>) => (m.provider = 'gemini-direct')],
    ['a negative price', (m: Record<string, unknown>) => ((m.priceUsdPerMTok as Record<string, number>).input = -1)],
    ['an id with capitals', (m: Record<string, unknown>) => (m.id = 'Claude')],
    ['an http endpoint', (m: Record<string, unknown>) => (m.baseURL = 'http://api.anthropic.com/v1')],
    ['an Anthropic model on another endpoint', (m: Record<string, unknown>) => (m.baseURL = 'https://attacker.example/v1')],
    ['an unknown provider option', (m: Record<string, unknown>) => (m.providerOptions = { anthropic: { effort: 'low', baseURL: 'x' } })],
    ['a missing tier', (m: Record<string, unknown>) => delete m.tier],
  ])('a malformed file is refused at load: %s', (_label, mutate) => {
    const bad = JSON.parse(JSON.stringify(RAW_JSON)) as { models: Array<Record<string, unknown>> };
    mutate(bad.models[0]!);
    expect(() => loadAiModelCatalogue(bad)).toThrow(/ai-models.json is invalid/);
  });

  it('a duplicate id is refused', () => {
    const bad = JSON.parse(JSON.stringify(RAW_JSON)) as { models: unknown[] };
    bad.models.push(bad.models[0]);
    expect(() => loadAiModelCatalogue(bad)).toThrow(/duplicate model id/);
  });

  it('exactly ONE model is approved (Claude Haiku 5.5, development + synthetic data only); NOTHING is production-approved', () => {
    expect(approvedModelIds()).toEqual([AI_HAIKU_MODEL_ID]);
    expect(Object.keys(AI_MODEL_APPROVALS)).toEqual([AI_HAIKU_MODEL_ID]);
    expect(AI_MODEL_CATALOGUE.filter((m) => m.productionApproved)).toEqual([]);
    expect(entry(AI_HAIKU_MODEL_ID).approval).toEqual({ by: 'owner', date: '2026-10-25', scope: 'development, synthetic data only, pending provider checklist 3.7' });
    expect(Object.isFrozen(AI_MODEL_APPROVALS)).toBe(true);
  });

  it('verified facts (PHASE1_TWENTY_PLAN §3): prices incl. cached input and cache write, tiers, long context, regions', () => {
    expect(entry(AI_HAIKU_MODEL_ID)).toMatchObject({
      provider: 'anthropic',
      providerModelId: 'claude-haiku-5-5',
      tier: 'fast',
      apiKeyEnv: ANTHROPIC_API_KEY_ENV,
      sdkInstalled: true,
      baseURL: ANTHROPIC_FIXED_BASE_URL,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      price: { inputUsdMicrosPerMTok: 100_000, cachedInputUsdMicrosPerMTok: 10_000, cacheWriteUsdMicrosPerMTok: 125_000, outputUsdMicrosPerMTok: 500_000 },
      longContext: { thresholdInputTokens: 100_000, inputUsdMicrosPerMTok: 500_000, cachedInputUsdMicrosPerMTok: 50_000, cacheWriteUsdMicrosPerMTok: 625_000, outputUsdMicrosPerMTok: 2_500_000 },
      region: 'global',
      providerOptions: { anthropic: { effort: 'low' } }, // D12
    });
    // Corrected stale facts: Sonnet cached input is $0.10 (the pricing page), Opus $0.20; both have a cache-write price.
    expect(entry(SONNET)).toMatchObject({ tier: 'smart', price: { inputUsdMicrosPerMTok: 2_000_000, cachedInputUsdMicrosPerMTok: 100_000, cacheWriteUsdMicrosPerMTok: 2_500_000, outputUsdMicrosPerMTok: 10_000_000 }, longContext: null });
    expect(entry(OPUS)).toMatchObject({ tier: 'smart', price: { inputUsdMicrosPerMTok: 4_000_000, cachedInputUsdMicrosPerMTok: 200_000, cacheWriteUsdMicrosPerMTok: 5_000_000, outputUsdMicrosPerMTok: 20_000_000 } });
    // OpenAI: long context now priced (> 272k); EU price = standard + 10% uplift (D14); no SDK in this build (D5).
    expect(entry(LUNA)).toMatchObject({
      tier: 'fast',
      region: 'eu',
      sdkInstalled: false,
      regionalUpliftPercent: 10,
      publishedPriceUsdPerMTok: { input: 0.1, cachedInput: 0.01, cacheWrite: null, output: 0.5 },
      price: { inputUsdMicrosPerMTok: 110_000, cachedInputUsdMicrosPerMTok: 11_000, cacheWriteUsdMicrosPerMTok: null, outputUsdMicrosPerMTok: 550_000 },
      longContext: { thresholdInputTokens: 272_000, inputUsdMicrosPerMTok: 220_000, cachedInputUsdMicrosPerMTok: 22_000, outputUsdMicrosPerMTok: 825_000 },
      contextWindowTokens: 1_050_000,
      maxOutputTokens: 128_000,
    });
    expect(entry(SOL)).toMatchObject({ tier: 'smart', price: { inputUsdMicrosPerMTok: 2_200_000, outputUsdMicrosPerMTok: 11_000_000 }, longContext: { inputUsdMicrosPerMTok: 4_400_000, cachedInputUsdMicrosPerMTok: 220_000, outputUsdMicrosPerMTok: 16_500_000 } });
    expect(chargedMicros(0.1, 10)).toBe(110_000);
    expect(chargedMicros(0.01, 0)).toBe(10_000);
  });

  it('test models are accepted only as in-process `test` entries that do not shadow a production id', () => {
    const t = fake('crewflow-test-x', { provider: 'test', apiKeyEnv: null, baseURL: null });
    expect(validateTestModels([t])[0]!.id).toBe('crewflow-test-x');
    expect(() => validateTestModels([fake('crewflow-test-y')])).toThrow(/not a valid in-process test model/); // provider anthropic
    expect(() => validateTestModels([{ ...t, id: AI_HAIKU_MODEL_ID }])).toThrow();
    expect(() => validateTestModels([{ ...t, apiKeyEnv: ANTHROPIC_API_KEY_ENV }])).toThrow();
  });
});

// ── T-C2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T-C2 availability = approved ∧ in build ∧ keyed ∧ not disabled ∧ environment permits (first failing label)', () => {
  it('with the Anthropic key in development: Haiku Available; Sonnet/Opus Not approved; OpenAI Not approved (first failing)', () => {
    const ctx = ctxOf(devEnv());
    expect(Object.fromEntries(AI_MODEL_CATALOGUE.map((m) => [m.id, modelState(m, ctx)]))).toEqual({
      [AI_HAIKU_MODEL_ID]: 'available',
      [SONNET]: 'not_approved',
      [OPUS]: 'not_approved',
      [LUNA]: 'not_approved',
      [SOL]: 'not_approved',
    });
  });

  it.each([
    ['disabled by AI_MODELS_DEFAULT_DISABLED (before anything else)', devEnv({ AI_MODELS_DEFAULT_DISABLED: `x, ${AI_HAIKU_MODEL_ID}` }), DEV_DB, 'disabled'],
    ['no key', devEnv({ ANTHROPIC_API_KEY: undefined }), DEV_DB, 'key_not_configured'],
    ['the dev flag off', devEnv({ AI_DEV_ALLOW_REAL_PROVIDERS: false }), DEV_DB, 'environment_refused'],
    ['not the development database (guard never ran)', devEnv(), null, 'environment_refused'],
    ['a development runtime on a remote database', devEnv(), { runtimeEnvironment: 'development', classification: 'NON-PRODUCTION' }, 'environment_refused'],
    ['NODE_ENV=test (real providers never run in tests)', devEnv({ NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: false }), DEV_DB, 'environment_refused'],
    ['production (dev-only approval; this build enables no real provider in production)', devEnv({ NODE_ENV: 'production', AI_DEV_ALLOW_REAL_PROVIDERS: false }), DEV_DB, 'environment_refused'],
  ])('Haiku: %s ⇒ %s', (_label, env, db, state) => {
    expect(modelState(entry(AI_HAIKU_MODEL_ID), ctxOf(env, { db: db as typeof DEV_DB | null }))).toBe(state);
  });

  it('an approved model whose SDK is not in this build is "Not in this build"; a deprecated available one is "Deprecated"', () => {
    const ctx = ctxOf(devEnv({ OPENAI_API_KEY: KEY }));
    expect(modelState(fake('openai-approved', { provider: 'openai', approved: true, sdkInstalled: false, apiKeyEnv: 'OPENAI_API_KEY' }), ctx)).toBe('not_in_build');
    expect(modelState(fake('haiku-old', { deprecated: true, approved: true }), ctx)).toBe('deprecated');
  });

  it('in-process test models: available ONLY under NODE_ENV=test (and still disable-able)', () => {
    const t = fake('crewflow-test-m', { provider: 'test', apiKeyEnv: null, baseURL: null });
    expect(modelState(t, ctxOf(devEnv({ NODE_ENV: 'test' })))).toBe('available');
    expect(modelState(t, ctxOf(devEnv()))).toBe('environment_refused');
    expect(modelState(t, ctxOf(devEnv({ NODE_ENV: 'production' })))).toBe('environment_refused');
    expect(modelState(t, ctxOf(devEnv({ NODE_ENV: 'test', AI_MODELS_DEFAULT_DISABLED: 'crewflow-test-m' })))).toBe('disabled');
  });

  it('the retired key alias in production keeps real providers refused (warn + AI unavailable, D2)', () => {
    const r = aiPlatformReadiness(ctxOf(devEnv({ NODE_ENV: 'production', AI_DEV_ALLOW_REAL_PROVIDERS: false }), { legacyKey: true }));
    expect(r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['real_provider_production_not_enabled', 'legacy_key_present']));
    expect(r.realProvidersPermitted).toBe(false);
  });

  it('a provider key is read only for its own provider, never for an in-process model; messages never carry a value', () => {
    expect(providerApiKey(devEnv(), entry(AI_HAIKU_MODEL_ID))).toBe(KEY);
    expect(providerApiKey(devEnv(), entry(LUNA))).toBeNull(); // OPENAI_API_KEY unset
    expect(providerApiKey(devEnv(), fake('t', { provider: 'test', apiKeyEnv: null }))).toBeNull();
    for (const env of [devEnv(), devEnv({ AI_DEV_ALLOW_REAL_PROVIDERS: false }), devEnv({ NODE_ENV: 'test' })]) expect(JSON.stringify(aiPlatformReadiness(ctxOf(env, { db: null })))).not.toContain(KEY);
  });
});

// ── T-C3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T-C3 resolver: org pin → AI_MODELS_DEFAULT_<TIER> → nearest tier → any available → none', () => {
  const A = fake('approved-fast-a', { approved: true, tier: 'fast' });
  const B = fake('approved-fast-b', { approved: true, tier: 'fast', price: { ...entry(AI_HAIKU_MODEL_ID).price, inputUsdMicrosPerMTok: 50_000 } });
  const S = fake('approved-smart-s', { approved: true, tier: 'smart' });
  const catalogue = [...AI_MODEL_CATALOGUE, A, B, S];
  const ctx = (extra: Partial<AiEnvFacts> = {}) => ctxOf(devEnv(extra), { catalogue });

  it('the pin wins (same tier, usable)', () => {
    expect(resolveModel('fast', { fast: A.id }, ctx({ AI_MODELS_DEFAULT_FAST: B.id }))).toEqual({ model: A, source: 'pin' });
  });

  it('a stale pin falls through: unknown id, disabled model, wrong tier, key removed — never returned', () => {
    expect(resolveModel('fast', { fast: 'no-such-model' }, ctx({ AI_MODELS_DEFAULT_FAST: B.id }))).toMatchObject({ model: B, source: 'default' });
    expect(resolveModel('fast', { fast: A.id }, ctx({ AI_MODELS_DEFAULT_DISABLED: A.id, AI_MODELS_DEFAULT_FAST: B.id }))).toMatchObject({ model: B, source: 'default' });
    expect(resolveModel('fast', { fast: S.id }, ctx({ AI_MODELS_DEFAULT_FAST: B.id }))).toMatchObject({ model: B, source: 'default' });
    expect(resolveModel('fast', { fast: A.id }, ctx({ ANTHROPIC_API_KEY: undefined }))).toBeNull();
    expect(resolveModel('fast', { fast: SONNET }, ctx({ AI_MODELS_DEFAULT_FAST: B.id }))).toMatchObject({ model: B }); // pin to an unapproved model is skipped
  });

  it('the env tier list goes in order and skips unusable ids', () => {
    expect(resolveModel('fast', {}, ctx({ AI_MODELS_DEFAULT_FAST: `${SONNET},nope,${B.id},${A.id}` }))).toEqual({ model: B, source: 'default' });
  });

  it('nearest tier: the OTHER tier list when this tier resolves nothing', () => {
    expect(resolveModel('smart', {}, ctx({ AI_MODELS_DEFAULT_SMART: `${OPUS}`, AI_MODELS_DEFAULT_FAST: A.id }))).toEqual({ model: A, source: 'nearest' });
  });

  it('any available: requested tier first, then ascending input price, then catalogue order — approved models only', () => {
    expect(resolveModel('fast', {}, ctx())).toEqual({ model: B, source: 'any' }); // B is the cheapest fast model
    expect(resolveModel('smart', {}, ctx())).toEqual({ model: S, source: 'any' });
    // Against the real catalogue only Haiku can ever be picked (Sonnet/Opus are not approved).
    expect(resolveModel('smart', {}, ctxOf(devEnv()))).toEqual({ model: entry(AI_HAIKU_MODEL_ID), source: 'any' });
  });

  it('none ⇒ null; a disabled model is never returned by any step', () => {
    const disabledAll = { AI_MODELS_DEFAULT_DISABLED: [AI_HAIKU_MODEL_ID, A.id, B.id, S.id].join(','), AI_MODELS_DEFAULT_FAST: A.id, AI_MODELS_DEFAULT_SMART: S.id };
    expect(resolveModel('fast', { fast: A.id, smart: S.id }, ctx(disabledAll))).toBeNull();
    for (const tier of ['fast', 'smart'] as const) {
      for (const pin of [undefined, A.id, S.id, AI_HAIKU_MODEL_ID]) {
        const r = resolveModel(tier, { [tier]: pin }, ctx({ AI_MODELS_DEFAULT_DISABLED: AI_HAIKU_MODEL_ID }));
        expect(r?.model.id).not.toBe(AI_HAIKU_MODEL_ID);
      }
    }
  });

  it('setup needed: provider (no key / environment refuses) vs model (keys exist, nothing approved + enabled)', () => {
    expect(setupNeeded(ctxOf(devEnv({ ANTHROPIC_API_KEY: undefined })))).toBe('provider');
    expect(setupNeeded(ctxOf(devEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: KEY })))).toBe('provider'); // OpenAI SDK not in the build
    expect(setupNeeded(ctxOf(devEnv({ AI_DEV_ALLOW_REAL_PROVIDERS: false })))).toBe('provider');
    expect(setupNeeded(ctxOf(devEnv({ NODE_ENV: 'test' })))).toBe('provider');
    expect(setupNeeded(ctxOf(devEnv({ AI_MODELS_DEFAULT_DISABLED: AI_HAIKU_MODEL_ID })))).toBe('model');
  });
});

// ── T-C4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T-C4 estimated cost: cache-aware, long-context incl. cache tokens, round-up; the worst case bounds every case', () => {
  const haiku = entry(AI_HAIKU_MODEL_ID);
  const u = (input: number, output: number, details?: { noCache?: number; read?: number; write?: number }) => ({
    inputTokens: input,
    outputTokens: output,
    inputTokenDetails: details ? { noCacheTokens: details.noCache, cacheReadTokens: details.read, cacheWriteTokens: details.write } : undefined,
  });

  it('no details: every input token at the input price; rounds UP to the micro', () => {
    expect(stepCostUsdMicros(haiku, u(100_000, 0))).toBe(10_000);
    expect(stepCostUsdMicros(haiku, u(0, 1_000_000))).toBe(500_000);
    expect(stepCostUsdMicros(haiku, u(1, 0))).toBe(1);
    expect(stepCostUsdMicros(haiku, u(0, 0))).toBe(0);
  });

  it('cache-aware: no-cache × input + cache read × cached + cache write × write + output', () => {
    // 10k no-cache @0.10, 50k read @0.01, 20k write @0.125, 1k out @0.50 (total 80k < 100k threshold)
    expect(stepCostUsdMicros(haiku, u(80_000, 1_000, { noCache: 10_000, read: 50_000, write: 20_000 }))).toBe(Math.ceil((10_000 * 100_000 + 50_000 * 10_000 + 20_000 * 125_000 + 1_000 * 500_000) / 1e6));
    // A provider without a cache-write price bills writes as input (never cheaper).
    expect(stepCostUsdMicros(entry(LUNA), u(1_000, 0, { noCache: 0, read: 0, write: 1_000 }))).toBe(Math.ceil((1_000 * 110_000) / 1e6));
  });

  it('the long-context row applies to the whole call when the prompt INCLUDING cache tokens passes the threshold', () => {
    const cost = stepCostUsdMicros(haiku, u(120_000, 1_000, { noCache: 20_000, read: 100_000, write: 0 }));
    expect(cost).toBe(Math.ceil((20_000 * 500_000 + 100_000 * 50_000 + 1_000 * 2_500_000) / 1e6));
    expect(stepCostUsdMicros(haiku, u(100_000, 1_000))).toBe(10_000 + 500);
  });

  it('inconsistent details (more detail tokens than the total) are priced at max(input, cacheWrite) — never below the actual', () => {
    expect(stepCostUsdMicros(haiku, u(1_000, 0, { noCache: 0, read: 900, write: 900 }))).toBe(Math.ceil((1_800 * 125_000) / 1e6));
  });

  it('the worst case is ≥ the actual cost for EVERY detail combination within the bound (and caps at the context window)', () => {
    for (const model of AI_MODEL_CATALOGUE) {
      for (const maxInput of [0, 1, 5_000, 99_999, 100_001, 272_001, 900_000]) {
        const worst = worstCaseStepUsdMicros(model, maxInput, 1_500);
        const steps = [0, 0.25, 0.5, 1];
        for (const a of steps) for (const b of steps) for (const c of steps) {
          const read = Math.floor(maxInput * a);
          const write = Math.floor((maxInput - read) * b);
          const noCache = Math.floor((maxInput - read - write) * c);
          for (const out of [0, 1_500]) {
            expect(worst).toBeGreaterThanOrEqual(stepCostUsdMicros(model, u(noCache + read + write, out, { noCache, read, write })));
            expect(worst).toBeGreaterThanOrEqual(stepCostUsdMicros(model, u(noCache + read + write, out)));
          }
        }
      }
    }
    expect(worstCaseStepUsdMicros(haiku, 5_000_000, 0)).toBe(worstCaseStepUsdMicros(haiku, 1_000_000, 0));
    expect(worstCaseStepUsdMicros(haiku, maxInputTokensFromBytes(10_000), 1_500)).toBe(Math.ceil((12_048 * 125_000 + 1_500 * 500_000) / 1e6));
    expect(usdToMicros(2)).toBe(2_000_000);
    expect(() => usdToMicros(0)).toThrow();
  });
});

// ── T-B1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('T-B1 boot: only deliberate stand-ins and the retired key name refuse; everything else fails closed at runtime', () => {
  const legacy = (raw: Record<string, string | undefined>) => legacyAiEnvFacts((n) => raw[n]);

  it('the mock stand-in refuses in development and production, never in test', () => {
    for (const raw of [{ AI_PROVIDER: 'mock' }, { AI_MODEL: 'crewflow-mock-1' }, { AI_PROVIDER: 'MOCK', AI_MODEL: 'anything' }]) {
      expect(aiBootProblems({ NODE_ENV: 'development', AI_DEV_ALLOW_REAL_PROVIDERS: false }, legacy(raw))[0]).toMatch(/test-only/);
      expect(aiBootProblems({ NODE_ENV: 'production', AI_DEV_ALLOW_REAL_PROVIDERS: false }, legacy(raw))[0]).toMatch(/test-only/);
      expect(aiBootProblems({ NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: false }, legacy(raw))).toEqual([]);
    }
    expect(() => validate({ ...BASE, NODE_ENV: 'development', AI_PROVIDER: 'mock', AI_MODEL: 'crewflow-mock-1' })).toThrow(/mock model, which is test-only/);
    expect(() => validate({ ...BASE, NODE_ENV: 'production', AI_PROVIDER: 'mock' })).toThrow(/test-only/);
    expect(() => validate({ ...BASE, NODE_ENV: 'test', AI_PROVIDER: 'mock', AI_MODEL: 'crewflow-mock-1' })).not.toThrow();
  });

  it('AI_PROVIDER_API_KEY refuses in development and test with a rename message; production only warns until D2 is confirmed', () => {
    const raw = { AI_PROVIDER_API_KEY: 'sk-'.padEnd(30, 'x') };
    expect(aiBootProblems({ NODE_ENV: 'development', AI_DEV_ALLOW_REAL_PROVIDERS: false }, legacy(raw))[0]).toMatch(/renamed: put the Anthropic key in ANTHROPIC_API_KEY/);
    expect(aiBootProblems({ NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: false }, legacy(raw))).toHaveLength(1);
    expect(PRODUCTION_LEGACY_AI_ENV_REFUSAL_CONFIRMED).toBe(false);
    expect(aiBootProblems({ NODE_ENV: 'production', AI_DEV_ALLOW_REAL_PROVIDERS: false }, legacy(raw))).toEqual([]);
    expect(aiConfigurationWarnings(devEnv({ NODE_ENV: 'production' }), legacy(raw)).join(' ')).toMatch(/AI_PROVIDER_API_KEY is no longer read/);
    let message = '';
    try {
      validate({ ...BASE, NODE_ENV: 'development', ...raw });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/AI_PROVIDER_API_KEY was renamed/);
    expect(message).not.toContain(raw.AI_PROVIDER_API_KEY);
  });

  it('other legacy values are ignored with a names-only warning (never a value)', () => {
    const facts = legacy({ AI_PROVIDER: 'anthropic', AI_MODEL: AI_HAIKU_MODEL_ID });
    expect(aiBootProblems({ NODE_ENV: 'development', AI_DEV_ALLOW_REAL_PROVIDERS: false }, facts)).toEqual([]);
    const warnings = aiConfigurationWarnings(devEnv(), facts).join(' ');
    expect(warnings).toMatch(/AI_PROVIDER \/ AI_MODEL are no longer read/);
    expect(warnings).not.toContain(AI_HAIKU_MODEL_ID);
    expect(() => validate({ ...BASE, NODE_ENV: 'development', AI_PROVIDER: 'anthropic', AI_MODEL: AI_HAIKU_MODEL_ID })).not.toThrow();
    expect(aiConfigurationWarnings(devEnv({ AI_MODELS_DEFAULT_FAST: 'nope,also-nope', AI_MODELS_DEFAULT_SMART: AI_HAIKU_MODEL_ID }))).toEqual(['AI_MODELS_DEFAULT_FAST lists 2 id(s) that are not in the model catalogue (ignored).']);
  });

  it('AI_DEV_ALLOW_REAL_PROVIDERS=true refuses to boot in test and production, never in development', () => {
    expect(aiBootProblems({ NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: true })).toHaveLength(1);
    expect(aiBootProblems({ NODE_ENV: 'production', AI_DEV_ALLOW_REAL_PROVIDERS: true })).toHaveLength(1);
    expect(aiBootProblems({ NODE_ENV: 'development', AI_DEV_ALLOW_REAL_PROVIDERS: true })).toEqual([]);
    expect(() => validate({ ...BASE, NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: 'true' })).toThrow(/AI_DEV_ALLOW_REAL_PROVIDERS=true is a development-only switch/);
  });

  it('a missing key, nothing approved or an unknown default id does NOT stop the boot (AI is "not configured" instead)', () => {
    for (const extra of [{}, { AI_MODELS_DEFAULT_FAST: 'no-such-model' }, { AI_MODELS_DEFAULT_DISABLED: AI_HAIKU_MODEL_ID }, { ANTHROPIC_API_KEY: KEY, AI_MODELS_DEFAULT_SMART: OPUS }]) {
      expect(() => validate({ ...BASE, NODE_ENV: 'development', AI_ENABLED: 'true', ...extra })).not.toThrow();
    }
  });

  it('a malformed key refuses to boot without echoing it — for every provider key name', () => {
    const bad = 'canary key with spaces 0123456789';
    for (const name of AI_PROVIDER_KEY_ENVS) {
      let message = '';
      try {
        validate({ ...BASE, [name]: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(bad);
    }
    expect(() => validate({ ...BASE, AI_MODELS_DEFAULT_FAST: 'Not An Id!' })).toThrow(/AI_MODELS_DEFAULT_FAST must be comma-separated model ids/);
  });

  it('the retired names are no longer schema properties', () => {
    const source = fs.readFileSync(path.join(__dirname, '../../environment/environment-variables.ts'), 'utf8');
    for (const name of ['AI_PROVIDER', 'AI_MODEL', 'AI_PROVIDER_API_KEY']) expect(source).not.toMatch(new RegExp(`^\\s{2}${name}[!?]?:`, 'm'));
  });
});
