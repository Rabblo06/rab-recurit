/**
 * AI Phase 7b at the gateway, with NO network (in-process `MockLanguageModelV3` only):
 *   - prepareStep order: the context budget FIRST (older tool results replaced by the fixed stub, never summarised; nothing
 *     left to trim ⇒ `context_full` BEFORE any request), then the reservation sized on exactly what is sent;
 *   - automatic prompt caching (`anthropic-auto`) ONLY for a real provider in development on the EX-1 path, or a test
 *     model under NODE_ENV=test — never production, never without the synthetic clearance, never a lifetime key (T7-G1).
 */
import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { ModelMessage, simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AiRuntimeDatabaseFacts } from '../../../engine/core-modules/ai/ai-readiness';
import { AI_HAIKU_MODEL_ID, AiCatalogueModel, catalogueEntry } from '../../../engine/core-modules/ai/models/catalog';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { TEST_MOCK_MODEL_ID, testModel } from '../../../__tests__/support/ai/test-catalogue';
import { AI_CONTEXT_OMITTED_MARKER } from '../gateway/context-budget';
import { AiBeforeStepInfo, AiStepRefusedError, ModelGatewayService, promptCachePermitted } from '../gateway/model-gateway.service';
import { AiConfigService } from '../services/ai-config.service';

const DEV_DB: AiRuntimeDatabaseFacts = { runtimeEnvironment: 'development', classification: 'LOCAL' };

function config(values: Record<string, unknown>, testModels: readonly AiCatalogueModel[] | null): AiConfigService {
  const all: Record<string, unknown> = { NODE_ENV: 'test', AI_ENABLED: true, AI_MAX_OUTPUT_TOKENS: 1500, AI_MAX_STEPS: 8, AI_ORG_DAILY_TOKEN_BUDGET: 200_000, AI_TURN_TIMEOUT_SECONDS: 30, AI_DAILY_BUDGET_USD: 2, AI_DEV_ALLOW_REAL_PROVIDERS: false, ...values };
  const env = { get: (key: string) => all[key] } as unknown as EnvironmentService;
  const c = new AiConfigService(env, testModels);
  jest.spyOn(c, 'runtimeDatabase').mockReturnValue(DEV_DB);
  return c;
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const textStep: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'ok' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];
function answering() {
  const seen: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (o: LanguageModelV3CallOptions) => {
      seen.push(o);
      return { stream: simulateReadableStream({ chunks: textStep, chunkDelayInMs: null, initialDelayInMs: null }) };
    },
  });
  return { model: model as unknown as LanguageModelV3, seen };
}
async function drain(result: ReturnType<ModelGatewayService['stream']>) {
  try {
    for await (const part of result.fullStream) void part;
  } catch {
    // a refused step surfaces through the stream; the assertions read what was (not) sent
  }
}

const CACHED = testModel({ id: 'crewflow-mock-cache-1', promptCache: 'anthropic-auto' });
const PLAIN = testModel({ id: TEST_MOCK_MODEL_ID });
/** A small window (limit 0.8 × 5 000 = 4 000 tokens, of which the framing allowance alone is 2 048): the budget has to work. */
const SMALL = testModel({ id: 'crewflow-mock-small-1', contextWindowTokens: 5_000 });

const base = (model: AiCatalogueModel, messages: ModelMessage[], extra: Record<string, unknown> = {}) => ({
  model,
  system: 'You are a test.',
  messages,
  tools: {},
  abortSignal: new AbortController().signal,
  realProviderPermitted: false,
  ...extra,
});

/** An older tool call + a large result, then the newest call + its (protected) result, then the question. */
function historyWithToolResults(bigChars: number): ModelMessage[] {
  const call = (id: string) => ({ role: 'assistant' as const, content: [{ type: 'tool-call' as const, toolCallId: id, toolName: 'execute_tool', input: {} }] });
  const result = (id: string, text: string) => ({ role: 'tool' as const, content: [{ type: 'tool-result' as const, toolCallId: id, toolName: 'execute_tool', output: { type: 'json' as const, value: { rows: text } } }] });
  return [{ role: 'user', content: 'first' }, call('c1'), result('c1', 'x'.repeat(bigChars)), call('c2'), result('c2', 'newest'), { role: 'user', content: 'and now?' }];
}

