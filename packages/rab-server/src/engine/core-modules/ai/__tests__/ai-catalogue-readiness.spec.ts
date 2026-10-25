import { validate } from '../../environment/env.validation';
import { aiBootProblems, aiConfigurationWarnings, AiEnvFacts, aiReadiness, AiReadinessCode, approvedModelIds, resolveProviderApiKey } from '../ai-readiness';
import { AI_CATALOGUE_IDS, AI_DEFAULT_MODEL_ID, AI_HAIKU_MODEL_ID, AI_MODEL_CATALOGUE, catalogueEntry } from '../models/catalog';
import { maxInputTokensFromBytes, stepCostUsdMicros, usdToMicros, worstCaseStepUsdMicros } from '../models/cost';
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_FIXED_BASE_URL } from '../models/provider-keys';

const KEY = 'test-only-anthropic-key-'.padEnd(40, 'x');
const DEV_DB = { runtimeEnvironment: 'development', classification: 'LOCAL' };
const devReal = (extra: Partial<AiEnvFacts> = {}): AiEnvFacts => ({
  NODE_ENV: 'development',
  AI_ENABLED: true,
  AI_MODEL: AI_HAIKU_MODEL_ID,
  ANTHROPIC_API_KEY: KEY,
  AI_DEV_ALLOW_REAL_PROVIDERS: true,
  ...extra,
});
const codes = (env: AiEnvFacts, db: typeof DEV_DB | null = DEV_DB) => aiReadiness(env, db).problems.map((p) => p.code);

describe('AI model catalogue (code, frozen, owner approvals)', () => {
  it('ids are unique, regex-safe and the list is frozen', () => {
    expect(new Set(AI_CATALOGUE_IDS).size).toBe(AI_CATALOGUE_IDS.length);
    for (const id of AI_CATALOGUE_IDS) expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,99}$/);
    expect(Object.isFrozen(AI_MODEL_CATALOGUE)).toBe(true);
    for (const m of AI_MODEL_CATALOGUE) {
      expect(Object.isFrozen(m)).toBe(true);
      expect(Object.isFrozen(m.price)).toBe(true);
      expect(Number.isInteger(m.price.inputUsdMicrosPerMTok) && Number.isInteger(m.price.outputUsdMicrosPerMTok)).toBe(true);
      expect(m.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(m.sources.length).toBeGreaterThan(0);
    }
  });

  it('exactly ONE model is approved: Claude Haiku 5.5, development + synthetic data only; NOTHING is production-approved', () => {
    expect(approvedModelIds()).toEqual([AI_HAIKU_MODEL_ID]);
    expect(AI_MODEL_CATALOGUE.filter((m) => m.productionApproved)).toEqual([]);
    const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;
    expect(haiku.approval).toEqual({ by: 'owner', date: '2026-10-25', scope: 'development, synthetic data only, pending provider checklist 3.7' });
    expect(AI_DEFAULT_MODEL_ID).toBe(AI_HAIKU_MODEL_ID);
  });

  it('Claude Haiku 5.5 carries its verified facts, a fixed endpoint and its source', () => {
    const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;
    expect(haiku).toMatchObject({
      provider: 'anthropic',
      providerModelId: 'claude-haiku-5-5',
      apiKeyEnv: ANTHROPIC_API_KEY_ENV,
      baseURL: ANTHROPIC_FIXED_BASE_URL,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
      price: { inputUsdMicrosPerMTok: 100_000, outputUsdMicrosPerMTok: 500_000 },
      longContext: { thresholdInputTokens: 100_000, inputUsdMicrosPerMTok: 500_000, outputUsdMicrosPerMTok: 2_500_000 },
      verifiedAt: '2026-10-25',
    });
    expect(haiku.sources).toEqual(expect.arrayContaining(['https://platform.claude.com/docs/en/about-claude/pricing']));
    expect(ANTHROPIC_FIXED_BASE_URL).toBe('https://api.anthropic.com/v1');
  });
});

