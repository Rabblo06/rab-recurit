import type { LanguageModelV3 } from '@ai-sdk/provider';

import { AiCatalogueModel } from '../../../engine/core-modules/ai/models/catalog';
import { AiLanguageModelFactory, defaultAiLanguageModelFactory } from '../../../modules/ai/gateway/model-gateway.service';
import { DeterministicMockModel } from './deterministic-mock-model';

/**
 * TEST-ONLY model catalogue extension (docs/ai/PHASE1_TWENTY_PLAN.md §5). A test module provides these through
 * `overrideProvider(AI_TEST_MODEL_CATALOGUE).useValue(TEST_MODEL_CATALOGUE)` and the factory below through
 * `overrideProvider(AI_LANGUAGE_MODEL_FACTORY)`. The server honours the catalogue only when NODE_ENV=test, and only
 * `provider: 'test'` entries with no key and no endpoint (catalog.ts `validateTestModels`). Nothing here is in `dist`.
 */
export const TEST_MOCK_MODEL_ID = 'crewflow-mock-1';
export const TEST_SMART_MODEL_ID = 'crewflow-mock-smart-1';

export function testModel(overrides: Partial<AiCatalogueModel> & Pick<AiCatalogueModel, 'id'>): AiCatalogueModel {
  return {
    provider: 'test',
    providerModelId: overrides.id,
    label: `Test model ${overrides.id}`,
    tier: 'fast',
    apiKeyEnv: null,
    sdkInstalled: true,
    baseURL: null,
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    price: { inputUsdMicrosPerMTok: 0, cachedInputUsdMicrosPerMTok: 0, cacheWriteUsdMicrosPerMTok: null, outputUsdMicrosPerMTok: 0 },
    longContext: null,
    publishedPriceUsdPerMTok: { input: 0, cachedInput: 0, cacheWrite: null, output: 0 },
    regionalUpliftPercent: 0,
    region: 'global',
    dataRegion: 'In-process test model, no network.',
    providerOptions: null,
    deprecated: false,
    approved: false,
    approval: null,
    productionApproved: false,
    sources: ['packages/rab-server/src/__tests__/support/ai/deterministic-mock-model.ts'],
    verifiedAt: '2026-10-25',
    ...overrides,
  };
}

/** The deterministic in-process model on the `fast` tier (what chat resolves to in the AI suites) plus a `smart` one. */
export const TEST_MODEL_CATALOGUE: readonly AiCatalogueModel[] = Object.freeze([
  testModel({ id: TEST_MOCK_MODEL_ID, label: 'Crewflow deterministic test model', tier: 'fast' }),
  testModel({ id: TEST_SMART_MODEL_ID, label: 'Crewflow deterministic test model (smart)', tier: 'smart' }),
]);

/** The default test factory: the deterministic mock for `test` entries, the real (keyed) provider factory otherwise. */
export const testModelFactory: AiLanguageModelFactory = (model, apiKey): LanguageModelV3 =>
  model.provider === 'test' ? new DeterministicMockModel(model.id) : defaultAiLanguageModelFactory(model, apiKey);