describe('7b prompt caching is permitted only on the development EX-1 path or a test model under NODE_ENV=test', () => {
  const haiku = catalogueEntry(AI_HAIKU_MODEL_ID)!;
  const realAuto = { ...haiku, promptCache: 'anthropic-auto' as const };
  it.each([
    ['real, development, synthetic clearance', realAuto, 'development', true, true],
    ['real, development, NO clearance', realAuto, 'development', false, false],
    ['real, production (even with clearance)', realAuto, 'production', true, false],
    ['real, test', realAuto, 'test', true, false],
    ['test model, test', CACHED, 'test', false, true],
    ['test model, development', CACHED, 'development', true, false],
    ['test model, production', CACHED, 'production', true, false],
    ['model without the anthropic-auto fact', PLAIN, 'test', true, false],
  ])('%s', (_label, entry, nodeEnv, realProviderPermitted, expected) => {
    expect(promptCachePermitted(entry, { nodeEnv: nodeEnv as string, realProviderPermitted: realProviderPermitted as boolean })).toBe(expected);
  });

  it('T7-G1: a test model with the fact gets request-level cacheControl {type: ephemeral} — no lifetime key; one without gets none', async () => {
    const cached = answering();
    await drain(new ModelGatewayService(config({}, [CACHED, PLAIN]), () => cached.model).stream(base(CACHED, [{ role: 'user', content: 'hello' }])));
    expect(cached.seen[0]!.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    const plain = answering();
    await drain(new ModelGatewayService(config({}, [CACHED, PLAIN]), () => plain.model).stream(base(PLAIN, [{ role: 'user', content: 'hello' }])));
    expect(plain.seen[0]!.providerOptions ?? {}).toEqual({});
  });

  it('T7-S1: the gateway source never names a cache lifetime', () => {
    const src = readFileSync(join(__dirname, '../gateway/model-gateway.service.ts'), 'utf8');
    expect(src).not.toMatch(/\bttl\b|'1h'|'5m'/);
  });
});

describe('7b context budget runs FIRST in prepareStep', () => {
  it('over the limit: the OLDER tool result becomes the fixed stub, the newest is kept, the call/result pairing stays; the reservation is sized on what is sent', async () => {
    const m = answering();
    const infos: AiBeforeStepInfo[] = [];
    await drain(
      new ModelGatewayService(config({}, [SMALL]), () => m.model).stream(
        base(SMALL, historyWithToolResults(3_000), { maxOutputTokens: 100, beforeStep: async (i: AiBeforeStepInfo) => void infos.push(i) }),
      ),
    );
    expect(m.seen).toHaveLength(1);
    const sent = JSON.stringify(m.seen[0]!.prompt);
    expect(sent).toContain(AI_CONTEXT_OMITTED_MARKER);
    expect(sent).not.toContain('x'.repeat(100));
    expect(sent).toContain('newest');
    expect(sent).toContain('c1'); // the older call and its (stubbed) result are both still there
    expect(infos[0]!.contextLimitTokens).toBeGreaterThan(0);
    expect(infos[0]!.maxInputTokens).toBeLessThan(2_048 + 1_000);
  });

  it('nothing left to trim: refused as context_full BEFORE any request is sent (no reservation either)', async () => {
    const m = answering();
    const refusals: AiStepRefusedError[] = [];
    const beforeStep = jest.fn(async () => undefined);
    await drain(
      new ModelGatewayService(config({}, [SMALL]), () => m.model).stream(
        base(SMALL, [{ role: 'user', content: 'y'.repeat(5_000) }], { maxOutputTokens: 100, beforeStep, onRefused: (e: AiStepRefusedError) => void refusals.push(e) }),
      ),
    );
    expect(m.seen).toHaveLength(0);
    expect(beforeStep).not.toHaveBeenCalled();
    expect(refusals.map((r) => r.reason)).toEqual(['context_full']);
  });

  it('within the limit nothing changes: the request carries the messages unchanged', async () => {
    const m = answering();
    await drain(new ModelGatewayService(config({}, [PLAIN]), () => m.model).stream(base(PLAIN, historyWithToolResults(3_000))));
    expect(JSON.stringify(m.seen[0]!.prompt)).toContain('x'.repeat(3_000));
    expect(JSON.stringify(m.seen[0]!.prompt)).not.toContain(AI_CONTEXT_OMITTED_MARKER);
  });
});
