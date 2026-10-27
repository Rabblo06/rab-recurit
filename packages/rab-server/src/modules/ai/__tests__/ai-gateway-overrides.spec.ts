/**
 * GW-1 per-call overrides and the CD-1 level effort at the gateway, with NO network: in-process `MockLanguageModelV3`
 * scripted models only. An override can only LOWER a platform bound; an unverified effort is refused before any model
 * object is built.
 */
jest.mock('ai', () => {
  const actual = jest.requireActual('ai');
  return { ...actual, streamText: jest.fn((options: unknown) => actual.streamText(options)) };
});

import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { simulateReadableStream, streamText, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';

import { AiRuntimeDatabaseFacts } from '../../../engine/core-modules/ai/ai-readiness';
import { AI_HAIKU_MODEL_ID, AiCatalogueModel, catalogueEntry } from '../../../engine/core-modules/ai/models/catalog';
import { EnvironmentService } from '../../../engine/core-modules/environment/environment.service';
import { TEST_MOCK_MODEL_ID, TEST_MODEL_CATALOGUE } from '../../../__tests__/support/ai/test-catalogue';
import { AiModelNotConfiguredError, ModelGatewayService } from '../gateway/model-gateway.service';
import { providerCallOptions } from '../gateway/provider-factory';
import { AiConfigService } from '../services/ai-config.service';

const CANARY = 'sk-ant-canary-'.padEnd(48, 'Z');
const DEV_DB: AiRuntimeDatabaseFacts = { runtimeEnvironment: 'development', classification: 'LOCAL' };
const streamTextMock = streamText as unknown as jest.Mock;

function config(values: Record<string, unknown>, db: AiRuntimeDatabaseFacts | null = DEV_DB, testModels: readonly AiCatalogueModel[] | null = null): AiConfigService {
  const all: Record<string, unknown> = { NODE_ENV: 'development', AI_ENABLED: true, AI_MAX_OUTPUT_TOKENS: 1500, AI_MAX_STEPS: 8, AI_ORG_DAILY_TOKEN_BUDGET: 200_000, AI_TURN_TIMEOUT_SECONDS: 30, AI_DAILY_BUDGET_USD: 2, AI_DEV_ALLOW_REAL_PROVIDERS: false, ...values };
  const env = { get: (key: string) => all[key] } as unknown as EnvironmentService;
  const c = new AiConfigService(env, testModels);
  jest.spyOn(c, 'runtimeDatabase').mockReturnValue(db);
  return c;
}
const REAL_DEV = { ANTHROPIC_API_KEY: CANARY, AI_DEV_ALLOW_REAL_PROVIDERS: true };
const mockConfig = () => config({ NODE_ENV: 'test' }, null, TEST_MODEL_CATALOGUE);
const HAIKU = () => catalogueEntry(AI_HAIKU_MODEL_ID)!;
const TEST_MODEL = () => TEST_MODEL_CATALOGUE.find((m) => m.id === TEST_MOCK_MODEL_ID)!;

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } };
const textStep: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'ok' },
  { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
];
const toolStep: LanguageModelV3StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call_1', toolName: 'ping', input: '{}' },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
];
/** A model that ALWAYS asks for another tool call, so only the step cap ends the loop. */
function looping() {
  const seen: LanguageModelV3CallOptions[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (o: LanguageModelV3CallOptions) => {
      seen.push(o);
      return { stream: simulateReadableStream({ chunks: toolStep, chunkDelayInMs: null, initialDelayInMs: null }) };
    },
  });
  return { model: model as unknown as LanguageModelV3, seen };
}
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
  for await (const part of result.fullStream) void part;
}
const { z } = jest.requireActual('zod') as typeof import('zod');
const ping = { ping: tool({ description: 'Ping.', inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
const input = (model: AiCatalogueModel, extra: Record<string, unknown> = {}) => ({
  model,
  system: 'You are a test.',
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: {},
  abortSignal: new AbortController().signal,
  realProviderPermitted: true,
  ...extra,
});

beforeEach(() => streamTextMock.mockClear());

describe('GW-1 per-call overrides only lower the platform bounds', () => {
  it('maxOutputTokens and stepTimeoutMs below the bound are used; above it they are clamped to the bound', async () => {
    const g = new ModelGatewayService(mockConfig(), () => answering().model);
    await drain(g.stream(input(TEST_MODEL(), { maxOutputTokens: 32, stepTimeoutMs: 20_000 })));
    await drain(g.stream(input(TEST_MODEL(), { maxOutputTokens: 1_000_000, stepTimeoutMs: 3_600_000 })));
    await drain(g.stream(input(TEST_MODEL())));
    const [low, high, none] = streamTextMock.mock.calls.map(([o]) => o);
    expect([low.maxOutputTokens, low.timeout]).toEqual([32, { stepMs: 20_000 }]);
    // AI_MAX_OUTPUT_TOKENS (1500) is below the test catalogue's 128k ceiling; the step timeout bound is 60 s.
    expect([high.maxOutputTokens, high.timeout]).toEqual([1500, { stepMs: 60_000 }]);
    expect([none.maxOutputTokens, none.timeout]).toEqual([1500, { stepMs: 60_000 }]);
  });

  it('maxSteps: 1 stops after one model call; a larger value never exceeds AI_MAX_STEPS', async () => {
    const one = looping();
    await drain(new ModelGatewayService(mockConfig(), () => one.model).stream(input(TEST_MODEL(), { tools: ping, maxSteps: 1 })));
    expect(one.seen).toHaveLength(1);
    const many = looping();
    await drain(new ModelGatewayService(config({ NODE_ENV: 'test', AI_MAX_STEPS: 3 }, null, TEST_MODEL_CATALOGUE), () => many.model).stream(input(TEST_MODEL(), { tools: ping, maxSteps: 50 })));
    expect(many.seen).toHaveLength(3);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '10' as unknown as number])('an override of %p is refused before any model is built (never ignored)', (bad) => {
    for (const key of ['maxOutputTokens', 'maxSteps', 'stepTimeoutMs']) {
      const factory = jest.fn(() => answering().model);
      expect(() => new ModelGatewayService(mockConfig(), factory).stream(input(TEST_MODEL(), { [key]: bad }))).toThrow(AiModelNotConfiguredError);
      expect(factory).not.toHaveBeenCalled();
    }
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});

describe('CD-1: the level effort reaches the provider only when it is VERIFIED for the model', () => {
  it('Haiku at `low` (verified): providerOptions carry anthropic.effort low, exactly as Phase 1', async () => {
    const real = answering();
    await drain(new ModelGatewayService(config(REAL_DEV), () => real.model).stream(input(HAIKU(), { effort: 'low', realRequestGuard: async () => undefined })));
    expect(streamTextMock.mock.calls[0]![0].providerOptions).toEqual({ anthropic: { effort: 'low', cacheControl: { type: 'ephemeral' } } });
    expect(real.seen[0]!.providerOptions).toEqual({ anthropic: { effort: 'low', cacheControl: { type: 'ephemeral' } } });
  });

  it.each(['medium', 'high'] as const)('Haiku at `%s` (NOT verified) is refused before any model is built', (effort) => {
    const factory = jest.fn(() => answering().model);
    expect(() => new ModelGatewayService(config(REAL_DEV), factory).stream(input(HAIKU(), { effort, realRequestGuard: async () => undefined }))).toThrow(AiModelNotConfiguredError);
    expect(factory).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('an in-process test model accepts every effort and gets no provider options (it never leaves the process)', async () => {
    await drain(new ModelGatewayService(mockConfig(), () => answering().model).stream(input(TEST_MODEL(), { effort: 'high' })));
    expect(streamTextMock.mock.calls[0]![0].providerOptions).toBeUndefined();
  });

  it('providerCallOptions copies the frozen catalogue options and never mutates them', () => {
    const before = JSON.stringify(HAIKU().providerOptions);
    const out = providerCallOptions(HAIKU(), 'medium');
    expect(out).toEqual({ anthropic: { effort: 'medium' } });
    out!.anthropic!.effort = 'tampered';
    expect(JSON.stringify(HAIKU().providerOptions)).toBe(before);
    expect(providerCallOptions(HAIKU())).toEqual({ anthropic: { effort: 'low' } });
    expect(providerCallOptions(TEST_MODEL(), 'high')).toBeUndefined();
  });
});

describe('CD-1: the level cap bounds the turn reservation', () => {
  it('levelOutputTokens takes the lowest of level, catalogue and AI_MAX_OUTPUT_TOKENS; the reservation follows it', () => {
    const c = config({ AI_MAX_OUTPUT_TOKENS: 4000, AI_MAX_STEPS: 8 });
    expect(c.levelOutputTokens(HAIKU(), 1500)).toBe(1500);
    expect(c.levelOutputTokens(HAIKU(), 16_000)).toBe(Math.min(HAIKU().maxOutputTokens, 4000));
    expect(c.turnTokenReservationFor(1500)).toBeLessThan(c.turnTokenReservation);
    // Never above the platform bound, whatever is asked.
    expect(c.turnTokenReservationFor(1_000_000)).toBe(c.turnTokenReservation);
  });
});