describe('AI readiness (fail closed, never crash)', () => {
  it('the approved, keyed model is ready only when EVERY development condition holds', () => {
    expect(aiReadiness(devReal(), DEV_DB)).toMatchObject({ ready: true, realProvider: true, modelId: AI_HAIKU_MODEL_ID, problems: [] });
  });

  it.each([
    ['AI switched off', devReal({ AI_ENABLED: false }), AiReadinessCode.DISABLED],
    ['unknown model id', devReal({ AI_MODEL: 'claude-unknown' }), AiReadinessCode.MODEL_UNKNOWN],
    ['unapproved model (Sonnet)', devReal({ AI_MODEL: 'anthropic-claude-sonnet-5-5' }), AiReadinessCode.MODEL_NOT_APPROVED],
    ['unapproved model (Opus)', devReal({ AI_MODEL: 'anthropic-claude-opus-5-5' }), AiReadinessCode.MODEL_NOT_APPROVED],
    ['no SDK in this build (OpenAI)', devReal({ AI_MODEL: 'openai-gpt-6-luna-eu' }), AiReadinessCode.SDK_MISSING],
    ['no key', devReal({ ANTHROPIC_API_KEY: undefined }), AiReadinessCode.KEY_MISSING],
    ['disabled by AI_MODELS_DEFAULT_DISABLED', devReal({ AI_MODELS_DEFAULT_DISABLED: `x,${AI_HAIKU_MODEL_ID}` }), AiReadinessCode.MODEL_DISABLED],
    ['dev flag missing', devReal({ AI_DEV_ALLOW_REAL_PROVIDERS: false }), AiReadinessCode.DEV_FLAG_MISSING],
    ['AI_PROVIDER disagrees with the catalogue', devReal({ AI_PROVIDER: 'mock' }), AiReadinessCode.PROVIDER_MISMATCH],
    ['NODE_ENV=test', devReal({ NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: false }), AiReadinessCode.REAL_PROVIDER_REFUSED_IN_TEST],
    ['production with a dev-only approval', devReal({ NODE_ENV: 'production', AI_DEV_ALLOW_REAL_PROVIDERS: false }), AiReadinessCode.MODEL_NOT_PRODUCTION_APPROVED],
  ])('%s ⇒ not ready (%s)', (_label, env, code) => {
    const r = aiReadiness(env, DEV_DB);
    expect(r.ready).toBe(false);
    expect(r.problems.map((p) => p.code)).toContain(code);
  });

  it.each([
    ['the runtime guard never ran (CLI, Jest)', null],
    ['a non-production runtime that is not declared development', { runtimeEnvironment: 'non-production', classification: 'LOCAL' }],
    ['a development runtime on a remote database', { runtimeEnvironment: 'development', classification: 'NON-PRODUCTION' }],
    ['production', { runtimeEnvironment: 'production', classification: 'PRODUCTION' }],
  ])('a real provider refuses a database that is not the development database: %s', (_label, db) => {
    expect(codes(devReal(), db)).toContain(AiReadinessCode.NOT_DEVELOPMENT_DATABASE);
  });

  it('the in-process mock needs no key, flag or development database, and never takes a key', () => {
    expect(aiReadiness({ NODE_ENV: 'test', AI_ENABLED: true, AI_PROVIDER: 'mock', AI_MODEL: 'crewflow-mock-1', AI_DEV_ALLOW_REAL_PROVIDERS: false }, null).ready).toBe(true);
    expect(codes({ NODE_ENV: 'test', AI_ENABLED: true, AI_PROVIDER: 'mock', AI_MODEL: 'crewflow-mock-1', AI_PROVIDER_API_KEY: KEY, AI_DEV_ALLOW_REAL_PROVIDERS: false }, null)).toContain(AiReadinessCode.MOCK_WITH_KEY);
  });

  it('readiness messages never contain a key value', () => {
    const all = [devReal({ AI_DEV_ALLOW_REAL_PROVIDERS: false }), devReal({ NODE_ENV: 'test' }), devReal({ AI_PROVIDER: 'anthropic', AI_PROVIDER_API_KEY: `${KEY}-other` })];
    for (const env of all) expect(JSON.stringify(aiReadiness(env, null))).not.toContain(KEY);
  });
});

