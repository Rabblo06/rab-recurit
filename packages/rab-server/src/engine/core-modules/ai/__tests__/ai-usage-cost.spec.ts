import { AI_PROMPT_CACHE_MODES } from '@rab/shared';

import { AI_HAIKU_MODEL_ID, AI_MODEL_CATALOGUE, AI_MODELS_FILE_SCHEMA, AI_PROMPT_CACHE_MODE_SCHEMA, catalogueEntry, loadAiModelCatalogue, promptCacheFitsProvider } from '../models/catalog';
import { AiStepUsage, stepCostUsdMicros, stepTokenSplit, turnCostBreakdown, worstCaseStepUsdMicros } from '../models/cost';
import RAW from '../models/ai-models.json';

/**
 * Phase 7a cost and catalogue facts (PHASE7_TWENTY_PLAN §2.3 / §2.4 / §5):
 *   T7-M2  the worst-case reservation is ≥ the actual cost for EVERY {noCache, cacheRead, cacheWrite} split (caching on);
 *          `turnCostBreakdown` sums exactly what the meter settles;
 *   facts  `promptCache` is a closed zod enum, required, provider-consistent: Haiku / Sonnet / Opus `anthropic-auto`,
 *          everything else `none`.
 */
const raw = RAW as { models: Array<Record<string, unknown>> };

describe('T7-M2 worst case ≥ actual for every cache split', () => {
  const splits = (total: number): Array<[number, number, number]> => {
    const out: Array<[number, number, number]> = [];
    const step = Math.max(1, Math.floor(total / 10));
    for (let read = 0; read <= total; read += step) for (let write = 0; read + write <= total; write += step) out.push([total - read - write, read, write]);
    return out;
  };

  for (const model of AI_MODEL_CATALOGUE) {
    it(`${model.id}: every split of a prompt, below and above the long-context threshold, both output extremes`, () => {
      const totals = [1, 1_000, 99_999, model.longContext ? model.longContext.thresholdInputTokens + 1 : 150_000, 400_000];
      for (const total of totals) {
        const worst = worstCaseStepUsdMicros(model, total, 4_000);
        for (const [noCache, read, write] of splits(total)) {
          for (const output of [0, 4_000]) {
            const usage: AiStepUsage = { inputTokens: total, outputTokens: output, inputTokenDetails: { noCacheTokens: noCache, cacheReadTokens: read, cacheWriteTokens: write } };
            expect({ id: model.id, total, noCache, read, write, output, ok: stepCostUsdMicros(model, usage) <= worst }).toMatchObject({ ok: true });
          }
        }
        // Details that do not add up are distrusted and still bounded.
        const odd: AiStepUsage = { inputTokens: total, outputTokens: 4_000, inputTokenDetails: { noCacheTokens: total, cacheReadTokens: total, cacheWriteTokens: 0 } };
        expect(stepCostUsdMicros(model, odd)).toBeLessThanOrEqual(worstCaseStepUsdMicros(model, total * 2, 4_000));
      }
    });
  }
});

describe('stepTokenSplit / turnCostBreakdown (persisted counts)', () => {
  const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;

  it('no details ⇒ all no-cache; details ⇒ as reported; inconsistent details ⇒ the larger total, never below the report', () => {
    expect(stepTokenSplit({ inputTokens: 100, outputTokens: 7 })).toEqual({ noCacheInputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 7 });
    expect(stepTokenSplit({ inputTokens: 100, outputTokens: 7, inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 60, cacheWriteTokens: 30 } })).toEqual({
      noCacheInputTokens: 10,
      cachedInputTokens: 60,
      cacheWriteTokens: 30,
      outputTokens: 7,
    });
    expect(stepTokenSplit({ inputTokens: 100, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 60 } })).toMatchObject({ noCacheInputTokens: 40, cachedInputTokens: 60 });
    const odd = stepTokenSplit({ inputTokens: 100, outputTokens: 0, inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 0 } });
    expect(odd.noCacheInputTokens + odd.cachedInputTokens + odd.cacheWriteTokens).toBe(100);
    expect(stepTokenSplit({ inputTokens: undefined, outputTokens: undefined })).toEqual({ noCacheInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
    expect(stepTokenSplit({ inputTokens: -5, outputTokens: Number.NaN })).toEqual({ noCacheInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  });

  it('sums the steps; cost = Σ stepCostUsdMicros (what the meter settled), integer micro-USD', () => {
    const steps: AiStepUsage[] = [
      { inputTokens: 2_000, outputTokens: 300, inputTokenDetails: { noCacheTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      { inputTokens: 2_600, outputTokens: 120, inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 2_000, cacheWriteTokens: 500 } },
      { inputTokens: 900, outputTokens: 50 },
    ];
    const b = turnCostBreakdown(haiku, steps);
    expect(b).toEqual({
      noCacheInputTokens: 3_000,
      cachedInputTokens: 2_000,
      cacheWriteTokens: 500,
      outputTokens: 470,
      inputTokens: 5_500,
      costUsdMicros: steps.reduce((s, u) => s + stepCostUsdMicros(haiku, u), 0),
      steps: 3,
    });
    expect(Number.isInteger(b.costUsdMicros)).toBe(true);
    expect(turnCostBreakdown(haiku, [])).toEqual({ noCacheInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, inputTokens: 0, costUsdMicros: 0, steps: 0 });
  });
});

describe('promptCache catalogue fact', () => {
  it('Haiku, Sonnet and Opus are anthropic-auto; every other entry is none; every entry states it', () => {
    const modes = Object.fromEntries(AI_MODEL_CATALOGUE.map((m) => [m.id, m.promptCache]));
    expect(modes).toEqual({
      'anthropic-claude-haiku-5-5': 'anthropic-auto',
      'anthropic-claude-sonnet-5-5': 'anthropic-auto',
      'anthropic-claude-opus-5-5': 'anthropic-auto',
      'openai-gpt-6-luna-eu': 'none',
      'openai-gpt-6.1-sol-eu': 'none',
    });
    for (const m of raw.models) expect(Object.keys(m)).toContain('promptCache');
  });

  it('the schema is a closed enum equal to AI_PROMPT_CACHE_MODES; missing, unknown or provider-inconsistent values refuse to load', () => {
    expect([...AI_PROMPT_CACHE_MODE_SCHEMA.options].sort()).toEqual([...AI_PROMPT_CACHE_MODES].sort());
    const withFirst = (patch: Record<string, unknown> | ((m: Record<string, unknown>) => void)) => {
      const copy = JSON.parse(JSON.stringify(RAW)) as { models: Array<Record<string, unknown>> };
      if (typeof patch === 'function') patch(copy.models[0]!);
      else Object.assign(copy.models[0]!, patch);
      return copy;
    };
    expect(() => loadAiModelCatalogue(withFirst((m) => delete m.promptCache))).toThrow(/promptCache/);
    expect(() => loadAiModelCatalogue(withFirst({ promptCache: 'anthropic-1h' }))).toThrow(/promptCache/);
    expect(() => loadAiModelCatalogue(withFirst({ promptCache: 'openai-key' }))).toThrow(/does not fit provider anthropic/);
    // No lifetime knob can be smuggled in next to it (the schema is strict).
    expect(AI_MODELS_FILE_SCHEMA.safeParse(withFirst({ promptCacheTtl: '1h' })).success).toBe(false);
    expect(promptCacheFitsProvider('anthropic-auto', 'openai')).toBe(false);
    expect(promptCacheFitsProvider('none', 'anthropic')).toBe(true);
    expect(promptCacheFitsProvider('openai-key', 'openai')).toBe(true);
  });
});