describe('boot refusals (only the hard ones)', () => {
  const BASE = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', APP_SECRET: 'a'.repeat(40) };

  it('AI_DEV_ALLOW_REAL_PROVIDERS=true refuses to boot in test and production, never in development', () => {
    expect(aiBootProblems({ NODE_ENV: 'test', AI_ENABLED: false, AI_DEV_ALLOW_REAL_PROVIDERS: true })).toHaveLength(1);
    expect(aiBootProblems({ NODE_ENV: 'production', AI_ENABLED: false, AI_DEV_ALLOW_REAL_PROVIDERS: true })).toHaveLength(1);
    expect(aiBootProblems({ NODE_ENV: 'development', AI_ENABLED: true, AI_DEV_ALLOW_REAL_PROVIDERS: true })).toEqual([]);
    expect(() => validate({ ...BASE, NODE_ENV: 'test', AI_DEV_ALLOW_REAL_PROVIDERS: 'true' })).toThrow(/AI_DEV_ALLOW_REAL_PROVIDERS=true is a development-only switch/);
  });

  it('production refuses the mock at boot', () => {
    expect(aiBootProblems({ NODE_ENV: 'production', AI_ENABLED: false, AI_PROVIDER: 'mock', AI_DEV_ALLOW_REAL_PROVIDERS: false })[0]).toMatch(/must not be configured in production/);
    expect(aiBootProblems({ NODE_ENV: 'production', AI_ENABLED: true, AI_MODEL: 'crewflow-mock-1', AI_DEV_ALLOW_REAL_PROVIDERS: false })[0]).toMatch(/must not be configured in production/);
  });

  it('an unapproved, keyless or unknown model does NOT stop the boot (AI is unavailable instead)', () => {
    for (const extra of [{ AI_MODEL: 'anthropic-claude-opus-5-5' }, { AI_MODEL: AI_HAIKU_MODEL_ID }, { AI_MODEL: 'no-such-model' }]) {
      expect(() => validate({ ...BASE, NODE_ENV: 'development', AI_ENABLED: 'true', ...extra })).not.toThrow();
    }
  });

  it('a malformed key refuses to boot without echoing it', () => {
    const bad = 'canary key with spaces 0123456789';
    let message = '';
    try {
      validate({ ...BASE, ANTHROPIC_API_KEY: bad });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/ANTHROPIC_API_KEY/);
    expect(message).not.toContain(bad);
  });
});

describe('deprecated AI_PROVIDER_API_KEY alias (REAL_PROVIDER_PLAN conflict j)', () => {
  const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;

  it('is used only when AI_PROVIDER names the provider and the provider key is unset — with a names-only warning', () => {
    const env = devReal({ ANTHROPIC_API_KEY: undefined, AI_PROVIDER: 'anthropic', AI_PROVIDER_API_KEY: KEY });
    expect(resolveProviderApiKey(env, haiku)).toEqual({ key: KEY, conflict: false });
    const warnings = aiConfigurationWarnings(env);
    expect(warnings.join(' ')).toMatch(/AI_PROVIDER_API_KEY is deprecated: it is being used as ANTHROPIC_API_KEY/);
    expect(warnings.join(' ')).not.toContain(KEY);
  });

  it('is ignored (with a warning) when AI_PROVIDER does not name a real provider', () => {
    const env = devReal({ ANTHROPIC_API_KEY: undefined, AI_PROVIDER_API_KEY: KEY });
    expect(resolveProviderApiKey(env, haiku)).toEqual({ key: null, conflict: false });
    expect(aiConfigurationWarnings(env).join(' ')).toMatch(/deprecated and ignored/);
  });

  it('two different keys are a conflict: no key, AI unavailable', () => {
    const env = devReal({ AI_PROVIDER: 'anthropic', AI_PROVIDER_API_KEY: `${KEY}-different` });
    expect(resolveProviderApiKey(env, haiku)).toEqual({ key: null, conflict: true });
    expect(codes(env)).toContain(AiReadinessCode.KEY_CONFLICT);
  });
});

describe('estimated cost (integer micro-USD, never money/pence)', () => {
  const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;

  it('prices a step from catalogue prices, rounding UP to the micro', () => {
    expect(stepCostUsdMicros(haiku, 100_000, 0)).toBe(10_000); // $0.10 per MTok in (at the 100k threshold)
    expect(stepCostUsdMicros(haiku, 0, 1_000_000)).toBe(500_000); // $0.50 per MTok out
    expect(stepCostUsdMicros(haiku, 1, 0)).toBe(1); // 0.1 micro rounds up
    expect(stepCostUsdMicros(haiku, 0, 0)).toBe(0);
    expect(stepCostUsdMicros(catalogueEntry('crewflow-mock-1')!, 1_000_000, 1_000_000)).toBe(0);
  });

  it('applies the long-context tier to the whole call above 100k prompt tokens', () => {
    expect(stepCostUsdMicros(haiku, 100_000, 1_000)).toBe(10_000 + 500);
    expect(stepCostUsdMicros(haiku, 100_001, 1_000)).toBe(Math.ceil((100_001 * 500_000 + 1_000 * 2_500_000) / 1_000_000));
  });

  it('the worst case covers the input upper bound plus the full output allowance, capped at the context window', () => {
    expect(worstCaseStepUsdMicros(haiku, maxInputTokensFromBytes(10_000), 1_500)).toBe(stepCostUsdMicros(haiku, 12_048, 1_500));
    expect(worstCaseStepUsdMicros(haiku, 5_000_000, 0)).toBe(stepCostUsdMicros(haiku, 1_000_000, 0));
    expect(stepCostUsdMicros(haiku, 1_000_000, 0)).toBe(500_000); // long-context input rate
    expect(usdToMicros(2)).toBe(2_000_000);
    expect(() => usdToMicros(0)).toThrow();
  });
});
